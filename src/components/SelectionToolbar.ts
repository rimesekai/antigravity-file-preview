import { attachLiquidGlass, refreshLiquidGlass } from '../services/liquidGlass';
import { copyTextToClipboard } from '../utils/clipboard';
import { onLocaleChange, tr } from '../utils/i18n';
import { createIcon } from '../utils/icons';

/**
 * 悬浮选区工具条初始化配置。
 */
export interface SelectionToolbarOptions {
  hostEl: HTMLElement;
  getSelectionRoot: () => HTMLElement | null;
  isActive: () => boolean;
  onCopy?: (text: string) => Promise<boolean> | boolean;
  onCopyFeedback?: (ok: boolean, text: string) => void;
}

/**
 * 悬浮选区工具条对外控制句柄。
 */
export interface SelectionToolbarController {
  refresh: () => void;
  hide: () => void;
  showSentMark: (label?: string) => void;
  clearSentMark: () => void;
  getSelectedText: () => string;
  destroy: () => void;
}

interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

const EDGE_MARGIN_PX = 8;
const SELECTION_GAP_PX = 8;
const SENT_BADGE_GAP_PX = 6;
const COPY_FEEDBACK_MS = 1400;
const SENT_MARK_DURATION_MS = 3200;
const MAX_SENT_RECTS = 160;

function getDefaultSentLabel(): string {
  return tr('✓ 已复制选中文字', '✓ Selection copied');
}

/**
 * 统计选中文本的可见字数（忽略空白折行干扰，并正确计算 Unicode 代理对）。
 */
function countSelectionChars(text: string): number {
  const compact = text.replace(/\s+/g, '');
  return Array.from(compact || text).length;
}

/**
 * 判断两个 Range 是否指向同一选区起止位置。
 */
function isSameRange(a: Range, b: Range): boolean {
  try {
    return (
      a.compareBoundaryPoints(Range.START_TO_START, b) === 0 &&
      a.compareBoundaryPoints(Range.END_TO_END, b) === 0
    );
  } catch {
    return false;
  }
}

/**
 * 判断节点是否位于有效预览内容根元素内，且不属于工具条、高亮层或可编辑表单控件。
 */
function isEligibleSelectionNode(node: Node | null, root: HTMLElement): boolean {
  if (!node || !root.contains(node)) {
    return false;
  }

  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!el) {
    return false;
  }

  if (el.closest('.fp-selection-bar, .fp-sent-highlight-layer, input, textarea, select')) {
    return false;
  }

  const editableHost = el.closest('[contenteditable]');
  if (editableHost) {
    const attr = editableHost.getAttribute('contenteditable');
    if (attr !== 'false') {
      return false;
    }
  }

  return true;
}

/**
 * 读取 Range 的有效屏幕包围矩形；若 getBoundingClientRect 为空则回退遍历 getClientRects。
 */
function resolveRangeBoundingRect(range: Range): RectLike | null {
  const bounding = range.getBoundingClientRect();
  if (bounding && (bounding.width > 0 || bounding.height > 0)) {
    return bounding;
  }

  const rects = range.getClientRects();
  let minLeft = Infinity;
  let minTop = Infinity;
  let maxRight = -Infinity;
  let maxBottom = -Infinity;
  let found = false;

  for (let i = 0; i < rects.length; i++) {
    const item = rects[i];
    if (!item || (item.width <= 0 && item.height <= 0)) {
      continue;
    }
    found = true;
    minLeft = Math.min(minLeft, item.left);
    minTop = Math.min(minTop, item.top);
    maxRight = Math.max(maxRight, item.right);
    maxBottom = Math.max(maxBottom, item.bottom);
  }

  if (!found) {
    return null;
  }

  return {
    left: minLeft,
    top: minTop,
    right: maxRight,
    bottom: maxBottom,
    width: Math.max(0, maxRight - minLeft),
    height: Math.max(0, maxBottom - minTop),
  };
}

