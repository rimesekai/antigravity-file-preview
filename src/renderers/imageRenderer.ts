import {
  type ImageBackgroundMode,
  type ImageMountInfo,
  type PreviewRenderer,
  type PreviewStateInfo,
} from '../types/preview';
import { createDragPanner, type DragPannerController } from '../utils/dragPanner';
import { onLocaleChange, tr } from '../utils/i18n';
import {
  computeImageDisplayMetrics,
  MAX_IMAGE_ZOOM,
  MIN_IMAGE_ZOOM,
  normalizeImageRotation,
  type NormalizedRotation,
} from '../utils/imageLayout';

const IMAGE_ZOOM_STEPS = [0.1, 0.25, 0.5, 0.67, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0];

function formatFileSize(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  if (target.isContentEditable) {
    return true;
  }
  return Boolean(target.closest('[contenteditable="true"], [role="textbox"]'));
}

function stepImageZoom(current: number, direction: -1 | 1): number {
  const normalized = clamp(current || 1.0, MIN_IMAGE_ZOOM, MAX_IMAGE_ZOOM);
  if (direction > 0) {
    const next = IMAGE_ZOOM_STEPS.find((s) => s > normalized + 0.015);
    return next ?? clamp(Math.round(normalized * 1.25 * 100) / 100, MIN_IMAGE_ZOOM, MAX_IMAGE_ZOOM);
  }
  const reversed = [...IMAGE_ZOOM_STEPS].reverse();
  const prev = reversed.find((s) => s < normalized - 0.015);
  return prev ?? clamp(Math.round((normalized / 1.25) * 100) / 100, MIN_IMAGE_ZOOM, MAX_IMAGE_ZOOM);
}

function preloadImageElement(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.decoding = 'async';

    const cleanup = () => {
      probe.onload = null;
      probe.onerror = null;
    };

    probe.onload = () => {
      const width = probe.naturalWidth || 300;
      const height = probe.naturalHeight || 150;
      if (typeof probe.decode === 'function') {
        void probe.decode().catch(() => {
          // 部分图片在已触发 onload 后 decode 仍可能因离线环境抛错，降级直接放行展示
        }).finally(() => {
          cleanup();
          resolve({ width, height });
        });
        return;
      }
      cleanup();
      resolve({ width, height });
    };

    probe.onerror = () => {
      cleanup();
      reject(
        new Error(
          tr(
            '图片加载或解码失败，请确认文件未损坏且为有效的图片格式。',
            'Failed to load or decode image. Verify the file is a valid, uncorrupted image.',
          ),
        ),
      );
    };

    probe.src = src;
  });
}

/**
 * 创建高保真图片预览器（支持 JPG / JPEG / PNG）：
 * - 自适应视口与 10%–800% 缩放，支持 Ctrl/Cmd + 滚轮定点缩放与双击切换 1:1 / 适应；
 * - 放大溢出时支持鼠标左键/中键拖拽平移画布；
 * - 支持 90° 步进旋转（自动重算外接包围盒）与透明背景切换（棋盘格 / 浅色 / 深色）；
 * - 支持磁盘图片更新时无闪烁原地重载。
 */
