import type { PreviewKind, WorkspaceFileItem } from '../types/preview';
import { onLocaleChange, tr } from '../utils/i18n';
import { createIcon } from '../utils/icons';
import { attachTablistKeyboard, renderTruncatableFileName } from '../utils/uiHelpers';

const LARGE_PDF_THRESHOLD_BYTES = 20 * 1024 * 1024;

export type BrowserKindFilter = 'all' | PreviewKind;

export interface WorkspaceBrowserState {
  mode: 'welcome' | 'drawer';
  files: WorkspaceFileItem[];
  loading: boolean;
  error: string | null;
  activePath: string | null;
}

export interface WorkspaceBrowserCallbacks {
  onOpenDiskFile: (path: string) => void;
  onOpenLocalFile: (file: File) => void;
  onRefreshList: () => void;
  onCloseDrawer?: () => void;
  onOpenAppearance?: (anchorEl: HTMLElement) => void;
}

export interface WorkspaceBrowserController {
  update: (state: WorkspaceBrowserState) => void;
  focusPathInput: () => void;
  destroy: () => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatModifiedTime(mtimeMs: number): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return '';
  const diff = Date.now() - mtimeMs;
  if (diff >= 0 && diff < 60_000) return tr('刚刚', 'Just now');
  if (diff >= 0 && diff < 3600_000) {
    const mins = Math.floor(diff / 60_000);
    return tr(`${mins} 分钟前`, `${mins}m ago`);
  }
  if (diff >= 0 && diff < 86400_000) {
    const hours = Math.floor(diff / 3600_000);
    return tr(`${hours} 小时前`, `${hours}h ago`);
  }

