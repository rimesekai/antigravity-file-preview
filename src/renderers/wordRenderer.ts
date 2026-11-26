import { parseAsync, renderDocument, type Options as DocxPreviewOptions } from 'docx-preview';
import type {
  PreviewRenderer,
  PreviewStateInfo,
} from '../types/preview';
import {
  applyDocxCjkLayout,
  collectDocxCjkLayout,
  type DocxCjkLayoutContext,
} from '../utils/docxCjkLayout';
import {
  applyHeaderFooterFrameAlignment,
  collectDocxTabStops,
  preprocessDocxPageFields,
  recalculateDocxTabStops,
  resolveDocxPageFields,
} from '../utils/docxPageFields';
import {
  collectDocxPaginationMeta,
  normalizeDocxAutoLineHeight,
  paginateOverflowDocxSections,
  sanitizeDocxPageBackground,
  waitForDocxMediaReady,
  type DocxHeaderFooterTemplates,
} from '../utils/docxPaginator';
import { createDragPanner, type DragPannerController } from '../utils/dragPanner';
import {
  computeFitWidthLayout,
  measureScrollContainerBox,
  measureVerticalMargins,
} from '../utils/fitWidthLayout';
import { tr } from '../utils/i18n';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.0;
const MIN_FIT_ZOOM = 0.2;
const MAX_FIT_ZOOM = 1.0;
const FALLBACK_VIEWPORT_PADDING_X = 12;
const FALLBACK_SIZER_VERTICAL_MARGIN = 38;
const MAX_WORD_MATCHES = 2000;
const FAR_SECTION_JUMP = 4;
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
const BLOCK_CONTAINER_TAGS = new Set([
  'P',
  'DIV',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'ASIDE',
  'LI',
  'TD',
  'TH',
  'CAPTION',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'PRE',
  'TR',
]);

interface TextRunSlice {
  node: Text;
  start: number;
  end: number;
}

