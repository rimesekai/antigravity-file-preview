import type {
  HtmlPreviewMode,
  PptLayoutMode,
  PreviewKind,
  PreviewStateInfo,
} from '../types/preview';
import type { ThemePreference } from '../services/themeSync';
import { formatKindBadge } from '../utils/fileMeta';
import {
  type LocalePreference,
  onLocaleChange,
  tr,
} from '../utils/i18n';
import { createIcon } from '../utils/icons';
import {
  attachSegmentedIndicator,
  attachToolbarRovingFocus,
  isImeComposing,
  renderTruncatableFileName,
} from '../utils/uiHelpers';

const LARGE_PDF_THRESHOLD_BYTES = 20 * 1024 * 1024;

export interface ToolbarFileMeta {
  name: string;
  path: string;
  ext: string;
  kind: PreviewKind;
  size?: number;
  isLocalDrop: boolean;
}

export interface ToolbarRenderState {
  visible: boolean;
  file: ToolbarFileMeta | null;
  preview: PreviewStateInfo | null;
  loading: boolean;
  hasError: boolean;
  autoRefresh: boolean;
  drawerOpen: boolean;
  themePreference?: ThemePreference;
  localePreference?: LocalePreference;
}

export interface ToolbarCallbacks {
  onToggleDrawer: () => void;
  onRefresh: () => void;
  onRevealInExplorer?: () => void;
  onToggleAutoRefresh: () => void;
  onCycleTheme?: () => void;
  onOpenAppearance?: (anchorEl: HTMLElement) => void;
  onCycleLocale?: () => void;
  onZoomChange: (zoom: number | 'fit') => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onGoToPage: (page: number) => void;
  onLayoutModeChange: (mode: PptLayoutMode) => void;
  onToggleThumbnails: () => void;
  onSearch: (query: string) => Promise<void>;
  onNextMatch: () => void;
  onPrevMatch: () => void;
  onHtmlModeChange: (mode: HtmlPreviewMode) => void;
}

export interface ToolbarController {
  update: (state: ToolbarRenderState) => void;
  resetSearch: () => void;
  destroy: () => void;
}

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1.0, 1.25, 1.5, 1.75, 2.0];

function clampZoom(value: number): number {
  return Math.min(2.0, Math.max(0.5, Math.round(value * 100) / 100));
}

function stepZoom(current: number, direction: -1 | 1): number {
  const normalized = clampZoom(current || 1.0);
  if (direction > 0) {
    const next = ZOOM_STEPS.find((step) => step > normalized + 0.02);
    return next ?? clampZoom(normalized + 0.15);
  }
  const reversed = [...ZOOM_STEPS].reverse();
  const prev = reversed.find((step) => step < normalized - 0.02);
  return prev ?? clampZoom(normalized - 0.15);
}

/**
 * 创建顶部自适应工具栏控制器（持久 DOM 节点，避免输入时失焦；遵循 Window Chrome 与 ARIA Toolbar 规范）。
 */