  const date = new Date(mtimeMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

function getKindShortLabel(kind: PreviewKind, ext: string): string {
  if (kind === 'ppt') return 'PPT';
  if (kind === 'word') return 'DOC';
  if (kind === 'excel') {
    const normalized = ext.toLowerCase();
    if (normalized === '.csv') return 'CSV';
    if (normalized === '.tsv') return 'TSV';
    if (normalized === '.xls') return 'XLS';
    return 'XLS';
  }
  if (kind === 'pdf') return 'PDF';
  if (kind === 'mp4') return ext.toLowerCase() === '.webm' ? 'WEBM' : 'MP4';
  if (kind === 'audio') {
    const normalized = ext.toLowerCase();
    if (normalized === '.wav') return 'WAV';
    if (normalized === '.m4a') return 'M4A';
    if (normalized === '.ogg') return 'OGG';
    if (normalized === '.flac') return 'FLAC';
    return 'MP3';
  }
  if (kind === 'image') {
    const normalized = ext.toLowerCase();
    if (normalized === '.png') return 'PNG';
    if (normalized === '.jpeg') return 'JPEG';
    if (normalized === '.webp') return 'WEBP';
    if (normalized === '.gif') return 'GIF';
    if (normalized === '.svg') return 'SVG';
    if (normalized === '.bmp') return 'BMP';
    if (normalized === '.ico') return 'ICO';
    if (normalized === '.avif') return 'AVIF';
    return 'JPG';
  }
  return ext.toLowerCase() === '.htm' ? 'HTM' : 'HTML';
}

/**
 * 创建工作区文档浏览器与欢迎页组件（四层无边框明度台阶体系，支持欢迎页与抽屉双模式）。
 */
export function createWorkspaceBrowser(
  container: HTMLElement,
  callbacks: WorkspaceBrowserCallbacks,
): WorkspaceBrowserController {
  let currentFilter: BrowserKindFilter = 'all';
  let currentKeyword = '';
  let latestState: WorkspaceBrowserState = {
    mode: 'welcome',
    files: [],
    loading: false,
    error: null,
    activePath: null,
  };

  const uidPrefix = `fp-wb-${Math.random().toString(36).slice(2, 7)}`;

  const root = document.createElement('div');
  root.className = 'fp-browser';

  // =========================================================================
  // 1. 欢迎页 Hero 概览卡片
  // =========================================================================
  const hero = document.createElement('section');
  hero.className = 'fp-hero fc-card fc-card--clip';

  // FlClash Material 3 Expressive Cookie-9 有机几何水印装饰
  const heroDeco = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  heroDeco.setAttribute('class', 'fp-hero__deco');
  heroDeco.setAttribute('viewBox', '0 0 100 100');
  heroDeco.setAttribute('aria-hidden', 'true');
  heroDeco.innerHTML =
    '<path fill="currentColor" d="M 43.14 5.67 Q 50.00 1.00 56.86 5.67 L 57.43 6.05 Q 64.30 10.72 72.55 11.56 L 73.24 11.63 Q 81.50 12.46 83.75 20.45 L 83.94 21.11 Q 86.20 29.10 91.99 35.05 L 92.47 35.54 Q 98.26 41.49 94.85 49.06 L 94.57 49.69 Q 91.16 57.26 91.77 65.53 L 91.83 66.22 Q 92.44 74.50 84.96 78.11 L 84.34 78.41 Q 76.87 82.02 72.02 88.75 L 71.61 89.31 Q 66.76 96.04 58.71 94.01 L 58.04 93.84 Q 50.00 91.80 41.96 93.84 L 41.29 94.01 Q 33.24 96.04 28.39 89.31 L 27.98 88.75 Q 23.13 82.02 15.66 78.41 L 15.04 78.11 Q 7.56 74.50 8.17 66.22 L 8.23 65.53 Q 8.84 57.26 5.43 49.69 L 5.15 49.06 Q 1.74 41.49 7.53 35.54 L 8.01 35.05 Q 13.80 29.10 16.06 21.11 L 16.25 20.45 Q 18.50 12.46 26.76 11.63 L 27.45 11.56 Q 35.70 10.72 42.57 6.05 Z"/>';

  const heroInner = document.createElement('div');
  heroInner.className = 'fp-hero__inner';

  const heroTopRow = document.createElement('div');
  heroTopRow.className = 'fp-hero__top';

  const heroBrand = document.createElement('div');
  heroBrand.className = 'fp-hero-brand';

  const logoWell = document.createElement('div');
  logoWell.className = 'fp-hero-logo-well';

  const logoImg = document.createElement('img');
  logoImg.src = '/assets/logo.svg';
  logoImg.alt = 'File Preview';
  logoImg.className = 'fp-hero-logo';
  const logoFallback = createIcon('fileText', 20);
  logoFallback.classList.add('fp-hero-logo-fallback');
  logoFallback.style.display = 'none';
  logoImg.addEventListener('error', () => {
    logoImg.hidden = true;
    logoFallback.style.display = '';
  });
  logoWell.append(logoImg, logoFallback);

  const heroTitleBox = document.createElement('div');
  heroTitleBox.className = 'fp-hero-title-box';
  const heroTitle = document.createElement('h1');
  heroTitle.className = 'fp-hero-title';
  heroTitle.textContent = 'File Preview';
  const heroSub = document.createElement('p');
  heroSub.className = 'fp-hero-subtitle';
  heroTitleBox.append(heroTitle, heroSub);

  heroBrand.append(logoWell, heroTitleBox);

  const heroActions = document.createElement('div');
  heroActions.className = 'fp-hero-actions';

  const heroAppearanceBtn = document.createElement('button');
  heroAppearanceBtn.type = 'button';
  heroAppearanceBtn.className = 'fp-btn fp-btn-tonal fp-btn-appearance';
  heroAppearanceBtn.setAttribute('aria-haspopup', 'dialog');
  heroAppearanceBtn.setAttribute('aria-expanded', 'false');
  heroAppearanceBtn.setAttribute('aria-controls', 'fp-appearance-popover');
  heroAppearanceBtn.appendChild(createIcon('palette', 15));
  const heroAppearanceDot = document.createElement('span');
  heroAppearanceDot.className = 'fp-appearance-dot';
  heroAppearanceDot.setAttribute('aria-hidden', 'true');
  heroAppearanceBtn.appendChild(heroAppearanceDot);
  heroAppearanceBtn.addEventListener('click', () => {
    callbacks.onOpenAppearance?.(heroAppearanceBtn);
  });

  heroActions.append(heroAppearanceBtn);
  heroTopRow.append(heroBrand, heroActions);

  const heroMetaRow = document.createElement('div');
  heroMetaRow.className = 'fp-hero-meta';

  const heroStatusChip = document.createElement('span');
  heroStatusChip.className = 'fc-chip fc-chip--ok fp-hero-status-chip';
  const heroStatusDot = document.createElement('span');
  heroStatusDot.className = 'fc-chip__dot';
  heroStatusDot.setAttribute('aria-hidden', 'true');
  const heroStatusText = document.createElement('span');
  heroStatusText.className = 'fc-tabular';
  heroStatusChip.append(heroStatusDot, heroStatusText);

  const heroFormatsText = document.createElement('span');
  heroFormatsText.className = 'fp-hero-formats';

  heroMetaRow.append(heroStatusChip, heroFormatsText);
  heroInner.append(heroTopRow, heroMetaRow);
  hero.append(heroDeco, heroInner);

  // =========================================================================
  // 2. 抽屉模式标题栏（仅在 drawer 模式显示）
  // =========================================================================
  const drawerHeader = document.createElement('div');
  drawerHeader.className = 'fp-drawer-header';

  const drawerTitleWrap = document.createElement('div');
  drawerTitleWrap.className = 'fp-drawer-title-wrap';
  const drawerTitle = document.createElement('h2');
  drawerTitle.className = 'fp-drawer-title';
  const drawerCountBadge = document.createElement('span');
  drawerCountBadge.className = 'fc-chip fc-tabular';
  drawerTitleWrap.append(drawerTitle, drawerCountBadge);

  const drawerCloseBtn = document.createElement('button');
  drawerCloseBtn.type = 'button';
  drawerCloseBtn.className = 'fc-icon-btn fc-icon-btn--tonal';
  drawerCloseBtn.appendChild(createIcon('close', 16));
  drawerCloseBtn.addEventListener('click', () => callbacks.onCloseDrawer?.());
  drawerHeader.append(drawerTitleWrap, drawerCloseBtn);

  // =========================================================================
  // 3. 快捷打开卡片（路径直达 + 本地选择与拖拽）
  // =========================================================================
  const quickOpenCard = document.createElement('section');
  quickOpenCard.className = 'fp-quick-open fc-card';

  const pathForm = document.createElement('form');
  pathForm.className = 'fp-path-form';

  const pathLabel = document.createElement('label');
  pathLabel.className = 'fc-sr-only';
  pathLabel.htmlFor = `${uidPrefix}-path-input`;

  const pathShell = document.createElement('div');
  pathShell.className = 'fp-path-shell';

  const pathInput = document.createElement('input');
  pathInput.id = `${uidPrefix}-path-input`;
  pathInput.type = 'text';
  pathInput.className = 'fp-input fp-path-input';

  const pathSubmitBtn = document.createElement('button');
  pathSubmitBtn.type = 'submit';
  pathSubmitBtn.className = 'fp-btn fp-btn-primary fp-path-submit';

  pathShell.append(pathInput, pathSubmitBtn);
  pathForm.append(pathLabel, pathShell);
  pathForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const target = pathInput.value.trim();
    if (!target) {
      pathInput.focus();
      return;
    }
    callbacks.onOpenDiskFile(target);
  });