export function createImageRenderer(): PreviewRenderer {
  let container: HTMLElement | null = null;
  let rootEl: HTMLElement | null = null;
  let infoBarEl: HTMLElement | null = null;
  let metaGroupEl: HTMLElement | null = null;
  let hintEl: HTMLElement | null = null;
  let viewportEl: HTMLElement | null = null;
  let stageEl: HTMLElement | null = null;
  let frameEl: HTMLElement | null = null;
  let imgEl: HTMLImageElement | null = null;

  let stateCb: ((info: PreviewStateInfo) => void) | null = null;
  let dragPanner: DragPannerController | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let stopLocaleSync: (() => void) | null = null;

  let destroyed = false;
  let loadGeneration = 0;
  let activeObjectUrl: string | null = null;
  let currentPath: string | null = null;
  let currentExt = '';
  let currentSize: number | undefined;

  let naturalWidth = 0;
  let naturalHeight = 0;
  let fitMode = true;
  let currentZoom = 1.0;
  let rotation: NormalizedRotation = 0;
  let bgMode: ImageBackgroundMode = 'checker';
  let lastBoxWidth = 0;
  let lastBoxHeight = 0;
  let lastViewportW = 0;
  let lastViewportH = 0;

  const revokeObjectUrl = (urlToRevoke?: string | null) => {
    const target = urlToRevoke ?? activeObjectUrl;
    if (target) {
      URL.revokeObjectURL(target);
      if (!urlToRevoke || urlToRevoke === activeObjectUrl) {
        activeObjectUrl = null;
      }
    }
  };

  const emitState = () => {
    stateCb?.({
      kind: 'image',
      zoom: currentZoom,
      fitMode,
      rotation,
      imageWidth: naturalWidth || undefined,
      imageHeight: naturalHeight || undefined,
      imageBg: bgMode,
      fileSize: currentSize,
    });
  };

  const updateInfoText = () => {
    if (!metaGroupEl) return;
    const parts: string[] = [];
    if (naturalWidth > 0 && naturalHeight > 0) {
      parts.push(`${naturalWidth} × ${naturalHeight}`);
    }
    const sizeText = formatFileSize(currentSize);
    if (sizeText) {
      parts.push(tr(`体积 ${sizeText}`, `Size ${sizeText}`));
    }
    if (currentExt) {
      parts.push(currentExt.replace(/^\./, '').toUpperCase());
    }
    if (rotation !== 0) {
      parts.push(`${rotation}°`);
    }
    metaGroupEl.textContent = parts.join('  ·  ') || tr('正在加载图片...', 'Loading image...');
  };

  const applyBackdropMode = () => {
    if (!frameEl) return;
    frameEl.dataset.bg = bgMode;
  };

  const applyLayout = () => {
    if (!viewportEl || !frameEl || !imgEl || naturalWidth <= 0 || naturalHeight <= 0) {
      return;
    }

    const metrics = computeImageDisplayMetrics({
      naturalWidth,
      naturalHeight,
      rotation,
      viewportWidth: viewportEl.clientWidth,
      viewportHeight: viewportEl.clientHeight,
      paddingX: 32,
      paddingY: 32,
      fitMode,
      zoom: currentZoom,
    });

    currentZoom = metrics.scale;
    lastBoxWidth = metrics.rotatedWidth;
    lastBoxHeight = metrics.rotatedHeight;

    frameEl.style.width = `${metrics.rotatedWidth}px`;
    frameEl.style.height = `${metrics.rotatedHeight}px`;

    imgEl.style.width = `${metrics.boxWidth}px`;
    imgEl.style.height = `${metrics.boxHeight}px`;
    imgEl.style.transform = `translate(-50%, -50%) rotate(${metrics.rotation}deg)`;

    dragPanner?.syncState();
    updateInfoText();
  };

  const setZoomInternal = (zoom: number | 'fit', anchor?: { clientX: number; clientY: number }) => {
    if (!viewportEl || naturalWidth <= 0 || naturalHeight <= 0) return;

    const prevW = Math.max(1, lastBoxWidth);
    const prevH = Math.max(1, lastBoxHeight);
    let anchorRatioX = 0.5;
    let anchorRatioY = 0.5;
    let offsetInViewportX = viewportEl.clientWidth / 2;
    let offsetInViewportY = viewportEl.clientHeight / 2;

    if (anchor && frameEl) {
      const vpRect = viewportEl.getBoundingClientRect();
      const frameRect = frameEl.getBoundingClientRect();
      offsetInViewportX = anchor.clientX - vpRect.left;
      offsetInViewportY = anchor.clientY - vpRect.top;
      anchorRatioX = clamp((anchor.clientX - frameRect.left) / prevW, 0, 1);
      anchorRatioY = clamp((anchor.clientY - frameRect.top) / prevH, 0, 1);
    }

    if (zoom === 'fit') {
      fitMode = true;
    } else {
      fitMode = false;
      currentZoom = clamp(Math.round(zoom * 1000) / 1000, MIN_IMAGE_ZOOM, MAX_IMAGE_ZOOM);
    }

    applyLayout();

    if (anchor && !fitMode && frameEl) {
      const nextFrameRect = frameEl.getBoundingClientRect();
      const vpRect = viewportEl.getBoundingClientRect();
      const targetContentX = (nextFrameRect.left - vpRect.left + viewportEl.scrollLeft) + anchorRatioX * lastBoxWidth;
      const targetContentY = (nextFrameRect.top - vpRect.top + viewportEl.scrollTop) + anchorRatioY * lastBoxHeight;
      viewportEl.scrollLeft = Math.max(0, targetContentX - offsetInViewportX);
      viewportEl.scrollTop = Math.max(0, targetContentY - offsetInViewportY);
    }

    emitState();
  };

  const handleWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (naturalWidth <= 0 || naturalHeight <= 0) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const nextZoom = clamp(Math.round(currentZoom * factor * 100) / 100, MIN_IMAGE_ZOOM, MAX_IMAGE_ZOOM);
    setZoomInternal(nextZoom, { clientX: e.clientX, clientY: e.clientY });
  };

  const handleDblClick = (e: MouseEvent) => {
    if (naturalWidth <= 0 || naturalHeight <= 0) return;
    if (fitMode) {
      const target = currentZoom < 0.98 ? 1.0 : 2.0;
      setZoomInternal(target, { clientX: e.clientX, clientY: e.clientY });
      return;
    }
    setZoomInternal('fit');
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (destroyed || !rootEl || !rootEl.isConnected) return;
    if (rootEl.closest('[hidden]')) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditableTarget(e.target)) return;
    if (naturalWidth <= 0 || naturalHeight <= 0) return;

    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setZoomInternal(stepImageZoom(currentZoom, 1));
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      setZoomInternal(stepImageZoom(currentZoom, -1));
    } else if (e.key === '0') {
      e.preventDefault();
      setZoomInternal('fit');
    } else if (e.key === '1') {
      e.preventDefault();
      setZoomInternal(1.0);
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      rotation = normalizeImageRotation(rotation + (e.shiftKey ? -90 : 90));
      applyLayout();
      emitState();
    }
  };

  return {
    mount(target: HTMLElement) {
      destroyed = false;
      container = target;
      rootEl = document.createElement('div');
      rootEl.className = 'fp-image-root';

      infoBarEl = document.createElement('div');
      infoBarEl.className = 'fp-image-infobar';

      metaGroupEl = document.createElement('div');
      metaGroupEl.className = 'fp-image-meta-group fc-tabular';

      hintEl = document.createElement('div');
      hintEl.className = 'fp-image-hint fp-hide-xs';

      infoBarEl.append(metaGroupEl, hintEl);

      viewportEl = document.createElement('div');
      viewportEl.className = 'fp-image-viewport';

      stageEl = document.createElement('div');
      stageEl.className = 'fp-image-stage';

      frameEl = document.createElement('div');
      frameEl.className = 'fp-image-frame';
      frameEl.dataset.bg = bgMode;

      imgEl = document.createElement('img');
      imgEl.className = 'fp-image-el';
      imgEl.alt = tr('预览图片', 'Preview image');
      imgEl.decoding = 'async';
      imgEl.draggable = false;

      frameEl.appendChild(imgEl);
      stageEl.appendChild(frameEl);
      viewportEl.appendChild(stageEl);
      rootEl.append(infoBarEl, viewportEl);
      container.appendChild(rootEl);

      dragPanner = createDragPanner({
        getScrollContainer: () => viewportEl,
        isEnabled: () =>
          Boolean(
            viewportEl &&
              (viewportEl.scrollWidth > viewportEl.clientWidth + 1 ||
                viewportEl.scrollHeight > viewportEl.clientHeight + 1),
          ),
      });

      viewportEl.addEventListener('mousedown', dragPanner.handleMouseDown);
      viewportEl.addEventListener('mousemove', dragPanner.handleHoverMove);
      viewportEl.addEventListener('mouseleave', dragPanner.handleMouseLeave);
      viewportEl.addEventListener('click', dragPanner.handleClickCapture, true);
      viewportEl.addEventListener('wheel', handleWheel, { passive: false });
      frameEl.addEventListener('dblclick', handleDblClick);
      window.addEventListener('keydown', handleKeyDown);

      if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(() => {
          if (!viewportEl || destroyed) return;
          const w = viewportEl.clientWidth;
          const h = viewportEl.clientHeight;
          if (Math.abs(w - lastViewportW) < 1 && Math.abs(h - lastViewportH) < 1) {
            return;
          }
          lastViewportW = w;
          lastViewportH = h;
          if (naturalWidth > 0 && naturalHeight > 0) {
            if (fitMode) {
              applyLayout();
              emitState();
            } else {
              dragPanner?.syncState();
            }
          }
        });
        resizeObserver.observe(viewportEl);
      }

      const applyImageLocale = () => {
        if (hintEl) {
          hintEl.textContent = tr(
            'Ctrl+滚轮缩放 · 双击切换 1:1 · R 旋转',
            'Ctrl+Scroll zoom · Dblclick 1:1 · R rotate',
          );
        }
        updateInfoText();
      };
      applyImageLocale();
      stopLocaleSync?.();
      stopLocaleSync = onLocaleChange(applyImageLocale);
    },

    async loadImage(
      mountInfo: ImageMountInfo | null,
      objectUrl: string | null,
      meta: { name: string; path: string; ext: string; size?: number },
    ) {
      if (!imgEl || !rootEl || !viewportEl || destroyed) return;

      const gen = ++loadGeneration;
      const src = mountInfo?.url ?? objectUrl;
      if (!src) {
        throw new Error(tr('缺少可用的图片预览地址', 'Missing available image preview URL.'));
      }

      const prevObjectUrl = activeObjectUrl;
      const isReload = Boolean(currentPath && meta.path && currentPath === meta.path && imgEl.getAttribute('src'));
      const prevNaturalW = naturalWidth;
      const prevNaturalH = naturalHeight;
      const prevScrollLeft = viewportEl.scrollLeft;
      const prevScrollTop = viewportEl.scrollTop;

      const dims = await preloadImageElement(src);
      if (destroyed || gen !== loadGeneration || !imgEl || !viewportEl) {
        if (objectUrl && objectUrl !== prevObjectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
        return;
      }

      currentPath = meta.path;
      currentExt = meta.ext;
      currentSize = mountInfo?.size ?? meta.size;
      naturalWidth = dims.width;
      naturalHeight = dims.height;

      if (!isReload) {
        fitMode = true;
        rotation = 0;
      }

      imgEl.alt = meta.name || tr('预览图片', 'Preview image');
      imgEl.src = src;
      activeObjectUrl = objectUrl ?? null;

      if (prevObjectUrl && prevObjectUrl !== activeObjectUrl) {
        URL.revokeObjectURL(prevObjectUrl);
      }

      applyBackdropMode();
      applyLayout();

      if (isReload && prevNaturalW === naturalWidth && prevNaturalH === naturalHeight) {
        viewportEl.scrollLeft = prevScrollLeft;
        viewportEl.scrollTop = prevScrollTop;
      } else {
        viewportEl.scrollLeft = 0;
        viewportEl.scrollTop = 0;
      }

      emitState();
    },

    setZoom(zoom: number | 'fit') {
      setZoomInternal(zoom);
    },

    rotateImage(deltaDeg: number) {
      if (naturalWidth <= 0 || naturalHeight <= 0) return;
      rotation = normalizeImageRotation(rotation + deltaDeg);
      applyLayout();
      emitState();
    },

    setImageBackground(mode: ImageBackgroundMode) {
      bgMode = mode;
      applyBackdropMode();
      emitState();
    },

    onStateChange(cb) {
      stateCb = cb;
    },

    destroy() {
      destroyed = true;
      loadGeneration += 1;
      stopLocaleSync?.();
      stopLocaleSync = null;
      window.removeEventListener('keydown', handleKeyDown);
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (viewportEl && dragPanner) {
        viewportEl.removeEventListener('mousedown', dragPanner.handleMouseDown);
        viewportEl.removeEventListener('mousemove', dragPanner.handleHoverMove);
        viewportEl.removeEventListener('mouseleave', dragPanner.handleMouseLeave);
        viewportEl.removeEventListener('click', dragPanner.handleClickCapture, true);
      }
      if (viewportEl) {
        viewportEl.removeEventListener('wheel', handleWheel);
      }
      if (frameEl) {
        frameEl.removeEventListener('dblclick', handleDblClick);
      }
      dragPanner?.destroy();
      dragPanner = null;

      if (imgEl) {
        imgEl.removeAttribute('src');
        imgEl = null;
      }
      revokeObjectUrl();

      if (rootEl) {
        rootEl.remove();
        rootEl = null;
      }
      infoBarEl = null;
      metaGroupEl = null;
      hintEl = null;
      viewportEl = null;
      stageEl = null;
      frameEl = null;
      container = null;
      stateCb = null;
    },
  };
}