function getNearestBlockContainer(node: Node, boundary: HTMLElement): Element | null {
  let curr: Node | null = node.parentNode;
  while (curr && curr !== boundary) {
    if (curr instanceof Element && BLOCK_CONTAINER_TAGS.has(curr.tagName)) {
      return curr;
    }
    curr = curr.parentNode;
  }
  return boundary;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundZoom(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 规范化 docx-preview 生成的 MathML DOM：
 * docx-preview 会将 OMML 的 m:sup / m:sub / m:deg 映射为 <mn>，将 m:fName 映射为 <ms>，
 * 在 Chromium MathML Core 中，token 元素（<mn>/<ms>/<mo>/<mi>）内嵌子元素会导致垂直堆叠
 * （例如 10^-5 中的负号跑到 5 正上方）。此处将包含子元素的 token 容器替换为 <mrow>。
 */
function normalizeDocxMathMl(container: HTMLElement): void {
  const tokenElements = container.querySelectorAll('math mn, math ms, math mo, math mi');
  // 逆序遍历确保先替换内层再替换外层
  for (let i = tokenElements.length - 1; i >= 0; i -= 1) {
    const el = tokenElements[i];
    if (el.children.length === 0) continue;

    const mrow = document.createElementNS(MATHML_NS, 'mrow');
    for (const attr of Array.from(el.attributes)) {
      mrow.setAttribute(attr.name, attr.value);
    }
    while (el.firstChild) {
      mrow.appendChild(el.firstChild);
    }
    el.replaceWith(mrow);
  }
}

async function renderSyntheticHeaderFooterTemplates(
  doc: any,
  sectProps: any,
  docxOptions: Partial<DocxPreviewOptions>,
  stageEl: HTMLElement,
  cjkLayoutContext: DocxCjkLayoutContext,
): Promise<DocxHeaderFooterTemplates | null> {
  if (!doc?.documentPart) return null;

  const clonedStyles = Array.isArray(doc.stylesPart?.styles)
    ? doc.stylesPart.styles.map((st: any) => ({
        ...st,
        styles: Array.isArray(st.styles)
          ? st.styles.map((s: any) => ({ ...s, values: { ...s.values } }))
          : st.styles,
        paragraphProps: st.paragraphProps ? { ...st.paragraphProps } : st.paragraphProps,
        runProps: st.runProps ? { ...st.runProps } : st.runProps,
      }))
    : undefined;

  const syntheticDoc = Object.create(doc);
  syntheticDoc.themePart = null;
  syntheticDoc.fontTablePart = null;
  syntheticDoc.footnotesPart = null;
  syntheticDoc.endnotesPart = null;
  if (doc.stylesPart) {
    syntheticDoc.stylesPart = { ...doc.stylesPart, styles: clonedStyles };
  }
  syntheticDoc.documentPart = {
    ...doc.documentPart,
    body: {
      type: 'document',
      cssStyle: doc.documentPart?.body?.cssStyle ?? {},
      props: sectProps,
      children: [
        { type: 'paragraph', children: [{ type: 'run', children: [{ type: 'break', break: 'page' }] }] },
        { type: 'paragraph', children: [{ type: 'run', children: [{ type: 'break', break: 'page' }] }] },
        { type: 'paragraph', children: [] },
      ],
    },
  };

  const nodes = await renderDocument(syntheticDoc, {
    ...docxOptions,
    ignoreFonts: true,
    renderFootnotes: false,
    renderEndnotes: false,
    renderComments: false,
  });

  const tempHost = document.createElement('div');
  tempHost.style.position = 'absolute';
  tempHost.style.visibility = 'hidden';
  tempHost.style.pointerEvents = 'none';
  tempHost.style.left = '-99999px';
  tempHost.style.top = '0';
  for (const node of nodes) {
    tempHost.appendChild(node);
  }
  stageEl.appendChild(tempHost);

  try {
    applyDocxCjkLayout(tempHost, cjkLayoutContext);
    const wrapperSections = Array.from(
      tempHost.querySelectorAll<HTMLElement>('.docx-wrapper > section.docx'),
    );
    const sections =
      wrapperSections.length > 0
        ? wrapperSections
        : Array.from(tempHost.querySelectorAll<HTMLElement>('section.docx'));

    const extractPair = (sec?: HTMLElement) => {
      if (!sec) return undefined;
      const header = sec.querySelector<HTMLElement>(':scope > header');
      const footer = sec.querySelector<HTMLElement>(':scope > footer');
      return {
        header: header ? (header.cloneNode(true) as HTMLElement) : null,
        footer: footer ? (footer.cloneNode(true) as HTMLElement) : null,
      };
    };

    return {
      first: extractPair(sections[0]),
      even: extractPair(sections[1]),
      default: extractPair(sections[2]),
    };
  } finally {
    tempHost.remove();
  }
}

export function createWordRenderer(): PreviewRenderer {
  let rootEl: HTMLElement | null = null;
  let viewportEl: HTMLElement | null = null;
  let sizerEl: HTMLElement | null = null;
  let scaleLayerEl: HTMLElement | null = null;
  let stageEl: HTMLElement | null = null;

  let resizeObserver: ResizeObserver | null = null;
  let dragPanner: DragPannerController | null = null;
  let rafLayoutId: number | null = null;
  let rafScrollId: number | null = null;
  let loadGeneration = 0;
  let preparingGeneration = 0;
  let destroyed = false;

  let fitMode = true;
  let manualZoom = 1.0;
  let effectiveZoom = 1.0;
  let observedScrollbarWidth = 0;
  let lastAppliedWidth = -1;
  let lastAppliedHeight = -1;
  let lastAppliedScale = -1;
  let lastObservedViewportWidth = -1;
  let lastObservedViewportHeight = -1;
  let lastObservedScaleLayerWidth = -1;
  let lastObservedScaleLayerHeight = -1;
  let currentPage = 1;
  let totalPages = 0;
  let lastBuffer: ArrayBuffer | null = null;
  let lastMeta: { name: string; path: string; ext: string } | null = null;

  let searchQuery = '';
  let matchGroups: HTMLElement[][] = [];
  let activeMatchIndex = -1;

  const stateListeners = new Set<(info: PreviewStateInfo) => void>();

  function emitState(warning?: string): void {
    const info: PreviewStateInfo = {
      kind: 'word',
      page: totalPages > 0 ? currentPage : undefined,
      totalPages: totalPages > 0 ? totalPages : undefined,
      zoom: roundZoom(effectiveZoom),
      fitMode,
      searchMatches: matchGroups.length,
      activeMatch: activeMatchIndex >= 0 ? activeMatchIndex + 1 : 0,
      warning,
    };
    for (const cb of stateListeners) {
      try {
        cb(info);
      } catch (err) {
        console.error('[wordRenderer] state listener error:', err);
      }
    }
    dragPanner?.syncState();
  }

  function getPageSections(): HTMLElement[] {
    if (!stageEl) return [];
    return Array.from(stageEl.querySelectorAll<HTMLElement>('.docx-wrapper > section.docx'));
  }

  function updateLayout(): void {
    if (destroyed || !viewportEl || !sizerEl || !scaleLayerEl || !stageEl || preparingGeneration !== 0) return;

    viewportEl.classList.toggle('is-fit-mode', fitMode);

    const sections = getPageSections();
    const nextTotal = sections.length > 0 ? sections.length : stageEl.children.length > 0 ? 1 : 0;
    const totalChanged = nextTotal !== totalPages;
    totalPages = nextTotal;
    if (totalPages > 0) {
      currentPage = clamp(currentPage, 1, totalPages);
    }

    // Read untransformed layout dimensions from scaleLayerEl (not affected by CSS transform)
    const maxSectionWidth = sections.reduce((max, sec) => Math.max(max, sec.offsetWidth), 0);
    const rawWidth = Math.max(scaleLayerEl.offsetWidth, maxSectionWidth > 0 ? maxSectionWidth + 24 : 0);
    const rawHeight = scaleLayerEl.offsetHeight;

    if (rawWidth <= 0 || rawHeight <= 0) {
      if (totalChanged) emitState();
      dragPanner?.syncState();
      return;
    }

    const box = measureScrollContainerBox(viewportEl, FALLBACK_VIEWPORT_PADDING_X, 0);
    let nextScale = manualZoom;
    let scaledW = 0;
    let scaledH = 0;

    if (fitMode) {
      if (box.clientWidth <= 0) return;
      const extraVerticalSpace = measureVerticalMargins(sizerEl, FALLBACK_SIZER_VERTICAL_MARGIN);
      const fit = computeFitWidthLayout({
        viewportClientWidth: box.clientWidth,
        viewportClientHeight: box.clientHeight,
        viewportOuterWidth: box.outerWidth,
        viewportOuterHeight: box.outerHeight,
        paddingX: box.paddingX,
        paddingY: box.paddingY,
        extraVerticalSpace,
        rawWidth,
        rawHeight,
        observedScrollbarWidth,
        minScale: MIN_FIT_ZOOM,
        maxScale: MAX_FIT_ZOOM,
      });
      observedScrollbarWidth = fit.observedScrollbarWidth;
      nextScale = fit.scale;
      scaledW = fit.scaledWidth;
      scaledH = fit.scaledHeight;
    } else {
      nextScale = clamp(manualZoom, MIN_ZOOM, MAX_ZOOM);
      scaledW = Math.ceil(rawWidth * nextScale);
      scaledH = Math.ceil(rawHeight * nextScale);
    }

    if (
      scaledW !== lastAppliedWidth ||
      scaledH !== lastAppliedHeight ||
      Math.abs(nextScale - lastAppliedScale) > 1e-6
    ) {
      sizerEl.style.width = `${scaledW}px`;
      sizerEl.style.height = `${scaledH}px`;
      scaleLayerEl.style.transform = `scale(${nextScale})`;
      lastAppliedWidth = scaledW;
      lastAppliedHeight = scaledH;
      lastAppliedScale = nextScale;
    }

    const zoomChanged = Math.abs(nextScale - effectiveZoom) > 0.002;
    effectiveZoom = nextScale;

    if (zoomChanged || totalChanged) {
      emitState();
    }
    dragPanner?.syncState();
  }

  function scheduleLayout(): void {
    if (destroyed || rafLayoutId !== null || preparingGeneration !== 0) return;
    rafLayoutId = requestAnimationFrame(() => {
      rafLayoutId = null;
      updateLayout();
    });
  }

  function updateCurrentPageFromScroll(): void {
    if (destroyed || !viewportEl) return;
    const sections = getPageSections();
    if (sections.length === 0) return;

    const viewportRect = viewportEl.getBoundingClientRect();
    const probeY = viewportRect.top + Math.min(120, viewportRect.height * 0.35);

    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < sections.length; i++) {
      const rect = sections[i].getBoundingClientRect();
      if (rect.top <= probeY && rect.bottom >= probeY) {
        bestIdx = i;
        break;
      }
      const dist = Math.min(Math.abs(rect.top - probeY), Math.abs(rect.bottom - probeY));
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    const nextPage = bestIdx + 1;
    if (nextPage !== currentPage) {
      currentPage = nextPage;
      emitState();
    }
  }

  function handleViewportScroll(): void {
    if (destroyed || rafScrollId !== null) return;
    rafScrollId = requestAnimationFrame(() => {
      rafScrollId = null;
      updateCurrentPageFromScroll();
    });
  }

  function clearSearchHighlights(): void {
    if (stageEl) {
      const marks = stageEl.querySelectorAll('mark.fp-word-search-hit');
      const dirtyParents = new Set<Node>();
      for (const mark of marks) {
        const parent = mark.parentNode;
        if (!parent) continue;
        parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
        dirtyParents.add(parent);
      }
      for (const parent of dirtyParents) {
        if (parent instanceof Element || parent instanceof DocumentFragment) {
          parent.normalize();
        }
      }
    }
    matchGroups = [];
  }

  function applySearchHighlights(query: string): void {
    clearSearchHighlights();
    const trimmed = query.trim();
    if (!trimmed || !stageEl) return;

    const queryLower = trimmed.toLowerCase();
    const walker = document.createTreeWalker(stageEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parentTag = node.parentElement?.tagName;
        if (parentTag === 'STYLE' || parentTag === 'SCRIPT' || parentTag === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT;
        }
        return node.nodeValue && node.nodeValue.length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    // 按块级容器分组连续 Text 节点，既支持同一段落内跨 span run 匹配，又不跨段错配
    const groups: Text[][] = [];
    let currentBlock: Element | null = null;
    let currentNodes: Text[] = [];
    let walked = walker.nextNode();
    while (walked) {
      const textNode = walked as Text;
      const block = getNearestBlockContainer(textNode, stageEl);
      if (block !== currentBlock && currentNodes.length > 0) {
        groups.push(currentNodes);
        currentNodes = [];
      }
      currentBlock = block;
      currentNodes.push(textNode);
      walked = walker.nextNode();
    }
    if (currentNodes.length > 0) {
      groups.push(currentNodes);
    }

    const nextMatchGroups: HTMLElement[][] = [];

    for (const nodes of groups) {
      if (nextMatchGroups.length >= MAX_WORD_MATCHES) break;

      const slices: TextRunSlice[] = [];
      let fullText = '';
      for (const node of nodes) {
        const val = node.nodeValue ?? '';
        if (!val) continue;
        const start = fullText.length;
        fullText += val;
        slices.push({ node, start, end: fullText.length });
      }
      if (!fullText) continue;

      const lowerFull = fullText.toLowerCase();
      const groupMatches: Array<{ start: number; end: number }> = [];
      let cursor = 0;
      while (cursor <= lowerFull.length - queryLower.length) {
        if (nextMatchGroups.length + groupMatches.length >= MAX_WORD_MATCHES) break;
        const idx = lowerFull.indexOf(queryLower, cursor);
        if (idx === -1) break;
        groupMatches.push({ start: idx, end: idx + queryLower.length });
        cursor = idx + Math.max(1, queryLower.length);
      }

      if (groupMatches.length === 0) continue;

      const createdForGroup: HTMLElement[][] = Array.from({ length: groupMatches.length }, () => []);

      // 从后往前切分每个涉及到的 Text 节点，确保前面的偏移量不受影响
      for (let mIdx = groupMatches.length - 1; mIdx >= 0; mIdx--) {
        const { start: mStart, end: mEnd } = groupMatches[mIdx];
        for (let sIdx = slices.length - 1; sIdx >= 0; sIdx--) {
          const slice = slices[sIdx];
          if (slice.end <= mStart || slice.start >= mEnd) continue;

          const localStart = Math.max(0, mStart - slice.start);
          const localEnd = Math.min(slice.end - slice.start, mEnd - slice.start);
          if (localEnd <= localStart) continue;

          const targetNode = slice.node;
          const tailLen = (targetNode.nodeValue?.length ?? 0) - localEnd;
          if (tailLen > 0) {
            targetNode.splitText(localEnd);
          }
          const hitNode = localStart > 0 ? targetNode.splitText(localStart) : targetNode;
          const mark = document.createElement('mark');
          mark.className = 'fp-word-search-hit';
          hitNode.parentNode?.replaceChild(mark, hitNode);
          mark.appendChild(hitNode);
          createdForGroup[mIdx].unshift(mark);
        }
      }

      for (const marks of createdForGroup) {
        if (marks.length > 0) {
          nextMatchGroups.push(marks);
        }
      }
    }

    matchGroups = nextMatchGroups;
  }

  function focusActiveMatch(scroll = true): void {
    if (destroyed || !stageEl) return;

    const prevActiveMarks = stageEl.querySelectorAll('mark.fp-word-search-hit.is-active');
    for (const el of prevActiveMarks) {
      el.classList.remove('is-active');
    }

    if (activeMatchIndex < 0 || activeMatchIndex >= matchGroups.length) {
      return;
    }

    const activeMarks = matchGroups[activeMatchIndex];
    for (const mark of activeMarks) {
      mark.classList.add('is-active');
    }

    const firstMark = activeMarks[0];
    if (!firstMark) return;

    const sections = getPageSections();
    const hostSection = firstMark.closest<HTMLElement>('.docx-wrapper > section.docx');
    const targetSectionIdx = hostSection ? sections.indexOf(hostSection) : -1;
    const prevPageNum = currentPage;
    if (targetSectionIdx >= 0) {
      currentPage = targetSectionIdx + 1;
    }

    if (scroll) {
      const isFarJump = Math.abs(currentPage - prevPageNum) > FAR_SECTION_JUMP;
      firstMark.scrollIntoView({
        behavior: isFarJump ? 'auto' : 'smooth',
        block: 'center',
        inline: 'nearest',
      });
    }
  }

  async function renderCurrentBuffer(preserveViewState = false): Promise<void> {
    if (destroyed || !stageEl || !lastBuffer) return;
    if (lastBuffer.byteLength === 0) {
      throw new Error(tr('Word 文档内容为空，无法渲染', 'Word document is empty and cannot be rendered.'));
    }

    const prevScrollTop = preserveViewState && viewportEl ? viewportEl.scrollTop : 0;
    const prevScrollLeft = preserveViewState && viewportEl ? viewportEl.scrollLeft : 0;
    const prevActiveIdx = preserveViewState ? activeMatchIndex : -1;

    const gen = ++loadGeneration;
    preparingGeneration = gen;
    try {
      dragPanner?.reset();
      clearSearchHighlights();
      stageEl.innerHTML = '';
      totalPages = 0;
      if (!preserveViewState) {
        currentPage = 1;
        searchQuery = '';
        activeMatchIndex = -1;
      }
      if (sizerEl) {
        sizerEl.style.width = '';
        sizerEl.style.height = '';
      }
      if (scaleLayerEl) {
        scaleLayerEl.style.transform = 'scale(1)';
      }
      lastAppliedWidth = -1;
      lastAppliedHeight = -1;
      lastAppliedScale = -1;

      const docxOptions: Partial<DocxPreviewOptions> & { keepOrigin?: boolean } = {
        inWrapper: true,
        breakPages: true,
        ignoreLastRenderedPageBreak: false,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        useBase64URL: false,
        keepOrigin: true,
      };

      const doc = await parseAsync(lastBuffer, docxOptions);
      if (destroyed || gen !== loadGeneration) {
        return;
      }

      const paginationMeta = collectDocxPaginationMeta(doc);
      sanitizeDocxPageBackground(doc);
      const sectionPageConfigs = preprocessDocxPageFields(doc);
      await applyHeaderFooterFrameAlignment(doc);
      if (destroyed || gen !== loadGeneration) {
        return;
      }

      const cjkLayoutContext = await collectDocxCjkLayout(doc);
      if (destroyed || gen !== loadGeneration) {
        return;
      }

      const tabStopContext = collectDocxTabStops(doc);
      const renderedNodes = await renderDocument(doc, docxOptions);
      if (destroyed || gen !== loadGeneration) {
        return;
      }

      stageEl.innerHTML = '';
      for (const node of renderedNodes) {
        stageEl.appendChild(node);
      }

      applyDocxCjkLayout(stageEl, cjkLayoutContext);
      normalizeDocxAutoLineHeight(stageEl);
      normalizeDocxMathMl(stageEl);
      await waitForDocxMediaReady(stageEl);
      if (destroyed || gen !== loadGeneration) {
        return;
      }

      if (scaleLayerEl) {
        scaleLayerEl.style.transform = 'scale(1)';
      }
      await paginateOverflowDocxSections(stageEl, paginationMeta, {
        renderHeaderFooterTemplates: async (sectProps) =>
          renderSyntheticHeaderFooterTemplates(
            doc,
            sectProps,
            docxOptions,
            stageEl!,
            cjkLayoutContext,
          ),
      });
      if (destroyed || gen !== loadGeneration) {
        return;
      }

      resolveDocxPageFields(stageEl, sectionPageConfigs);
      recalculateDocxTabStops(stageEl, tabStopContext);

      if (preserveViewState && searchQuery) {
        applySearchHighlights(searchQuery);
        activeMatchIndex =
          matchGroups.length > 0 ? clamp(Math.max(0, prevActiveIdx), 0, matchGroups.length - 1) : -1;
        focusActiveMatch(false);
      }
    } finally {
      if (preparingGeneration === gen) {
        preparingGeneration = 0;
      }
    }

    updateLayout();
    if (viewportEl) {
      viewportEl.scrollTop = prevScrollTop;
      viewportEl.scrollLeft = prevScrollLeft;
    }
    // Re-check once images/fonts settle on next frame
    scheduleLayout();
    emitState();
  }

  return {
    mount(container: HTMLElement): void {
      if (destroyed) {
        destroyed = false;
      }
      container.innerHTML = '';

      rootEl = document.createElement('div');
      rootEl.className = 'fp-word-root';

      viewportEl = document.createElement('div');
      viewportEl.className = 'fp-word-viewport';

      sizerEl = document.createElement('div');
      sizerEl.className = 'fp-word-sizer';

      scaleLayerEl = document.createElement('div');
      scaleLayerEl.className = 'fp-word-scale-layer';

      stageEl = document.createElement('div');
      stageEl.className = 'fp-word-stage';

      scaleLayerEl.appendChild(stageEl);
      sizerEl.appendChild(scaleLayerEl);
      viewportEl.appendChild(sizerEl);
      rootEl.appendChild(viewportEl);
      container.appendChild(rootEl);

      viewportEl.addEventListener('scroll', handleViewportScroll, { passive: true });

      // 挂载放大后鼠标拖拽平移控制器（悬停文字选字、空白处拖拽平移）
      dragPanner?.destroy();
      dragPanner = createDragPanner({
        getScrollContainer: () => viewportEl,
        isEnabled: () => {
          if (destroyed || fitMode) return false;
          if (manualZoom > 1) return true;
          const scrollContainer = viewportEl;
          return (
            scrollContainer !== null &&
            (scrollContainer.scrollWidth > scrollContainer.clientWidth + 2 ||
              scrollContainer.scrollHeight > scrollContainer.clientHeight + 2)
          );
        },
      });
      viewportEl.addEventListener('mousedown', dragPanner.handleMouseDown);
      viewportEl.addEventListener('mousemove', dragPanner.handleHoverMove, { passive: true });
      viewportEl.addEventListener('mouseleave', dragPanner.handleMouseLeave);
      viewportEl.addEventListener('click', dragPanner.handleClickCapture, true);

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver((entries) => {
          let hasMeaningfulChange = false;
          for (const entry of entries) {
            const target = entry.target as HTMLElement;
            if (target === viewportEl) {
              const cr = entry.contentRect;
              if (
                lastObservedViewportWidth < 0 ||
                Math.abs(cr.width - lastObservedViewportWidth) >= 1 ||
                Math.abs(cr.height - lastObservedViewportHeight) >= 1
              ) {
                lastObservedViewportWidth = cr.width;
                lastObservedViewportHeight = cr.height;
                hasMeaningfulChange = true;
              }
            } else if (target === scaleLayerEl) {
              const cr = entry.contentRect;
              if (
                lastObservedScaleLayerWidth < 0 ||
                Math.abs(cr.width - lastObservedScaleLayerWidth) >= 1 ||
                Math.abs(cr.height - lastObservedScaleLayerHeight) >= 1
              ) {
                lastObservedScaleLayerWidth = cr.width;
                lastObservedScaleLayerHeight = cr.height;
                hasMeaningfulChange = true;
              }
            }
          }
          if (hasMeaningfulChange) {
            scheduleLayout();
          }
        });
        resizeObserver.observe(viewportEl);
        resizeObserver.observe(scaleLayerEl);
      }
    },

    async loadBuffer(buffer: ArrayBuffer, meta: { name: string; path: string; ext: string }): Promise<void> {
      lastBuffer = buffer;
      lastMeta = meta;
      await renderCurrentBuffer(false);
    },

    async reloadBuffer(buffer: ArrayBuffer, meta: { name: string; path: string; ext: string }): Promise<void> {
      lastBuffer = buffer;
      lastMeta = meta;
      await renderCurrentBuffer(true);
    },

    async refresh(): Promise<void> {
      if (!lastBuffer || !lastMeta) return;
      await renderCurrentBuffer(true);
    },

    setZoom(zoom: number | 'fit'): void {
      if (zoom === 'fit') {
        fitMode = true;
        updateLayout();
        dragPanner?.syncState();
        emitState();
        return;
      }
      if (!Number.isFinite(zoom)) return;
      fitMode = false;
      manualZoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
      updateLayout();
      dragPanner?.syncState();
      emitState();
    },

    nextPage(): void {
      if (totalPages <= 0) return;
      this.goToPage?.(currentPage + 1);
    },

    prevPage(): void {
      if (totalPages <= 0) return;
      this.goToPage?.(currentPage - 1);
    },

    goToPage(page: number): void {
      if (!viewportEl || totalPages <= 0 || !Number.isFinite(page)) return;
      const prevPageNum = currentPage;
      const target = clamp(Math.round(page), 1, totalPages);
      const sections = getPageSections();
      const targetSection = sections[target - 1];
      if (targetSection) {
        const vpRect = viewportEl.getBoundingClientRect();
        const secRect = targetSection.getBoundingClientRect();
        const targetTop = viewportEl.scrollTop + (secRect.top - vpRect.top) - 12;
        const behavior: ScrollBehavior =
          Math.abs(target - prevPageNum) > FAR_SECTION_JUMP ? 'auto' : 'smooth';
        viewportEl.scrollTo({ top: Math.max(0, targetTop), behavior });
      }
      currentPage = target;
      emitState();
    },

    async search(query: string): Promise<{ total: number; current: number }> {
      searchQuery = query.trim();
      activeMatchIndex = -1;
      applySearchHighlights(searchQuery);

      if (!searchQuery || matchGroups.length === 0) {
        focusActiveMatch(false);
        emitState();
        return { total: 0, current: 0 };
      }

      activeMatchIndex = 0;
      focusActiveMatch(true);
      emitState();
      return { total: matchGroups.length, current: 1 };
    },

    nextMatch(): void {
      if (matchGroups.length === 0) return;
      activeMatchIndex = (activeMatchIndex + 1) % matchGroups.length;
      focusActiveMatch(true);
      emitState();
    },

    prevMatch(): void {
      if (matchGroups.length === 0) return;
      activeMatchIndex = (activeMatchIndex - 1 + matchGroups.length) % matchGroups.length;
      focusActiveMatch(true);
      emitState();
    },

    onStateChange(cb: (info: PreviewStateInfo) => void): void {
      stateListeners.add(cb);
    },

    destroy(): void {
      destroyed = true;
      loadGeneration++;
      preparingGeneration = 0;
      clearSearchHighlights();
      searchQuery = '';
      activeMatchIndex = -1;

      if (rafLayoutId !== null) {
        cancelAnimationFrame(rafLayoutId);
        rafLayoutId = null;
      }
      if (rafScrollId !== null) {
        cancelAnimationFrame(rafScrollId);
        rafScrollId = null;
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (viewportEl) {
        viewportEl.removeEventListener('scroll', handleViewportScroll);
        if (dragPanner) {
          viewportEl.removeEventListener('mousedown', dragPanner.handleMouseDown);
          viewportEl.removeEventListener('mousemove', dragPanner.handleHoverMove);
          viewportEl.removeEventListener('mouseleave', dragPanner.handleMouseLeave);
          viewportEl.removeEventListener('click', dragPanner.handleClickCapture, true);
        }
      }
      dragPanner?.destroy();
      dragPanner = null;
      if (stageEl) {
        stageEl.innerHTML = '';
      }
      if (rootEl) {
        rootEl.remove();
      }

      rootEl = null;
      viewportEl = null;
      sizerEl = null;
      scaleLayerEl = null;
      stageEl = null;
      lastBuffer = null;
      lastMeta = null;
      observedScrollbarWidth = 0;
      lastAppliedWidth = -1;
      lastAppliedHeight = -1;
      lastAppliedScale = -1;
      lastObservedViewportWidth = -1;
      lastObservedViewportHeight = -1;
      lastObservedScaleLayerWidth = -1;
      lastObservedScaleLayerHeight = -1;
      totalPages = 0;
      currentPage = 1;
      stateListeners.clear();
    },
  };
}