  const localActionsRow = document.createElement('div');
  localActionsRow.className = 'fp-local-actions';

  const hiddenFileInput = document.createElement('input');
  hiddenFileInput.type = 'file';
  hiddenFileInput.accept = '.pptx,.docx,.xlsx,.xls,.csv,.tsv,.pdf,.mp4,.webm,.mp3,.wav,.m4a,.ogg,.flac,.jpg,.jpeg,.png,.webp,.gif,.svg,.bmp,.ico,.avif,.html,.htm';
  hiddenFileInput.hidden = true;
  hiddenFileInput.addEventListener('change', () => {
    const picked = hiddenFileInput.files?.[0];
    hiddenFileInput.value = '';
    if (picked) {
      callbacks.onOpenLocalFile(picked);
    }
  });

  const pickFileBtn = document.createElement('button');
  pickFileBtn.type = 'button';
  pickFileBtn.className = 'fp-btn fp-btn-tonal fp-pick-btn';
  pickFileBtn.appendChild(createIcon('upload', 14));
  const pickFileText = document.createElement('span');
  pickFileBtn.appendChild(pickFileText);
  pickFileBtn.addEventListener('click', () => hiddenFileInput.click());

  const dragTip = document.createElement('span');
  dragTip.className = 'fp-drag-tip';

  localActionsRow.append(hiddenFileInput, pickFileBtn, dragTip);
  quickOpenCard.append(pathForm, localActionsRow);