export function createToolbar(
  container: HTMLElement,
  callbacks: ToolbarCallbacks,
): ToolbarController {
  let latestState: ToolbarRenderState = {
    visible: false,
    file: null,
    preview: null,
    loading: false,
    hasError: false,
    autoRefresh: true,
    drawerOpen: false,
  };

  interface SearchClusterController {
    clusterEl: HTMLElement;
    inputEl: HTMLInputElement;
    setPlaceholder: (placeholder: string, ariaLabel: string) => void;
    refreshLocale: () => void;
    updateMatches: (totalMatches: number, activeMatch: number) => void;
    reset: () => void;
  }

  /** 创建胶囊搜索控件组（PPT / PDF / Excel / Word 复用，含 IME 组合态安全回车）。 */
  function createSearchCluster(placeholder: string, ariaLabel: string): SearchClusterController {
    let lastQuery = '';

    const clusterEl = document.createElement('div');
    clusterEl.className = 'fp-cluster fp-ppt-search';

    const pillWrap = document.createElement('div');
    pillWrap.className = 'fp-pill-search';

    const searchIcon = createIcon('search', 14);
    searchIcon.classList.add('fp-pill-search__icon');

    const inputEl = document.createElement('input');
    inputEl.type = 'search';
    inputEl.className = 'fp-search-input';
    inputEl.placeholder = placeholder;
    inputEl.setAttribute('aria-label', ariaLabel);

    const triggerSearch = () => {
      const query = inputEl.value.trim();
      if (query === lastQuery && query) {
        callbacks.onNextMatch();
        return;
      }
      lastQuery = query;
      void callbacks.onSearch(query);
    };

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (isImeComposing(e)) {
          return;
        }
        if (e.shiftKey && inputEl.value.trim() === lastQuery && lastQuery) {
          callbacks.onPrevMatch();
          return;
        }
        triggerSearch();
      } else if (e.key === 'Escape') {
        inputEl.value = '';
        lastQuery = '';
        void callbacks.onSearch('');
      }
    });

    inputEl.addEventListener('input', () => {
      if (!inputEl.value.trim() && lastQuery) {
        lastQuery = '';
        void callbacks.onSearch('');
      }
    });

    const countEl = document.createElement('span');
    countEl.className = 'fp-search-count fc-tabular';
    countEl.hidden = true;

    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'fp-btn fp-btn-icon fp-btn-icon--sm';
    prevBtn.appendChild(createIcon('chevronUp', 13));
    prevBtn.hidden = true;
    prevBtn.addEventListener('click', () => callbacks.onPrevMatch());

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'fp-btn fp-btn-icon fp-btn-icon--sm';
    nextBtn.appendChild(createIcon('chevronDown', 13));
    nextBtn.hidden = true;
    nextBtn.addEventListener('click', () => callbacks.onNextMatch());

    pillWrap.append(searchIcon, inputEl, countEl);
    clusterEl.append(pillWrap, prevBtn, nextBtn);

    return {
      clusterEl,
      inputEl,
      setPlaceholder(nextPlaceholder: string, nextAriaLabel: string): void {
        inputEl.placeholder = nextPlaceholder;
        inputEl.setAttribute('aria-label', nextAriaLabel);
      },
      refreshLocale(): void {
        const prevTitle = tr('上一个匹配项', 'Previous match');
        const nextTitle = tr('下一个匹配项', 'Next match');
        prevBtn.title = prevTitle;
        prevBtn.setAttribute('aria-label', prevTitle);
        nextBtn.title = nextTitle;
        nextBtn.setAttribute('aria-label', nextTitle);
      },
      updateMatches(totalMatches: number, activeMatch: number): void {
        const hasQuery = Boolean(lastQuery);
        countEl.hidden = !hasQuery && totalMatches === 0;
        if (hasQuery || totalMatches > 0) {
          countEl.textContent = totalMatches > 0 ? `${activeMatch}/${totalMatches}` : '0/0';
        }
        const navVisible = totalMatches > 0;
        prevBtn.hidden = !navVisible;
        nextBtn.hidden = !navVisible;
      },
      reset(): void {
        lastQuery = '';
        inputEl.value = '';
        countEl.hidden = true;
        prevBtn.hidden = true;
        nextBtn.hidden = true;
      },
    };
  }

  const root = document.createElement('div');
  root.className = 'fp-toolbar';
  root.hidden = true;

  // 第一行：文件导航、标题与系统操作（Window Chrome）
  const primaryRow = document.createElement('div');
  primaryRow.className = 'fp-toolbar-row fp-toolbar-primary';
  primaryRow.setAttribute('role', 'toolbar');
  primaryRow.setAttribute('aria-label', tr('主文档工具栏', 'Document toolbar'));

  const leftGroup = document.createElement('div');
  leftGroup.className = 'fp-toolbar-group fp-toolbar-left';
  leftGroup.setAttribute('role', 'group');
  leftGroup.setAttribute('aria-label', tr('文件信息', 'File info'));

  const drawerBtn = document.createElement('button');
  drawerBtn.type = 'button';
  drawerBtn.className = 'fp-btn fp-btn-ghost fp-btn-files';
  drawerBtn.setAttribute('aria-expanded', 'false');
  drawerBtn.setAttribute('aria-controls', 'fp-drawer-dialog');
  drawerBtn.appendChild(createIcon('folder', 15));
  const drawerBtnText = document.createElement('span');
  drawerBtn.appendChild(drawerBtnText);
  drawerBtn.addEventListener('click', () => callbacks.onToggleDrawer());

  const fileBadge = document.createElement('span');
  fileBadge.className = 'fp-kind-badge';

  const fileNameEl = document.createElement('span');
  fileNameEl.className = 'fp-toolbar-filename';

  const largePdfBadge = document.createElement('span');
  largePdfBadge.className = 'fp-status-pill fp-status-pill--warn';
  largePdfBadge.hidden = true;

  const dropTag = document.createElement('span');
  dropTag.className = 'fp-status-pill';
  dropTag.hidden = true;

  leftGroup.append(drawerBtn, fileBadge, fileNameEl, largePdfBadge, dropTag);

  const primarySep = document.createElement('span');
  primarySep.className = 'fp-toolbar-sep';
  primarySep.setAttribute('role', 'separator');
  primarySep.setAttribute('aria-orientation', 'vertical');

  const rightGroup = document.createElement('div');
  rightGroup.className = 'fp-toolbar-group fp-toolbar-right';
  rightGroup.setAttribute('role', 'group');
  rightGroup.setAttribute('aria-label', tr('文件与外观操作', 'File and appearance actions'));

  const autoRefreshBtn = document.createElement('button');
  autoRefreshBtn.type = 'button';
  autoRefreshBtn.className = 'fp-btn fp-btn-toggle';
  autoRefreshBtn.setAttribute('aria-pressed', 'true');
  const autoDot = document.createElement('span');
  autoDot.className = 'fp-auto-dot';
  autoDot.setAttribute('aria-hidden', 'true');
  const autoText = document.createElement('span');
  autoText.className = 'fp-hide-sm';
  autoRefreshBtn.append(autoDot, autoText);
  autoRefreshBtn.addEventListener('click', () => {
    if (autoRefreshBtn.getAttribute('aria-disabled') === 'true') return;
    callbacks.onToggleAutoRefresh();
  });

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'fp-btn fp-btn-ghost fp-btn-icon-label';
  const refreshIcon = createIcon('refresh', 15);
  const refreshLabel = document.createElement('span');
  refreshLabel.className = 'fp-hide-xs';
  refreshBtn.append(refreshIcon, refreshLabel);
  refreshBtn.addEventListener('click', () => {
    if (refreshBtn.getAttribute('aria-disabled') === 'true') return;
    callbacks.onRefresh();
  });

  const revealBtn = document.createElement('button');
  revealBtn.type = 'button';
  revealBtn.className = 'fp-btn fp-btn-ghost fp-btn-icon-label';
  revealBtn.appendChild(createIcon('folderOpen', 15));
  const revealLabel = document.createElement('span');
  revealLabel.className = 'fp-hide-xs';
  revealBtn.appendChild(revealLabel);
  revealBtn.addEventListener('click', () => {
    if (revealBtn.getAttribute('aria-disabled') === 'true') return;
    callbacks.onRevealInExplorer?.();
  });

  const appearanceBtn = document.createElement('button');
  appearanceBtn.type = 'button';
  appearanceBtn.className = 'fp-btn fp-btn-tonal fp-btn-appearance';
  appearanceBtn.setAttribute('aria-haspopup', 'dialog');
  appearanceBtn.setAttribute('aria-expanded', 'false');
  appearanceBtn.setAttribute('aria-controls', 'fp-appearance-popover');
  appearanceBtn.appendChild(createIcon('palette', 15));
  const appearanceDot = document.createElement('span');
  appearanceDot.className = 'fp-appearance-dot';
  appearanceDot.setAttribute('aria-hidden', 'true');
  appearanceBtn.appendChild(appearanceDot);
  appearanceBtn.addEventListener('click', () => {
    if (callbacks.onOpenAppearance) {
      callbacks.onOpenAppearance(appearanceBtn);
    } else {
      callbacks.onCycleTheme?.();
    }
  });

  rightGroup.append(autoRefreshBtn, refreshBtn, revealBtn, appearanceBtn);
  primaryRow.append(leftGroup, primarySep, rightGroup);

  // 第二行：格式专属工具条
  const secondaryRow = document.createElement('div');
  secondaryRow.className = 'fp-toolbar-row fp-toolbar-secondary';
  secondaryRow.setAttribute('role', 'toolbar');
  secondaryRow.setAttribute('aria-label', tr('视图与格式控制', 'View and format controls'));

  // --- PPT / PDF / Excel 分页工具条 ---
  const pptGroup = document.createElement('div');
  pptGroup.className = 'fp-format-controls fp-format-ppt';
  pptGroup.hidden = true;

  const pptLayoutSeg = document.createElement('div');
  pptLayoutSeg.className = 'fp-segmented';
  pptLayoutSeg.setAttribute('role', 'group');
  const pptSlideBtn = document.createElement('button');
  pptSlideBtn.type = 'button';
  pptSlideBtn.className = 'fp-seg-btn';
  pptSlideBtn.setAttribute('aria-pressed', 'true');
  pptSlideBtn.appendChild(createIcon('slideMode', 13));
  const pptSlideText = document.createElement('span');
  pptSlideBtn.appendChild(pptSlideText);
  pptSlideBtn.addEventListener('click', () => callbacks.onLayoutModeChange('slide'));

  const pptListBtn = document.createElement('button');
  pptListBtn.type = 'button';
  pptListBtn.className = 'fp-seg-btn';
  pptListBtn.setAttribute('aria-pressed', 'false');
  pptListBtn.appendChild(createIcon('scrollMode', 13));
  const pptListText = document.createElement('span');
  pptListBtn.appendChild(pptListText);
  pptListBtn.addEventListener('click', () => callbacks.onLayoutModeChange('list'));
  pptLayoutSeg.append(pptSlideBtn, pptListBtn);

  const pptThumbBtn = document.createElement('button');
  pptThumbBtn.type = 'button';
  pptThumbBtn.className = 'fp-btn fp-btn-ghost fp-btn-compact';
  pptThumbBtn.setAttribute('aria-pressed', 'false');
  pptThumbBtn.appendChild(createIcon('thumbnails', 14));
  const pptThumbText = document.createElement('span');
  pptThumbBtn.appendChild(pptThumbText);
  pptThumbBtn.addEventListener('click', () => callbacks.onToggleThumbnails());

  const pptPageCluster = document.createElement('div');
  pptPageCluster.className = 'fp-cluster fp-cluster--pill';
  pptPageCluster.setAttribute('role', 'group');

  const prevPageBtn = document.createElement('button');
  prevPageBtn.type = 'button';
  prevPageBtn.className = 'fp-btn fp-btn-icon fp-btn-icon--sm';
  prevPageBtn.appendChild(createIcon('chevronLeft', 14));
  prevPageBtn.addEventListener('click', () => {
    if (prevPageBtn.getAttribute('aria-disabled') === 'true') return;
    callbacks.onPrevPage();
  });

  const pageInput = document.createElement('input');
  pageInput.type = 'number';
  pageInput.min = '1';
  pageInput.className = 'fp-page-input fc-tabular';

  const commitPageInput = () => {
    const total = latestState.preview?.totalPages ?? 1;
    const raw = Number.parseInt(pageInput.value, 10);
    if (!Number.isFinite(raw)) {
      pageInput.value = String(latestState.preview?.page ?? 1);
      return;
    }
    const clamped = Math.min(Math.max(1, raw), Math.max(1, total));
    pageInput.value = String(clamped);
    callbacks.onGoToPage(clamped);
  };

  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (isImeComposing(e)) return;
      commitPageInput();
      pageInput.blur();
    }
  });
  pageInput.addEventListener('change', commitPageInput);

  const pageTotalEl = document.createElement('span');
  pageTotalEl.className = 'fp-page-total fc-tabular';
  pageTotalEl.textContent = '/ 1';

  const nextPageBtn = document.createElement('button');
  nextPageBtn.type = 'button';
  nextPageBtn.className = 'fp-btn fp-btn-icon fp-btn-icon--sm';
  nextPageBtn.appendChild(createIcon('chevronRight', 14));
  nextPageBtn.addEventListener('click', () => {
    if (nextPageBtn.getAttribute('aria-disabled') === 'true') return;
    callbacks.onNextPage();
  });

  pptPageCluster.append(prevPageBtn, pageInput, pageTotalEl, nextPageBtn);

  const sheetNamePill = document.createElement('span');
  sheetNamePill.className = 'fp-sheet-name-pill';
  sheetNamePill.hidden = true;

  // PPT / PDF / Excel 缩放控件
  const pptZoomCluster = document.createElement('div');
  pptZoomCluster.className = 'fp-cluster fp-cluster--pill';
  pptZoomCluster.setAttribute('role', 'group');

  const pptFitBtn = document.createElement('button');
  pptFitBtn.type = 'button';
  pptFitBtn.className = 'fp-btn fp-btn-chip';
  pptFitBtn.setAttribute('aria-pressed', 'true');
  const pptFitText = document.createElement('span');
  pptFitBtn.appendChild(pptFitText);
  pptFitBtn.addEventListener('click', () => callbacks.onZoomChange('fit'));

  const pptZoomOutBtn = document.createElement('button');
  pptZoomOutBtn.type = 'button';
  pptZoomOutBtn.className = 'fp-btn fp-btn-icon fp-btn-icon--sm';
  pptZoomOutBtn.appendChild(createIcon('minus', 13));
  pptZoomOutBtn.addEventListener('click', () => {
    if (pptZoomOutBtn.getAttribute('aria-disabled') === 'true') return;
    const current = latestState.preview?.zoom ?? 1.0;
    callbacks.onZoomChange(stepZoom(current, -1));
  });

  const pptZoomText = document.createElement('span');
  pptZoomText.className = 'fp-zoom-value fc-tabular';
  pptZoomText.textContent = '100%';

  const pptZoomInBtn = document.createElement('button');
  pptZoomInBtn.type = 'button';
  pptZoomInBtn.className = 'fp-btn fp-btn-icon fp-btn-icon--sm';
  pptZoomInBtn.appendChild(createIcon('plus', 13));
  pptZoomInBtn.addEventListener('click', () => {
    if (pptZoomInBtn.getAttribute('aria-disabled') === 'true') return;
    const current = latestState.preview?.zoom ?? 1.0;
    callbacks.onZoomChange(stepZoom(current, 1));
  });

  pptZoomCluster.append(pptFitBtn, pptZoomOutBtn, pptZoomText, pptZoomInBtn);

  const pptSearch = createSearchCluster('搜索幻灯片 (回车)', '搜索幻灯片文本');

  pptGroup.append(
    pptLayoutSeg,
    pptThumbBtn,
    pptPageCluster,
    sheetNamePill,
    pptZoomCluster,
    pptSearch.clusterEl,
  );

  // --- Word 工具条 ---
  const wordGroup = document.createElement('div');
  wordGroup.className = 'fp-format-controls fp-format-word';
  wordGroup.hidden = true;

  const wordZoomCluster = document.createElement('div');
  wordZoomCluster.className = 'fp-cluster fp-cluster--pill';
  wordZoomCluster.setAttribute('role', 'group');

  const wordFitBtn = document.createElement('button');
  wordFitBtn.type = 'button';
  wordFitBtn.className = 'fp-btn fp-btn-chip';
  wordFitBtn.setAttribute('aria-pressed', 'true');
  wordFitBtn.appendChild(createIcon('fit', 13));
  const wordFitText = document.createElement('span');
  wordFitBtn.appendChild(wordFitText);
  wordFitBtn.addEventListener('click', () => callbacks.onZoomChange('fit'));

  const wordZoomOutBtn = document.createElement('button');
  wordZoomOutBtn.type = 'button';
  wordZoomOutBtn.className = 'fp-btn fp-btn-icon fp-btn-icon--sm';
  wordZoomOutBtn.appendChild(createIcon('minus', 13));
  wordZoomOutBtn.addEventListener('click', () => {
    if (wordZoomOutBtn.getAttribute('aria-disabled') === 'true') return;
    const current = latestState.preview?.zoom ?? 1.0;
    callbacks.onZoomChange(stepZoom(current, -1));
  });

  const wordZoomText = document.createElement('span');
  wordZoomText.className = 'fp-zoom-value fc-tabular';
  wordZoomText.textContent = '100%';

  const wordZoomInBtn = document.createElement('button');
  wordZoomInBtn.type = 'button';
  wordZoomInBtn.className = 'fp-btn fp-btn-icon fp-btn-icon--sm';
  wordZoomInBtn.appendChild(createIcon('plus', 13));
  wordZoomInBtn.addEventListener('click', () => {
    if (wordZoomInBtn.getAttribute('aria-disabled') === 'true') return;
    const current = latestState.preview?.zoom ?? 1.0;
    callbacks.onZoomChange(stepZoom(current, 1));
  });

  wordZoomCluster.append(wordFitBtn, wordZoomOutBtn, wordZoomText, wordZoomInBtn);

  const wordSearch = createSearchCluster('搜索文档内容 (回车)', '搜索 Word 文档内容');
  wordGroup.append(wordZoomCluster, wordSearch.clusterEl);

  // --- HTML 工具条 ---
  const htmlGroup = document.createElement('div');
  htmlGroup.className = 'fp-format-controls fp-format-html';
  htmlGroup.hidden = true;

  const htmlModeSeg = document.createElement('div');
  htmlModeSeg.className = 'fp-segmented';
  htmlModeSeg.setAttribute('role', 'group');

  const htmlSandboxBtn = document.createElement('button');
  htmlSandboxBtn.type = 'button';
  htmlSandboxBtn.className = 'fp-seg-btn';
  htmlSandboxBtn.setAttribute('aria-pressed', 'true');
  htmlSandboxBtn.appendChild(createIcon('shield', 13));
  const htmlSandboxText = document.createElement('span');
  htmlSandboxBtn.appendChild(htmlSandboxText);
  htmlSandboxBtn.addEventListener('click', () => callbacks.onHtmlModeChange('sandbox'));

  const htmlInteractiveBtn = document.createElement('button');
  htmlInteractiveBtn.type = 'button';
  htmlInteractiveBtn.className = 'fp-seg-btn';
  htmlInteractiveBtn.setAttribute('aria-pressed', 'false');
  htmlInteractiveBtn.appendChild(createIcon('play', 13));
  const htmlInteractiveText = document.createElement('span');
  htmlInteractiveBtn.appendChild(htmlInteractiveText);
  htmlInteractiveBtn.addEventListener('click', () => callbacks.onHtmlModeChange('interactive'));

  const htmlSourceBtn = document.createElement('button');
  htmlSourceBtn.type = 'button';
  htmlSourceBtn.className = 'fp-seg-btn';
  htmlSourceBtn.setAttribute('aria-pressed', 'false');
  htmlSourceBtn.appendChild(createIcon('code', 13));
  const htmlSourceText = document.createElement('span');
  htmlSourceBtn.appendChild(htmlSourceText);
  htmlSourceBtn.addEventListener('click', () => callbacks.onHtmlModeChange('source'));

  htmlModeSeg.append(htmlSandboxBtn, htmlInteractiveBtn, htmlSourceBtn);

  const htmlStatusBanner = document.createElement('div');
  htmlStatusBanner.className = 'fp-html-status-pill';

  htmlGroup.append(htmlModeSeg, htmlStatusBanner);

  secondaryRow.append(pptGroup, wordGroup, htmlGroup);
  root.append(primaryRow, secondaryRow);
  container.appendChild(root);

  const stopPrimaryRoving = attachToolbarRovingFocus(primaryRow);
  const stopSecondaryRoving = attachToolbarRovingFocus(secondaryRow);
  const pptLayoutIndicator = attachSegmentedIndicator(pptLayoutSeg);
  const htmlModeIndicator = attachSegmentedIndicator(htmlModeSeg);

  function setButtonAriaDisabled(btn: HTMLButtonElement, disabled: boolean): void {
    btn.setAttribute('aria-disabled', String(disabled));
    btn.classList.toggle('is-disabled', disabled);
  }

  function updatePagedControls(preview: PreviewStateInfo | null, kind: PreviewKind): void {
    const isPdf = kind === 'pdf';
    const isExcel = kind === 'excel';

    pptLayoutSeg.hidden = isExcel;
    pptThumbBtn.hidden = isExcel;
    pptPageCluster.hidden = false;
    pptZoomCluster.hidden = false;
    pptSearch.clusterEl.hidden = false;

    if (isExcel) {
      const prevTitle = tr('上一工作表', 'Previous sheet');
      const nextTitle = tr('下一工作表', 'Next sheet');
      prevPageBtn.title = prevTitle;
      prevPageBtn.setAttribute('aria-label', prevTitle);
      nextPageBtn.title = nextTitle;
      nextPageBtn.setAttribute('aria-label', nextTitle);
      pageInput.setAttribute('aria-label', tr('当前工作表序号', 'Current sheet index'));
      pptFitBtn.title = tr('重置为标准视图', 'Reset to 100% view');
      pptSearch.setPlaceholder(tr('搜索表格内容 (回车)', 'Search sheet (Enter)'), tr('搜索表格内容', 'Search sheet'));
    } else if (isPdf) {
      const prevTitle = tr('上一页', 'Previous page');
      const nextTitle = tr('下一页', 'Next page');
      prevPageBtn.title = prevTitle;
      prevPageBtn.setAttribute('aria-label', prevTitle);
      nextPageBtn.title = nextTitle;
      nextPageBtn.setAttribute('aria-label', nextTitle);
      pageInput.setAttribute('aria-label', tr('当前页码', 'Current page'));
      pptFitBtn.title = tr('自适应侧边栏宽度', 'Fit sidebar width');
      pptThumbBtn.title = tr('切换页面缩略图栏', 'Toggle page thumbnails');
      pptSearch.setPlaceholder(tr('搜索 PDF 文本 (回车)', 'Search PDF (Enter)'), tr('搜索 PDF 文本', 'Search PDF text'));
    } else {
      const prevTitle = tr('上一页', 'Previous page');
      const nextTitle = tr('下一页', 'Next page');
      prevPageBtn.title = prevTitle;
      prevPageBtn.setAttribute('aria-label', prevTitle);
      nextPageBtn.title = nextTitle;
      nextPageBtn.setAttribute('aria-label', nextTitle);
      pageInput.setAttribute('aria-label', tr('当前页码', 'Current page'));
      pptFitBtn.title = tr('自适应侧边栏宽度', 'Fit sidebar width');
      pptThumbBtn.title = tr('切换幻灯片缩略图栏', 'Toggle slide thumbnails');
      pptSearch.setPlaceholder(tr('搜索幻灯片 (回车)', 'Search slides (Enter)'), tr('搜索幻灯片文本', 'Search slide text'));
    }

    const activeSheet = preview?.activeSheet?.trim();
    if (isExcel && activeSheet) {
      sheetNamePill.hidden = false;
      sheetNamePill.textContent = activeSheet;
      sheetNamePill.title = tr(`当前工作表：${activeSheet}`, `Active sheet: ${activeSheet}`);
    } else {
      sheetNamePill.hidden = true;
      sheetNamePill.textContent = '';
      sheetNamePill.title = '';
    }

    const page = preview?.page ?? 1;
    const totalPages = Math.max(1, preview?.totalPages ?? 1);
    const layoutMode = preview?.layoutMode ?? 'slide';
    const thumbs = Boolean(preview?.thumbnailsVisible);
    const fitMode = preview?.fitMode ?? true;
    const zoom = preview?.zoom ?? 1.0;

    pptSlideBtn.setAttribute('aria-pressed', String(layoutMode === 'slide'));
    pptListBtn.setAttribute('aria-pressed', String(layoutMode === 'list'));
    pptThumbBtn.setAttribute('aria-pressed', String(thumbs));
    pptThumbBtn.classList.toggle('is-active', thumbs);

    if (document.activeElement !== pageInput) {
      pageInput.value = String(page);
    }
    pageInput.max = String(totalPages);
    pageTotalEl.textContent = `/ ${totalPages}`;
    setButtonAriaDisabled(prevPageBtn, page <= 1);
    setButtonAriaDisabled(nextPageBtn, page >= totalPages);

    pptFitBtn.setAttribute('aria-pressed', String(fitMode));
    pptFitBtn.classList.toggle('is-active', fitMode);
    pptZoomText.textContent = `${Math.round(zoom * 100)}%`;
    setButtonAriaDisabled(pptZoomOutBtn, zoom <= 0.5);
    setButtonAriaDisabled(pptZoomInBtn, zoom >= 2.0);

    const totalMatches = preview?.searchMatches ?? 0;
    const activeMatch = preview?.activeMatch ?? 0;
    pptSearch.updateMatches(totalMatches, activeMatch);
  }

  function updateWordControls(preview: PreviewStateInfo | null): void {
    const fitMode = preview?.fitMode ?? true;
    const zoom = preview?.zoom ?? 1.0;
    wordFitBtn.setAttribute('aria-pressed', String(fitMode));
    wordFitBtn.classList.toggle('is-active', fitMode);
    wordZoomText.textContent = `${Math.round(zoom * 100)}%`;
    setButtonAriaDisabled(wordZoomOutBtn, zoom <= 0.5);
    setButtonAriaDisabled(wordZoomInBtn, zoom >= 2.0);

    const totalMatches = preview?.searchMatches ?? 0;
    const activeMatch = preview?.activeMatch ?? 0;
    wordSearch.updateMatches(totalMatches, activeMatch);
  }

  function updateHtmlControls(preview: PreviewStateInfo | null, file: ToolbarFileMeta): void {
    const mode: HtmlPreviewMode = preview?.htmlMode ?? 'sandbox';
    htmlSandboxBtn.setAttribute('aria-pressed', String(mode === 'sandbox'));
    htmlInteractiveBtn.setAttribute('aria-pressed', String(mode === 'interactive'));
    htmlSourceBtn.setAttribute('aria-pressed', String(mode === 'source'));

    htmlStatusBanner.classList.remove('is-warn', 'is-safe', 'is-interactive');
    if (preview?.warning) {
      htmlStatusBanner.classList.add('is-warn');
      htmlStatusBanner.textContent = preview.warning;
    } else if (mode === 'sandbox') {
      htmlStatusBanner.classList.add('is-safe');
      htmlStatusBanner.textContent = tr('安全沙箱：已禁止脚本执行', 'Sandbox: scripts disabled');
    } else if (mode === 'interactive') {
      htmlStatusBanner.classList.add('is-interactive');
      htmlStatusBanner.textContent = file.isLocalDrop
        ? tr('仅工作区路径文件支持完整交互脚本', 'Full scripts require a workspace file path')
        : tr('交互模式：跨源隔离执行页面脚本', 'Interactive: scripts run in isolated origin');
    } else {
      htmlStatusBanner.textContent = tr('源码视图：只读文本展示', 'Source View: read-only HTML');
    }
  }

  function applyStaticLocaleText(): void {
    primaryRow.setAttribute('aria-label', tr('主文档工具栏', 'Document toolbar'));
    secondaryRow.setAttribute('aria-label', tr('视图与格式控制', 'View and format controls'));
    leftGroup.setAttribute('aria-label', tr('文件信息', 'File info'));
    rightGroup.setAttribute('aria-label', tr('文件与外观操作', 'File and appearance actions'));
    pptLayoutSeg.setAttribute('aria-label', tr('页面排版模式', 'Layout mode'));
    pptPageCluster.setAttribute('aria-label', tr('翻页控制', 'Page navigation'));
    pptZoomCluster.setAttribute('aria-label', tr('缩放控制', 'Zoom controls'));
    wordZoomCluster.setAttribute('aria-label', tr('缩放控制', 'Zoom controls'));
    htmlModeSeg.setAttribute('aria-label', tr('HTML 预览模式', 'HTML preview mode'));

    const filesTitle = tr('打开或切换工作区文件列表', 'Toggle workspace file list');
    drawerBtn.title = filesTitle;
    drawerBtn.setAttribute('aria-label', filesTitle);
    drawerBtnText.textContent = tr('文件', 'Files');

    largePdfBadge.textContent = tr('>20MB 流式', '>20MB Stream');
    dropTag.textContent = tr('本地拖入', 'Local Drop');

    const revealTitle = tr('在文件资源管理器中查看当前文件', 'Reveal current file in Explorer');
    revealBtn.title = revealTitle;
    revealBtn.setAttribute('aria-label', revealTitle);
    revealLabel.textContent = tr('位置', 'Reveal');

    const refreshTitle = tr('立即重新加载当前文件', 'Reload current file');
    refreshBtn.title = refreshTitle;
    refreshBtn.setAttribute('aria-label', refreshTitle);
    refreshLabel.textContent = tr('刷新', 'Refresh');

    autoText.textContent = tr('自动刷新', 'Auto');

    const appearanceTitle = tr('外观、明暗主题与语言设置', 'Appearance, theme & language');
    appearanceBtn.title = appearanceTitle;
    appearanceBtn.setAttribute('aria-label', appearanceTitle);

    pptSlideText.textContent = tr('单页', 'Slide');
    pptListText.textContent = tr('滚动', 'Scroll');
    pptThumbText.textContent = tr('缩略图', 'Thumbs');
    pptFitText.textContent = tr('适应', 'Fit');
    const zoomOutTitle = tr('缩小', 'Zoom out');
    const zoomInTitle = tr('放大', 'Zoom in');
    pptZoomOutBtn.title = zoomOutTitle;
    pptZoomOutBtn.setAttribute('aria-label', zoomOutTitle);
    pptZoomInBtn.title = zoomInTitle;
    pptZoomInBtn.setAttribute('aria-label', zoomInTitle);
    pptSearch.refreshLocale();

    wordFitText.textContent = tr('适应宽度', 'Fit Width');
    wordFitBtn.title = tr('自适应侧边栏宽度', 'Fit sidebar width');
    wordZoomOutBtn.title = zoomOutTitle;
    wordZoomOutBtn.setAttribute('aria-label', zoomOutTitle);
    wordZoomInBtn.title = zoomInTitle;
    wordZoomInBtn.setAttribute('aria-label', zoomInTitle);
    wordSearch.setPlaceholder(
      tr('搜索文档内容 (回车)', 'Search document (Enter)'),
      tr('搜索 Word 文档内容', 'Search Word document'),
    );
    wordSearch.refreshLocale();

    htmlSandboxText.textContent = tr('沙箱', 'Sandbox');
    htmlInteractiveText.textContent = tr('交互', 'Interactive');
    htmlSourceText.textContent = tr('源码', 'Source');
  }

  applyStaticLocaleText();
  const stopLocaleSync = onLocaleChange(() => {
    applyStaticLocaleText();
    if (latestState.visible) {
      update(latestState);
    }
  });

  function update(state: ToolbarRenderState): void {
    const wasVisible = !root.hidden;
    latestState = state;
    root.hidden = !state.visible;
    if (!state.visible) {
      return;
    }

    applyStaticLocaleText();
    drawerBtn.setAttribute('aria-expanded', String(state.drawerOpen));
    drawerBtn.classList.toggle('is-active', state.drawerOpen);

    const file = state.file;
    if (file) {
      fileBadge.hidden = false;
      fileBadge.dataset.kind = file.kind;
      fileBadge.textContent = formatKindBadge(file.kind, file.ext);
      renderTruncatableFileName(fileNameEl, file.name);
      fileNameEl.title = file.isLocalDrop
        ? tr(`${file.name}（本地拖拽文件）`, `${file.name} (Local dropped file)`)
        : file.path;
      largePdfBadge.hidden = !(
        (file.kind === 'pdf' || file.kind === 'mp4') &&
        (file.size ?? 0) > LARGE_PDF_THRESHOLD_BYTES
      );
      dropTag.hidden = !file.isLocalDrop;
    } else {
      fileBadge.hidden = true;
      delete fileBadge.dataset.kind;
      fileBadge.textContent = '';
      fileNameEl.textContent = tr('未选择文件', 'No file selected');
      fileNameEl.title = '';
      largePdfBadge.hidden = true;
      dropTag.hidden = true;
    }

    const isDiskFile = Boolean(file && !file.isLocalDrop);
    setButtonAriaDisabled(revealBtn, !isDiskFile);
    setButtonAriaDisabled(refreshBtn, !isDiskFile || state.loading);
    refreshIcon.classList.toggle('is-spinning', state.loading);

    setButtonAriaDisabled(autoRefreshBtn, !isDiskFile);
    const autoOn = isDiskFile && state.autoRefresh;
    autoRefreshBtn.setAttribute('aria-pressed', String(autoOn));
    autoRefreshBtn.classList.toggle('is-active', autoOn);
    autoRefreshBtn.title = isDiskFile
      ? tr('每 2.5 秒检查一次磁盘修改时间并自动刷新', 'Check file changes every 2.5s and auto-reload')
      : tr('拖拽的本地内存文件无磁盘路径，暂不支持自动监听刷新', 'Dropped local files have no disk path for auto-refresh');

    const showFormatRow = Boolean(file && !state.hasError && file.kind !== 'mp4');
    secondaryRow.hidden = !showFormatRow;
    if (!showFormatRow || !file) {
      pptGroup.hidden = true;
      wordGroup.hidden = true;
      htmlGroup.hidden = true;
      return;
    }

    const wasPptVisible = !pptGroup.hidden;
    const wasHtmlVisible = !htmlGroup.hidden;

    const isPaged = file.kind === 'ppt' || file.kind === 'pdf' || file.kind === 'excel';
    pptGroup.hidden = !isPaged;
    wordGroup.hidden = file.kind !== 'word';
    htmlGroup.hidden = file.kind !== 'html';

    if (isPaged) {
      updatePagedControls(state.preview, file.kind);
      if (!wasVisible || !wasPptVisible) {
        pptLayoutIndicator.update(true);
      }
    } else if (file.kind === 'word') {
      updateWordControls(state.preview);
    } else {
      updateHtmlControls(state.preview, file);
      if (!wasVisible || !wasHtmlVisible) {
        htmlModeIndicator.update(true);
      }
    }
  }

  function handleGlobalFindShortcut(e: KeyboardEvent): void {
    if (!latestState.visible || latestState.hasError || !latestState.file) return;
    if (e.defaultPrevented || isImeComposing(e)) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.key.toLowerCase() !== 'f') return;

    const kind = latestState.file.kind;
    let targetInput: HTMLInputElement | null = null;
    if (kind === 'ppt' || kind === 'pdf' || kind === 'excel') {
      targetInput = pptSearch.inputEl;
    } else if (kind === 'word') {
      targetInput = wordSearch.inputEl;
    }
    if (!targetInput) return;

    e.preventDefault();
    targetInput.focus();
    targetInput.select();
  }

  window.addEventListener('keydown', handleGlobalFindShortcut);

  function resetSearch(): void {
    pptSearch.reset();
    wordSearch.reset();
  }

  function destroy(): void {
    stopLocaleSync();
    stopPrimaryRoving();
    stopSecondaryRoving();
    pptLayoutIndicator.destroy();
    htmlModeIndicator.destroy();
    window.removeEventListener('keydown', handleGlobalFindShortcut);
    root.remove();
  }

  return {
    update,
    resetSearch,
    destroy,
  };
}
