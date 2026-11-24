import {
  LARGE_PDF_THRESHOLD_BYTES,
  type PreviewRenderer,
  type PreviewStateInfo,
  type VideoMountInfo,
} from '../types/preview';
import { onLocaleChange, tr } from '../utils/i18n';

function formatFileSize(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 创建 MP4 视频流式播放器（基于独立端口 HTTP Range 206 按需分片播放，支持 20MB 以上大视频）。
 */
export function createVideoRenderer(): PreviewRenderer {
  let container: HTMLElement | null = null;
  let rootEl: HTMLElement | null = null;
  let videoEl: HTMLVideoElement | null = null;
  let metaGroupEl: HTMLElement | null = null;
  let errorEl: HTMLElement | null = null;
  let stateCb: ((info: PreviewStateInfo) => void) | null = null;
  let activeObjectUrl: string | null = null;
  let currentSize: number | undefined;
  let playbackRate = 1;
  let loopEnabled = false;
  let stopLocaleSync: (() => void) | null = null;

  const emitState = () => {
    stateCb?.({
      kind: 'mp4',
      fileSize: currentSize,
    });
  };

  const revokeObjectUrl = () => {
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }
  };

  const updateMetaText = () => {
    if (!metaGroupEl) return;
    const parts: string[] = [];
    if (videoEl && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
      parts.push(`${videoEl.videoWidth} × ${videoEl.videoHeight}`);
    }
    if (videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
      parts.push(tr(`时长 ${formatDuration(videoEl.duration)}`, `Duration ${formatDuration(videoEl.duration)}`));
    }
    const sizeText = formatFileSize(currentSize);
    if (sizeText) {
      parts.push(tr(`体积 ${sizeText}`, `Size ${sizeText}`));
    }
    if (currentSize && currentSize > LARGE_PDF_THRESHOLD_BYTES) {
      parts.push(tr('HTTP Range 分片流式播放', 'HTTP Range streaming'));
    }
    metaGroupEl.textContent = parts.join('  ·  ') || tr('正在加载视频元数据...', 'Loading video metadata...');
  };

  return {
    mount(target: HTMLElement) {
      container = target;
      rootEl = document.createElement('div');
      rootEl.className = 'fp-video-root';

      const infoBar = document.createElement('div');
      infoBar.className = 'fp-video-infobar';

      metaGroupEl = document.createElement('div');
      metaGroupEl.className = 'fp-video-meta-group';

      const controlsGroup = document.createElement('div');
      controlsGroup.className = 'fp-video-controls-group';

      const rateLabel = document.createElement('span');

      const rateSelect = document.createElement('select');
      rateSelect.className = 'fp-video-rate-select';
      for (const rate of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
        const opt = document.createElement('option');
        opt.value = String(rate);
        opt.textContent = `${rate}x`;
        if (rate === 1) opt.selected = true;
        rateSelect.appendChild(opt);
      }
      rateSelect.addEventListener('change', () => {
        const nextRate = Number.parseFloat(rateSelect.value);
        if (Number.isFinite(nextRate)) {
          playbackRate = nextRate;
          if (videoEl) {
            videoEl.playbackRate = nextRate;
          }
        }
      });

      const loopBtn = document.createElement('button');
      loopBtn.type = 'button';
      loopBtn.className = 'fp-btn fp-btn-tonal fp-btn-compact';
      loopBtn.setAttribute('aria-pressed', String(loopEnabled));
      loopBtn.addEventListener('click', () => {
        loopEnabled = !loopEnabled;
        loopBtn.classList.toggle('is-active', loopEnabled);
        loopBtn.setAttribute('aria-pressed', String(loopEnabled));
        if (videoEl) {
          videoEl.loop = loopEnabled;
        }
      });

      controlsGroup.append(rateLabel, rateSelect, loopBtn);
      infoBar.append(metaGroupEl, controlsGroup);

      const stage = document.createElement('div');
      stage.className = 'fp-video-stage';

      videoEl = document.createElement('video');
      videoEl.className = 'fp-video-player';
      videoEl.controls = true;
      videoEl.preload = 'metadata';
      videoEl.playsInline = true;
      videoEl.addEventListener('loadedmetadata', () => {
        if (videoEl) {
          videoEl.playbackRate = playbackRate;
          videoEl.loop = loopEnabled;
        }
        if (errorEl) {
          errorEl.hidden = true;
        }
        updateMetaText();
      });
      videoEl.addEventListener('error', () => {
        if (errorEl && videoEl) {
          errorEl.hidden = false;
          videoEl.hidden = true;
        }
      });

      errorEl = document.createElement('div');
      errorEl.className = 'fp-video-error';
      errorEl.hidden = true;

      const applyVideoLocale = () => {
        rateLabel.textContent = tr('倍速', 'Speed');
        rateSelect.setAttribute('aria-label', tr('视频播放倍速', 'Playback speed'));
        loopBtn.textContent = tr('循环', 'Loop');
        if (errorEl) {
          errorEl.textContent = tr(
            '视频无法播放：可能是编码格式不受当前内置浏览器支持（建议使用 H.264/AAC 的 MP4 或 VP8/VP9 的 WebM）。',
            'Unable to play video: codec may not be supported by the built-in webview (H.264/AAC MP4 or VP8/VP9 WebM recommended).',
          );
        }
        updateMetaText();
      };
      applyVideoLocale();
      stopLocaleSync?.();
      stopLocaleSync = onLocaleChange(applyVideoLocale);

      stage.append(videoEl, errorEl);
      rootEl.append(infoBar, stage);
      container.appendChild(rootEl);
    },

    async loadVideo(
      mountInfo: VideoMountInfo | null,
      objectUrl: string | null,
      meta: { name: string; path: string; ext: string; size?: number },
    ) {
      if (!videoEl || !rootEl) return;

      revokeObjectUrl();
      currentSize = mountInfo?.size ?? meta.size;
      if (objectUrl) {
        activeObjectUrl = objectUrl;
      }

      const src = mountInfo?.url ?? objectUrl;
      if (!src) {
        throw new Error(tr('缺少可用的视频流地址', 'Missing available video stream URL.'));
      }

      if (errorEl) errorEl.hidden = true;
      videoEl.hidden = false;
      videoEl.src = src;
      videoEl.load();
      updateMetaText();
      emitState();
    },

    onStateChange(cb) {
      stateCb = cb;
    },

    destroy() {
      stopLocaleSync?.();
      stopLocaleSync = null;
      if (videoEl) {
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
        videoEl = null;
      }
      revokeObjectUrl();
      if (rootEl) {
        rootEl.remove();
        rootEl = null;
      }
      metaGroupEl = null;
      errorEl = null;
      container = null;
      stateCb = null;
    },
  };
}