/**
 * 创建并挂载悬浮选区工具条与选区视觉追踪层，用于在划词后展示已选字数提示及一键复制。
 */
export function createSelectionToolbar(
  options: SelectionToolbarOptions,
): SelectionToolbarController {
  const { hostEl } = options;

  // 已复制选区高亮追踪层（纯视觉提示，不拦截任何鼠标/选区交互）
  const highlightLayerEl = document.createElement('div');
  highlightLayerEl.className = 'fp-sent-highlight-layer';
  highlightLayerEl.setAttribute('aria-hidden', 'true');
  highlightLayerEl.hidden = true;
  hostEl.appendChild(highlightLayerEl);

  const barEl = document.createElement('div');
  barEl.className = 'fp-selection-bar';
  barEl.setAttribute('role', 'toolbar');
  barEl.hidden = true;

  const metaEl = document.createElement('span');
  metaEl.className = 'fp-sel-meta fc-tabular';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'fp-sel-btn fp-sel-btn-primary fp-sel-btn-copy';
  const copyIcon = createIcon('copy', 13);
  const checkIcon = createIcon('check', 13, 2.2);
  checkIcon.style.display = 'none';
  const copyLabelEl = document.createElement('span');
  copyBtn.append(copyIcon, checkIcon, copyLabelEl);

  barEl.append(metaEl, copyBtn);
  hostEl.appendChild(barEl);
  const detachBarGlass = attachLiquidGlass(barEl, 'regular');

  let destroyed = false;
  let isCopying = false;
  let rafId = 0;
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
  let sentClearTimer: ReturnType<typeof setTimeout> | null = null;
  let sentRange: Range | null = null;
  let sentLabel = getDefaultSentLabel();
  let customSentLabel = false;
  let pendingCopyRange: Range | null = null;

  const setCopyVisualState = (copied: boolean): void => {
    copyIcon.style.display = copied ? 'none' : '';
    checkIcon.style.display = copied ? '' : 'none';
    copyBtn.classList.toggle('is-copied', copied);
    copyLabelEl.textContent = copied ? tr('已复制', 'Copied') : tr('复制', 'Copy');
  };

  const applyLocaleText = (): void => {
    barEl.setAttribute('aria-label', tr('选中文本操作', 'Selected text actions'));
    metaEl.title = tr(
      '支持 Ctrl+C 或点击按钮复制选中文字',
      'Press Ctrl+C or click Copy to copy selected text',
    );
    copyBtn.title = tr('复制选中文字到剪贴板', 'Copy selected text to clipboard');
    setCopyVisualState(copyResetTimer !== null);
    if (!customSentLabel) {
      sentLabel = getDefaultSentLabel();
    }
  };

  applyLocaleText();

  const readValidSelection = (): { text: string; range: Range } | null => {
    if (destroyed || !options.isActive()) {
      return null;
    }

    const root = options.getSelectionRoot();
    if (!root) {
      return null;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    if (
      !isEligibleSelectionNode(selection.anchorNode, root) ||
      !isEligibleSelectionNode(selection.focusNode, root)
    ) {
      return null;
    }

    const text = selection.toString().replace(/\u200B/g, '').trim();
    if (!text) {
      return null;
    }

    const range = selection.getRangeAt(0);
    return { text, range };
  };

  const hide = (): void => {
    barEl.hidden = true;
    barEl.style.visibility = '';
  };

  const clearSentMark = (): void => {
    if (sentClearTimer !== null) {
      clearTimeout(sentClearTimer);
      sentClearTimer = null;
    }
    sentRange = null;
    highlightLayerEl.hidden = true;
    highlightLayerEl.replaceChildren();
  };

  const renderSentMark = (): void => {
    if (destroyed || !sentRange) {
      return;
    }
    if (!options.isActive()) {
      clearSentMark();
      return;
    }

    const root = options.getSelectionRoot();
    if (
      !root ||
      !sentRange.startContainer.isConnected ||
      !sentRange.endContainer.isConnected ||
      !root.contains(sentRange.startContainer) ||
      !root.contains(sentRange.endContainer)
    ) {
      clearSentMark();
      return;
    }

    const hostRect = hostEl.getBoundingClientRect();
    if (hostRect.width <= 0 || hostRect.height <= 0) {
      highlightLayerEl.hidden = true;
      highlightLayerEl.replaceChildren();
      return;
    }

    const rawRects = sentRange.getClientRects();
    const visibleRects: RectLike[] = [];
    const seenKeys = new Set<string>();

    for (let i = 0; i < rawRects.length; i++) {
      const item = rawRects[i];
      if (!item || item.width <= 0.5 || item.height <= 0.5) {
        continue;
      }

      // 将高亮框裁剪到宿主可视区边界内，完全滚出可视区时跳过
      const left = Math.max(item.left, hostRect.left) - hostRect.left;
      const top = Math.max(item.top, hostRect.top) - hostRect.top;
      const right = Math.min(item.right, hostRect.right) - hostRect.left;
      const bottom = Math.min(item.bottom, hostRect.bottom) - hostRect.top;
      const width = right - left;
      const height = bottom - top;

      if (width <= 0.5 || height <= 0.5) {
        continue;
      }

      const dedupeKey = `${Math.round(left)}:${Math.round(top)}:${Math.round(width)}:${Math.round(height)}`;
      if (seenKeys.has(dedupeKey)) {
        continue;
      }
      seenKeys.add(dedupeKey);

      visibleRects.push({ left, top, right, bottom, width, height });
      if (visibleRects.length >= MAX_SENT_RECTS) {
        break;
      }
    }

    if (visibleRects.length === 0) {
      highlightLayerEl.hidden = true;
      highlightLayerEl.replaceChildren();
      return;
    }

    const fragment = document.createDocumentFragment();
    let minLeft = Infinity;
    let minTop = Infinity;
    let maxRight = -Infinity;
    let maxBottom = -Infinity;

    for (const rect of visibleRects) {
      minLeft = Math.min(minLeft, rect.left);
      minTop = Math.min(minTop, rect.top);
      maxRight = Math.max(maxRight, rect.right);
      maxBottom = Math.max(maxBottom, rect.bottom);

      const rectEl = document.createElement('div');
      rectEl.className = 'fp-sent-rect';
      rectEl.style.left = `${Math.round(rect.left)}px`;
      rectEl.style.top = `${Math.round(rect.top)}px`;
      rectEl.style.width = `${Math.max(1, Math.round(rect.width))}px`;
      rectEl.style.height = `${Math.max(1, Math.round(rect.height))}px`;
      fragment.appendChild(rectEl);
    }

    const badgeEl = document.createElement('div');
    badgeEl.className = 'fp-sent-badge';
    badgeEl.textContent = sentLabel;
    badgeEl.style.visibility = 'hidden';
    fragment.appendChild(badgeEl);

    highlightLayerEl.replaceChildren(fragment);
    highlightLayerEl.hidden = false;

    const badgeWidth = badgeEl.offsetWidth || 152;
    const badgeHeight = badgeEl.offsetHeight || 24;

    let badgeTop = minTop - badgeHeight - SENT_BADGE_GAP_PX;
    if (badgeTop < EDGE_MARGIN_PX) {
      badgeTop = maxBottom + SENT_BADGE_GAP_PX;
    }
    const maxBadgeTop = Math.max(EDGE_MARGIN_PX, hostRect.height - badgeHeight - EDGE_MARGIN_PX);
    badgeTop = Math.min(Math.max(badgeTop, EDGE_MARGIN_PX), maxBadgeTop);

    const centerX = (minLeft + maxRight) / 2;
    let badgeLeft = centerX - badgeWidth / 2;
    const maxBadgeLeft = Math.max(EDGE_MARGIN_PX, hostRect.width - badgeWidth - EDGE_MARGIN_PX);
    badgeLeft = Math.min(Math.max(badgeLeft, EDGE_MARGIN_PX), maxBadgeLeft);

    badgeEl.style.left = `${Math.round(badgeLeft)}px`;
    badgeEl.style.top = `${Math.round(badgeTop)}px`;
    badgeEl.style.visibility = '';
  };

  const showSentMark = (label?: string): void => {
    if (destroyed) {
      return;
    }

    const sourceRange = pendingCopyRange ?? readValidSelection()?.range ?? sentRange;
    if (!sourceRange) {
      return;
    }

    sentRange = sourceRange.cloneRange();
    customSentLabel = Boolean(label && label.trim());
    sentLabel = customSentLabel ? label!.trim() : getDefaultSentLabel();

    if (sentClearTimer !== null) {
      clearTimeout(sentClearTimer);
    }
    sentClearTimer = setTimeout(() => {
      sentClearTimer = null;
      clearSentMark();
    }, SENT_MARK_DURATION_MS);

    renderSentMark();
  };

  const refresh = (): void => {
    if (destroyed) {
      return;
    }

    const valid = readValidSelection();
    if (!valid) {
      hide();
      return;
    }

    if (sentRange) {
      // 仍处于刚发送同一段选区的追踪期内时，避免滚动或重排把悬浮操作条重新盖到提示胶囊上
      if (isSameRange(valid.range, sentRange)) {
        hide();
        return;
      }
      clearSentMark();
    }

    const rect = resolveRangeBoundingRect(valid.range);
    const hostRect = hostEl.getBoundingClientRect();
    if (!rect || hostRect.width <= 0 || hostRect.height <= 0) {
      hide();
      return;
    }

    // 选区完全滚出宿主可视区域时自动隐藏
    const outsideViewport =
      rect.bottom <= hostRect.top ||
      rect.top >= hostRect.bottom ||
      rect.right <= hostRect.left ||
      rect.left >= hostRect.right;
    if (outsideViewport) {
      hide();
      return;
    }

    const charCount = countSelectionChars(valid.text);
    metaEl.textContent = tr(`已选 ${charCount} 字`, `${charCount} chars`);

    // 先以不可见状态取消 hidden 以便测量实际渲染尺寸
    barEl.style.visibility = 'hidden';
    barEl.hidden = false;

    const barWidth = barEl.offsetWidth || 236;
    const barHeight = barEl.offsetHeight || 34;

    const relTop = rect.top - hostRect.top;
    const relBottom = rect.bottom - hostRect.top;
    const relCenterX = (rect.left + rect.right) / 2 - hostRect.left;

    // 优先放置在选区上方 8px；上方空间不足时放到选区下方 8px，并限制在可视区内部
    let top = relTop - barHeight - SELECTION_GAP_PX;
    if (top < EDGE_MARGIN_PX) {
      top = relBottom + SELECTION_GAP_PX;
    }
    const maxTop = Math.max(EDGE_MARGIN_PX, hostRect.height - barHeight - EDGE_MARGIN_PX);
    top = Math.min(Math.max(top, EDGE_MARGIN_PX), maxTop);

    // 水平居中于选区并夹紧到宿主容器左右边界内（留出 8px 边距）
    let left = relCenterX - barWidth / 2;
    const maxLeft = Math.max(EDGE_MARGIN_PX, hostRect.width - barWidth - EDGE_MARGIN_PX);
    left = Math.min(Math.max(left, EDGE_MARGIN_PX), maxLeft);

    barEl.style.left = `${Math.round(left)}px`;
    barEl.style.top = `${Math.round(top)}px`;
    barEl.style.visibility = '';
    refreshLiquidGlass(barEl);
  };

  const scheduleRefresh = (): void => {
    if (destroyed || rafId !== 0) {
      return;
    }
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (sentRange) {
        renderSentMark();
      }
      refresh();
    });
  };

  const resetCopyLabel = (): void => {
    if (copyResetTimer !== null) {
      clearTimeout(copyResetTimer);
      copyResetTimer = null;
    }
    setCopyVisualState(false);
  };

  // 阻止鼠标按下工具条时清除文档选区或触发宿主 mousedown 隐藏逻辑
  const handleBarMouseDown = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleCopyClick = async (): Promise<void> => {
    if (destroyed || isCopying) {
      return;
    }
    const valid = readValidSelection();
    if (!valid) {
      hide();
      return;
    }

    pendingCopyRange = valid.range.cloneRange();
    isCopying = true;
    copyBtn.disabled = true;
    let ok = false;
    try {
      ok = options.onCopy
        ? Boolean(await options.onCopy(valid.text))
        : await copyTextToClipboard(valid.text);
    } catch {
      ok = false;
    } finally {
      isCopying = false;
      if (!destroyed) {
        copyBtn.disabled = false;
      }
    }

    if (destroyed) {
      pendingCopyRange = null;
      return;
    }

    if (ok) {
      resetCopyLabel();
      setCopyVisualState(true);
      copyResetTimer = setTimeout(() => {
        copyResetTimer = null;
        if (!destroyed) {
          setCopyVisualState(false);
        }
      }, COPY_FEEDBACK_MS);
      showSentMark();
      hide();
    }
    pendingCopyRange = null;
    options.onCopyFeedback?.(ok, valid.text);
  };

  const handleSelectionChange = (): void => {
    scheduleRefresh();
  };

  const handleKeyUp = (): void => {
    if (sentRange) {
      const valid = readValidSelection();
      if (!valid || !isSameRange(valid.range, sentRange)) {
        clearSentMark();
      }
    }
    scheduleRefresh();
  };

  const handleHostMouseDown = (): void => {
    hide();
    clearSentMark();
  };

  const handleHostMouseUp = (): void => {
    scheduleRefresh();
  };

  const handleHostScroll = (): void => {
    scheduleRefresh();
  };

  const handleWindowResize = (): void => {
    scheduleRefresh();
  };

  barEl.addEventListener('mousedown', handleBarMouseDown);
  copyBtn.addEventListener('click', handleCopyClick);

  document.addEventListener('selectionchange', handleSelectionChange);
  document.addEventListener('keyup', handleKeyUp);
  hostEl.addEventListener('mousedown', handleHostMouseDown);
  hostEl.addEventListener('mouseup', handleHostMouseUp);
  hostEl.addEventListener('scroll', handleHostScroll, { capture: true, passive: true });
  window.addEventListener('resize', handleWindowResize);
  const stopLocaleSync = onLocaleChange(() => {
    applyLocaleText();
    if (sentRange) {
      renderSentMark();
    }
    if (!barEl.hidden) {
      refresh();
    }
  });

  return {
    refresh,
    hide,
    showSentMark,
    clearSentMark,
    getSelectedText: (): string => readValidSelection()?.text ?? '',
    destroy: (): void => {
      if (destroyed) {
        return;
      }
      destroyed = true;
      stopLocaleSync();
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      resetCopyLabel();
      clearSentMark();

      barEl.removeEventListener('mousedown', handleBarMouseDown);
      copyBtn.removeEventListener('click', handleCopyClick);

      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('keyup', handleKeyUp);
      hostEl.removeEventListener('mousedown', handleHostMouseDown);
      hostEl.removeEventListener('mouseup', handleHostMouseUp);
      hostEl.removeEventListener('scroll', handleHostScroll, { capture: true });
      window.removeEventListener('resize', handleWindowResize);

      detachBarGlass();
      barEl.remove();
      highlightLayerEl.remove();
    },
  };
}