  // =========================================================================
  // 4. 工作区列表卡片（头部 + 筛选 Tablist + 搜索 + 分组文件行）
  // =========================================================================
  const listSection = document.createElement('section');
  listSection.className = 'fp-list-section fc-card';

  const listHeader = document.createElement('div');
  listHeader.className = 'fp-list-controls';

  const listTopBar = document.createElement('div');
  listTopBar.className = 'fp-list-topbar';

  const listTitleGroup = document.createElement('div');
  listTitleGroup.className = 'fp-list-title-group';
  const listTitleIcon = createIcon('folder', 16);
  listTitleIcon.classList.add('fc-card-header__icon');
  const listHeading = document.createElement('h2');
  listHeading.className = 'fc-card-header__title';
  const listCountPill = document.createElement('span');
  listCountPill.className = 'fc-chip fc-tabular fp-list-count-pill';
  listTitleGroup.append(listTitleIcon, listHeading, listCountPill);

  const refreshListBtn = document.createElement('button');
  refreshListBtn.type = 'button';
  refreshListBtn.className = 'fp-btn fp-btn-tonal fp-btn-compact';
  const refreshListIcon = createIcon('refresh', 14);
  const refreshListText = document.createElement('span');
  refreshListBtn.append(refreshListIcon, refreshListText);
  refreshListBtn.addEventListener('click', () => callbacks.onRefreshList());

  listTopBar.append(listTitleGroup, refreshListBtn);

  const filterTabs = document.createElement('div');
  filterTabs.className = 'fp-filter-tabs fc-tablist';
  filterTabs.setAttribute('role', 'tablist');

  const getFilterLabel = (key: BrowserKindFilter): string => {
    switch (key) {
      case 'all':
        return tr('全部', 'All');
      case 'ppt':
        return 'PPT';
      case 'word':
        return 'Word';
      case 'excel':
        return 'Excel';
      case 'pdf':
        return 'PDF';
      case 'mp4':
        return tr('视频', 'Video');
      case 'audio':
        return tr('音频', 'Audio');
      case 'image':
        return tr('图片', 'Image');
      case 'html':
        return 'HTML';
    }
  };

  const filterKeys: BrowserKindFilter[] = ['all', 'html', 'pdf', 'image', 'audio', 'word', 'excel', 'ppt', 'mp4'];
  const filterButtons = new Map<
    BrowserKindFilter,
    { btn: HTMLButtonElement; label: HTMLSpanElement; count: HTMLSpanElement }
  >();

  for (const key of filterKeys) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fc-tab';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(key === currentFilter));

    const labelSpan = document.createElement('span');
    labelSpan.textContent = getFilterLabel(key);
    const countSpan = document.createElement('span');
    countSpan.className = 'fc-tab__count';
    countSpan.textContent = '0';

