import {
  type AudioMountInfo,
  LARGE_PDF_THRESHOLD_BYTES,
  type PreviewRenderer,
  type PreviewStateInfo,
} from '../types/preview';
import { onLocaleChange, tr } from '../utils/i18n';
import { createIcon } from '../utils/icons';

function formatFileSize(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
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
 * 创建音频流式播放器（支持 MP3 / WAV / M4A / OGG / FLAC，基于 HTTP Range 206 按需分片播放）。
 */
export function createAudioRenderer(): PreviewRenderer {
  let container: HTMLElement | null = null;
  let rootEl: HTMLElement | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let artEl: HTMLElement | null = null;
  let titleEl: HTMLElement | null = null;
  let timeEl: HTMLElement | null = null;
  let metaGroupEl: HTMLElement | null = null;
  let errorEl: HTMLElement | null = null;
  let stateCb: ((info: PreviewStateInfo) => void) | null = null;
  let activeObjectUrl: string | null = null;
  let currentName = '';
  let currentExt = '';
  let currentSize: number | undefined;
  let playbackRate = 1;
  let loopEnabled = false;
  let stopLocaleSync: (() => void) | null = null;

  const emitState = () => {
    stateCb?.({
      kind: 'audio',
      fileSize: currentSize,
    });
  };

  const revokeObjectUrl = () => {
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }
  };

  const updateTimeDisplay = () => {
    if (!timeEl || !audioEl) return;
    const current = Number.isFinite(audioEl.currentTime) ? audioEl.currentTime : 0;
    const duration = Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : 0;
    timeEl.textContent = duration > 0
      ? `${formatDuration(current)} / ${formatDuration(duration)}`
      : '--:-- / --:--';
  };

  const updateMetaText = () => {
    if (!metaGroupEl) return;
    const parts: string[] = [];
    if (audioEl && Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
      parts.push(tr(`时长 ${formatDuration(audioEl.duration)}`, `Duration ${formatDuration(audioEl.duration)}`));
    }
    const sizeText = formatFileSize(currentSize);
    if (sizeText) {
      parts.push(tr(`体积 ${sizeText}`, `Size ${sizeText}`));
    }
    if (currentExt) {
      parts.push(currentExt.replace(/^\./, '').toUpperCase());
    }
    if (currentSize && currentSize > LARGE_PDF_THRESHOLD_BYTES) {
      parts.push(tr('HTTP Range 分片流式播放', 'HTTP Range streaming'));
    }
    metaGroupEl.textContent = parts.join('  ·  ') || tr('正在加载音频元数据...', 'Loading audio metadata...');
  };

  return {
    mount(target: HTMLElement) {
      container = target;
      rootEl = document.createElement('div');
      rootEl.className = 'fp-audio-root';

      const infoBar = document.createElement('div');
      infoBar.className = 'fp-audio-infobar';

      metaGroupEl = document.createElement('div');
      metaGroupEl.className = 'fp-audio-meta-group fc-tabular';

      const controlsGroup = document.createElement('div');
      controlsGroup.className = 'fp-audio-controls-group';

      const rateLabel = document.createElement('span');

      const rateSelect = document.createElement('select');
      rateSelect.className = 'fp-audio-rate-select';
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
          if (audioEl) {
            audioEl.playbackRate = nextRate;
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
        if (audioEl) {
          audioEl.loop = loopEnabled;
        }
      });

      controlsGroup.append(rateLabel, rateSelect, loopBtn);
      infoBar.append(metaGroupEl, controlsGroup);

      const stage = document.createElement('div');
      stage.className = 'fp-audio-stage';

      const card = document.createElement('div');
      card.className = 'fp-audio-card fc-card';

      const header = document.createElement('div');
      header.className = 'fp-audio-header';

      artEl = document.createElement('div');
      artEl.className = 'fp-audio-art';
      artEl.setAttribute('aria-hidden', 'true');
      artEl.appendChild(createIcon('music', 24));

      const titleWrap = document.createElement('div');
      titleWrap.className = 'fp-audio-title-wrap';

      titleEl = document.createElement('div');
      titleEl.className = 'fp-audio-title';

      timeEl = document.createElement('div');
      timeEl.className = 'fp-audio-time fc-tabular';
      timeEl.textContent = '--:-- / --:--';

      titleWrap.append(titleEl, timeEl);
      header.append(artEl, titleWrap);

      audioEl = document.createElement('audio');
      audioEl.className = 'fp-audio-player';
      audioEl.controls = true;
      audioEl.preload = 'metadata';

      audioEl.addEventListener('loadedmetadata', () => {
        if (audioEl) {
          audioEl.playbackRate = playbackRate;
          audioEl.loop = loopEnabled;
        }
        if (errorEl) {
          errorEl.hidden = true;
        }
        updateTimeDisplay();
        updateMetaText();
      });
      audioEl.addEventListener('timeupdate', updateTimeDisplay);
      audioEl.addEventListener('play', () => artEl?.classList.add('is-playing'));
      audioEl.addEventListener('pause', () => artEl?.classList.remove('is-playing'));
      audioEl.addEventListener('ended', () => artEl?.classList.remove('is-playing'));
      audioEl.addEventListener('error', () => {
        artEl?.classList.remove('is-playing');
        if (errorEl && audioEl) {
          errorEl.hidden = false;
          audioEl.hidden = true;
        }
      });

      errorEl = document.createElement('div');
      errorEl.className = 'fp-audio-error';
      errorEl.hidden = true;

      const applyAudioLocale = () => {
        rateLabel.textContent = tr('倍速', 'Speed');
        rateSelect.setAttribute('aria-label', tr('音频播放倍速', 'Audio playback speed'));
        loopBtn.textContent = tr('循环', 'Loop');
        if (audioEl) {
          audioEl.setAttribute(
            'aria-label',
            currentName ? tr(`音频播放器：${currentName}`, `Audio player: ${currentName}`) : tr('音频播放器', 'Audio player'),
          );
        }
        if (errorEl) {
          errorEl.textContent = tr(
            '音频无法播放：可能是编码格式不受当前内置浏览器支持（建议使用 MP3、WAV、AAC/M4A、OGG 或 FLAC）。',
            'Unable to play audio: codec may not be supported by the built-in webview (MP3, WAV, M4A, OGG, or FLAC recommended).',
          );
        }
        updateMetaText();
      };
      applyAudioLocale();
      stopLocaleSync?.();
      stopLocaleSync = onLocaleChange(applyAudioLocale);

      card.append(header, audioEl, errorEl);
      stage.appendChild(card);
      rootEl.append(infoBar, stage);
      container.appendChild(rootEl);
    },

    async loadAudio(
      mountInfo: AudioMountInfo | null,
      objectUrl: string | null,
      meta: { name: string; path: string; ext: string; size?: number },
    ) {
      if (!audioEl || !rootEl) return;

      revokeObjectUrl();
      currentName = meta.name;
      currentExt = meta.ext;
      currentSize = mountInfo?.size ?? meta.size;
      if (objectUrl) {
        activeObjectUrl = objectUrl;
      }

      const src = mountInfo?.url ?? objectUrl;
      if (!src) {
        throw new Error(tr('缺少可用的音频流地址', 'Missing available audio stream URL.'));
      }

      if (titleEl) {
        titleEl.textContent = meta.name;
        titleEl.title = meta.path;
      }
      audioEl.setAttribute(
        'aria-label',
        tr(`音频播放器：${meta.name}`, `Audio player: ${meta.name}`),
      );
      artEl?.classList.remove('is-playing');
      if (errorEl) errorEl.hidden = true;
      audioEl.hidden = false;
      audioEl.src = src;
      audioEl.load();
      updateTimeDisplay();
      updateMetaText();
      emitState();
    },

    onStateChange(cb) {
      stateCb = cb;
    },

    destroy() {
      stopLocaleSync?.();
      stopLocaleSync = null;
      if (audioEl) {
        audioEl.pause();
        audioEl.removeAttribute('src');
        audioEl.load();
        audioEl = null;
      }
      revokeObjectUrl();
      if (rootEl) {
        rootEl.remove();
        rootEl = null;
      }
      artEl = null;
      titleEl = null;
      timeEl = null;
      metaGroupEl = null;
      errorEl = null;
      container = null;
      stateCb = null;
    },
  };
}