    btn.append(labelSpan, countSpan);
    btn.addEventListener('click', () => {
      const changed = currentFilter !== key;
      currentFilter = key;
      btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      renderFileList();
      if (changed) {
        listBody.classList.remove('is-tab-switching');
        void listBody.offsetWidth;
        listBody.classList.add('is-tab-switching');
      }
    });
    filterButtons.set(key, { btn, label: labelSpan, count: countSpan });
    filterTabs.appendChild(btn);
  }

  const stopTablistKeyboard = attachTablistKeyboard(filterTabs);

  const searchWrap = document.createElement('div');
  searchWrap.className = 'fp-list-search-wrap';

  const searchLabel = document.createElement('label');
  searchLabel.className = 'fc-sr-only';
  searchLabel.htmlFor = `${uidPrefix}-filter-search`;

  const searchIcon = createIcon('search', 15);
  searchIcon.classList.add('fp-list-search-icon');

  const filterSearchInput = document.createElement('input');
  filterSearchInput.id = `${uidPrefix}-filter-search`;
  filterSearchInput.type = 'search';
  filterSearchInput.className = 'fp-input fp-list-search';
  filterSearchInput.addEventListener('input', () => {
    currentKeyword = filterSearchInput.value.trim().toLowerCase();
    renderFileList();
  });

  searchWrap.append(searchLabel, searchIcon, filterSearchInput);
  listHeader.append(listTopBar, filterTabs, searchWrap);

  const listBody = document.createElement('div');
  listBody.className = 'fp-file-list';

  listSection.append(listHeader, listBody);
  root.append(hero, drawerHeader, quickOpenCard, listSection);
  container.appendChild(root);

  function renderFilterCounts(): void {
    const counts: Record<BrowserKindFilter, number> = {
      all: latestState.files.length,
      ppt: 0,
      word: 0,
      excel: 0,
      pdf: 0,
      mp4: 0,
      audio: 0,
      image: 0,
      html: 0,
    };
    for (const file of latestState.files) {
      counts[file.kind] += 1;
    }
    listCountPill.textContent = String(counts.all);
    drawerCountBadge.textContent = String(counts.all);

    for (const key of filterKeys) {
      const entry = filterButtons.get(key);
      if (!entry) continue;
      entry.label.textContent = getFilterLabel(key);
      entry.count.textContent = String(counts[key]);
      const isSelected = currentFilter === key;
      entry.btn.setAttribute('aria-selected', String(isSelected));
      entry.btn.toggleAttribute('focusgroupstart', isSelected);
      entry.btn.classList.toggle('is-active', isSelected);
      if (!('focusGroup' in HTMLElement.prototype)) {
        entry.btn.tabIndex = isSelected ? 0 : -1;
      }
    }
  }

  function renderFileList(): void {
    renderFilterCounts();
    listBody.innerHTML = '';

    if (latestState.loading && latestState.files.length === 0) {
      const loadingEl = document.createElement('div');
      loadingEl.className = 'fp-list-empty';
      loadingEl.textContent = tr('正在扫描工作区可预览文档...', 'Scanning workspace for previewable files...');
      listBody.appendChild(loadingEl);
      return;
    }

    if (latestState.error) {
      const errEl = document.createElement('div');
      errEl.className = 'fp-list-error';
      errEl.textContent = latestState.error;
      listBody.appendChild(errEl);
      return;
    }

    const filtered = latestState.files.filter((file) => {
      if (currentFilter !== 'all' && file.kind !== currentFilter) {
        return false;
      }
      if (currentKeyword) {
        const hay = `${file.name} ${file.relPath}`.toLowerCase();
        if (!hay.includes(currentKeyword)) {
          return false;
        }
      }
      return true;
    });

    if (filtered.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'fp-list-empty';
      if (latestState.files.length === 0) {
        emptyEl.textContent = tr(
          '工作区暂未扫描到支持的文件，可使用上方路径直达或直接拖拽文件到窗口。',
          'No previewable files found in workspace. Paste a path above or drop a file here.',
        );
      } else {
        emptyEl.textContent = tr('没有符合当前筛选条件的文件。', 'No files match the current filter.');
      }
      listBody.appendChild(emptyEl);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const file of filtered) {
      const isCurrent = Boolean(latestState.activePath && latestState.activePath === file.path);

      const itemBtn = document.createElement('button');
      itemBtn.type = 'button';
      itemBtn.className = 'fp-file-item';
      if (isCurrent) {
        itemBtn.classList.add('is-current');
        itemBtn.setAttribute('aria-current', 'true');
      }
      itemBtn.title = file.path;
      itemBtn.addEventListener('click', () => callbacks.onOpenDiskFile(file.path));

      const glyphWell = document.createElement('span');
      glyphWell.className = 'fc-glyph-well fc-glyph-well--lg fp-file-glyph';
      glyphWell.dataset.kind = file.kind;
      glyphWell.textContent = getKindShortLabel(file.kind, file.ext);

      const info = document.createElement('div');
      info.className = 'fp-file-info';

      const nameRow = document.createElement('div');
      nameRow.className = 'fp-file-name-row';

      const nameEl = document.createElement('div');
      nameEl.className = 'fp-file-name';
      renderTruncatableFileName(nameEl, file.name);
      nameRow.appendChild(nameEl);

      if ((file.kind === 'pdf' || file.kind === 'mp4' || file.kind === 'audio') && file.size > LARGE_PDF_THRESHOLD_BYTES) {
        const largeBadge = document.createElement('span');
        largeBadge.className = 'fp-status-pill fp-status-pill--warn';
        largeBadge.textContent = tr('>20MB 流式', '>20MB Stream');
        nameRow.appendChild(largeBadge);
      }

      const metaEl = document.createElement('div');
      metaEl.className = 'fp-file-meta fc-tabular';
      const timeText = formatModifiedTime(file.mtimeMs);
      metaEl.textContent = timeText
        ? `${file.relPath} · ${formatBytes(file.size)} · ${timeText}`
        : `${file.relPath} · ${formatBytes(file.size)}`;

      info.append(nameRow, metaEl);
      itemBtn.append(glyphWell, info);

      if (isCurrent) {
        const selBadge = document.createElement('span');
        selBadge.className = 'fc-selection-badge';
        selBadge.setAttribute('aria-hidden', 'true');
        selBadge.appendChild(createIcon('check', 13, 2.5));
        itemBtn.appendChild(selBadge);
      }

      fragment.appendChild(itemBtn);
    }
    listBody.appendChild(fragment);
  }

  function applyLocaleText(): void {
    const appearanceTitle = tr('外观、明暗主题与语言设置', 'Appearance, theme & language');
    heroAppearanceBtn.title = appearanceTitle;
    heroAppearanceBtn.setAttribute('aria-label', appearanceTitle);

    heroSub.textContent = tr(
      '高保真侧边栏文档预览工作台',
      'High-fidelity sidebar document preview workspace',
    );

    if (latestState.loading) {
      heroStatusText.textContent = tr('扫描中...', 'Scanning...');
      heroStatusChip.className = 'fc-chip fp-hero-status-chip';
    } else {
      heroStatusText.textContent = tr(
        `${latestState.files.length} 个工作区文档`,
        `${latestState.files.length} workspace files`,
      );
      heroStatusChip.className = 'fc-chip fc-chip--ok fp-hero-status-chip';
    }
    heroFormatsText.textContent = 'PPTX · DOCX · XLSX · PDF · IMG · AUDIO · VIDEO · HTML';

    drawerTitle.textContent = tr('工作区文档', 'Workspace Files');
    const closeTitle = tr('关闭文件列表', 'Close file list');
    drawerCloseBtn.title = closeTitle;
    drawerCloseBtn.setAttribute('aria-label', closeTitle);

    const pathPlaceholder = tr(
      '输入文件路径或 file:// URI，回车打开...',
      'Enter file path or file:// URI...',
    );
    pathLabel.textContent = tr('输入本地文件路径', 'Enter local file path');
    pathInput.placeholder = pathPlaceholder;
    pathInput.setAttribute('aria-label', tr('输入本地文件路径', 'Enter local file path'));
    pathSubmitBtn.textContent = tr('打开', 'Open');

    pickFileText.textContent = tr('选择本地文件', 'Choose File');
    dragTip.textContent = tr(
      '或直接拖拽文件到此面板预览',
      'or drop a file anywhere here',
    );

    listHeading.textContent = tr('可预览文档', 'Documents');
    filterTabs.setAttribute('aria-label', tr('按文件类型筛选', 'Filter by document kind'));
    searchLabel.textContent = tr('筛选工作区文件', 'Filter workspace files');
    filterSearchInput.placeholder = tr('按文件名或路径筛选...', 'Filter by name or path...');
    filterSearchInput.setAttribute('aria-label', tr('筛选工作区文件', 'Filter workspace files'));

    refreshListText.textContent = latestState.loading
      ? tr('扫描中', 'Scanning')
      : tr('刷新', 'Refresh');
    refreshListBtn.title = tr('重新扫描工作区文件', 'Rescan workspace files');
    refreshListIcon.classList.toggle('is-spinning', latestState.loading);
  }

  applyLocaleText();
  const stopLocaleSync = onLocaleChange(() => {
    applyLocaleText();
    renderFileList();
  });

  function update(state: WorkspaceBrowserState): void {
    latestState = state;
    root.dataset.mode = state.mode;
    hero.hidden = state.mode !== 'welcome';
    hero.classList.toggle('is-scanning', state.loading);
    drawerHeader.hidden = state.mode !== 'drawer';
    listTopBar.hidden = state.mode === 'drawer';
    refreshListBtn.disabled = state.loading;
    applyLocaleText();
    renderFileList();
  }

  function focusPathInput(): void {
    pathInput.focus();
  }

  function destroy(): void {
    stopLocaleSync();
    stopTablistKeyboard();
    root.remove();
  }

  return {
    update,
    focusPathInput,
    destroy,
  };
}
