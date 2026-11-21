import { attachLiquidGlass, refreshLiquidGlass } from '../services/liquidGlass';
import {
  SEED_PRESETS,
  type ColorStyle,
  type SeedId,
  type ThemePreference,
  getAppearancePrefs,
  getThemePreference,
  setThemePreference,
  subscribeAppearanceChanges,
  updateAppearancePrefs,
} from '../services/themeSync';
import {
  type LocalePreference,
  getLocalePreference,
  onLocaleChange,
  setLocalePreference,
  tr,
} from '../utils/i18n';
import { createIcon } from '../utils/icons';
import { attachSegmentedIndicator } from '../utils/uiHelpers';

export interface AppearancePopoverController {
  toggle: (anchorEl: HTMLElement) => void;
  close: () => void;
  isOpen: () => boolean;
  destroy: () => void;
}

const SUPPORTS_POPOVER =
  typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'popover');

/**
 * 创建 FlClash 风格的外观与主题设置弹出面板：
 * - 三联迷你屏幕主题模式选择器（跟随宿主 / 浅色 / 深色）
 * - 种子色板（默认浅蓝深琥珀自动配对 + 6 套预设色）
 * - 色彩衍生风格（鲜明 / 微染 / 柔彩 / 极简）
 * - OLED 纯黑深色与 Liquid Glass 液态毛玻璃开关
 * - 界面语言三段选择（自动 / 中文 / EN）
 */
export function createAppearancePopover(hostEl: HTMLElement = document.body): AppearancePopoverController {
  const panelEl = document.createElement('div');
  panelEl.className = 'fp-appearance-popover';
  panelEl.id = 'fp-appearance-popover';
  panelEl.setAttribute('role', 'dialog');
  panelEl.setAttribute('aria-modal', 'false');

  if (SUPPORTS_POPOVER) {
    panelEl.setAttribute('popover', 'auto');
  } else {
    panelEl.hidden = true;
  }

  // 头部
  const headerEl = document.createElement('div');
  headerEl.className = 'fp-pop-header';
  const titleEl = document.createElement('h3');
  titleEl.className = 'fp-pop-title';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'fp-icon-btn';
  closeBtn.appendChild(createIcon('close', 15));
  headerEl.append(titleEl, closeBtn);

  // 1. 主题模式三联迷你屏幕
  const themeSection = document.createElement('section');
  themeSection.className = 'fp-pop-section';
  const themeLabel = document.createElement('div');
  themeLabel.className = 'fp-pop-label';

  const themeGrid = document.createElement('div');
  themeGrid.className = 'fp-theme-previews';

  const themeButtons = new Map<ThemePreference, HTMLButtonElement>();
  const themeTextEls = new Map<ThemePreference, HTMLSpanElement>();

  function buildMiniScreenButton(mode: ThemePreference): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fc-mini-screen-btn';
    btn.addEventListener('click', () => {
      setThemePreference(mode);
    });

    const screen = document.createElement('div');
    screen.className = 'fc-mini-screen';
    screen.setAttribute('aria-hidden', 'true');

    if (mode === 'auto') {
      const left = document.createElement('div');
      left.className = 'fc-mini-screen__half fc-mini-screen__half--light';
      left.innerHTML = '<div class="fc-mini-screen__bar"></div><div class="fc-mini-screen__card"></div>';
      const right = document.createElement('div');
      right.className = 'fc-mini-screen__half fc-mini-screen__half--dark';
      right.innerHTML = '<div class="fc-mini-screen__bar"></div><div class="fc-mini-screen__card"></div>';
      screen.append(left, right);
    } else {
      const full = document.createElement('div');
      full.className = `fc-mini-screen__half fc-mini-screen__half--${mode}`;
      full.innerHTML = '<div class="fc-mini-screen__bar"></div><div class="fc-mini-screen__card"></div>';
      screen.appendChild(full);
    }

    const labelSpan = document.createElement('span');
    labelSpan.className = 'fc-mini-screen-label';

    btn.append(screen, labelSpan);
    themeButtons.set(mode, btn);
    themeTextEls.set(mode, labelSpan);
    return btn;
  }

  themeGrid.append(
    buildMiniScreenButton('auto'),
    buildMiniScreenButton('light'),
    buildMiniScreenButton('dark'),
  );
  themeSection.append(themeLabel, themeGrid);

  // 2. 种子主题色
  const seedSection = document.createElement('section');
  seedSection.className = 'fp-pop-section';
  const seedLabel = document.createElement('div');
  seedLabel.className = 'fp-pop-label';

  const swatchRow = document.createElement('div');
  swatchRow.className = 'fc-swatch-row';

  const seedButtons = new Map<SeedId, HTMLButtonElement>();

  // Auto-pair 双拼徽章
  const autoSeedBtn = document.createElement('button');
  autoSeedBtn.type = 'button';
  autoSeedBtn.className = 'fc-swatch fc-swatch--autopair';
  autoSeedBtn.style.background = 'linear-gradient(135deg, #0A7AFF 50%, #F59E3D 50%)';
  const autoCheck = createIcon('check', 14, 2.4);
  autoSeedBtn.appendChild(autoCheck);
  autoSeedBtn.addEventListener('click', () => {
    updateAppearancePrefs({ seedId: 'auto-pair' });
  });
  seedButtons.set('auto-pair', autoSeedBtn);
  swatchRow.appendChild(autoSeedBtn);

  for (const preset of SEED_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fc-swatch';
    btn.style.backgroundColor = preset.hex;
    btn.appendChild(createIcon('check', 14, 2.4));
    btn.addEventListener('click', () => {
      updateAppearancePrefs({ seedId: preset.id });
    });
    seedButtons.set(preset.id, btn);
    swatchRow.appendChild(btn);
  }
  seedSection.append(seedLabel, swatchRow);

  // 3. 色彩衍生风格
  const styleSection = document.createElement('section');
  styleSection.className = 'fp-pop-section';
  const styleLabel = document.createElement('div');
  styleLabel.className = 'fp-pop-label';

  const styleSeg = document.createElement('div');
  styleSeg.className = 'fc-segmented fc-segmented--compact';
  const styleKeys: ColorStyle[] = ['vivid', 'tinted', 'soft', 'monochrome'];
  const styleButtons = new Map<ColorStyle, HTMLButtonElement>();
  for (const styleKey of styleKeys) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fc-segmented__btn';
    btn.addEventListener('click', () => {
      updateAppearancePrefs({ colorStyle: styleKey });
    });
    styleButtons.set(styleKey, btn);
    styleSeg.appendChild(btn);
  }
  styleSection.append(styleLabel, styleSeg);

  // 4. 视觉开关列表行（纯黑 OLED / Liquid Glass）
  const togglesGroup = document.createElement('div');
  togglesGroup.className = 'fp-pop-switches';

  function buildSwitchRow(
    id: string,
    onChange: (checked: boolean) => void,
  ): {
    row: HTMLLabelElement;
    title: HTMLSpanElement;
    sub: HTMLSpanElement;
    input: HTMLInputElement;
  } {
    const row = document.createElement('label');
    row.className = 'fp-pop-switch-row';
    row.htmlFor = id;

    const textCol = document.createElement('span');
    textCol.className = 'fp-pop-switch-text';
    const title = document.createElement('span');
    title.className = 'fp-pop-switch-title';
    const sub = document.createElement('span');
    sub.className = 'fp-pop-switch-sub';
    textCol.append(title, sub);

    const switchWrap = document.createElement('span');
    switchWrap.className = 'fc-switch fc-switch--sm';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.setAttribute('switch', '');
    input.addEventListener('change', () => onChange(input.checked));
    switchWrap.appendChild(input);

    row.append(textCol, switchWrap);
    return { row, title, sub, input };
  }

  const pureBlackCtrl = buildSwitchRow('fp-pref-pure-black', (checked) => {
    updateAppearancePrefs({ pureBlack: checked });
  });
  const glassCtrl = buildSwitchRow('fp-pref-liquid-glass', (checked) => {
    updateAppearancePrefs({ liquidGlass: checked });
  });

  togglesGroup.append(pureBlackCtrl.row, glassCtrl.row);

  // 5. 界面语言分段控制
  const langSection = document.createElement('section');
  langSection.className = 'fp-pop-section';
  const langLabel = document.createElement('div');
  langLabel.className = 'fp-pop-label';

  const langSeg = document.createElement('div');
  langSeg.className = 'fc-segmented fc-segmented--compact';
  const langKeys: LocalePreference[] = ['auto', 'zh', 'en'];
  const langButtons = new Map<LocalePreference, HTMLButtonElement>();
  for (const key of langKeys) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fc-segmented__btn';
    btn.addEventListener('click', () => {
      setLocalePreference(key);
    });
    langButtons.set(key, btn);
    langSeg.appendChild(btn);
  }
  langSection.append(langLabel, langSeg);

  panelEl.append(headerEl, themeSection, seedSection, styleSection, togglesGroup, langSection);
  hostEl.appendChild(panelEl);

  const detachGlass = attachLiquidGlass(panelEl, 'menu');
  const styleIndicator = attachSegmentedIndicator(styleSeg);
  const langIndicator = attachSegmentedIndicator(langSeg);

  let currentAnchor: HTMLElement | null = null;
  let manualOpen = false;
  let destroyed = false;

  function syncState(): void {
    const themePref = getThemePreference();
    const prefs = getAppearancePrefs();
    const localePref = getLocalePreference();

    titleEl.textContent = tr('外观与主题', 'Appearance');
    panelEl.setAttribute('aria-label', tr('外观与主题设置', 'Appearance & theme settings'));
    closeBtn.title = tr('关闭设置', 'Close');
    closeBtn.setAttribute('aria-label', tr('关闭外观设置', 'Close appearance settings'));

    themeLabel.textContent = tr('明暗模式', 'Theme Mode');
    themeTextEls.get('auto')!.textContent = tr('跟随宿主', 'Auto');
    themeTextEls.get('light')!.textContent = tr('浅色', 'Light');
    themeTextEls.get('dark')!.textContent = tr('深色', 'Dark');
    for (const [key, btn] of themeButtons.entries()) {
      btn.setAttribute('aria-pressed', String(themePref === key));
    }

    seedLabel.textContent = tr('强调色种子', 'Accent Seed');
    autoSeedBtn.title = tr('自动配对（浅蓝 / 深琥珀）', 'Auto Pair (Azure / Amber)');
    autoSeedBtn.setAttribute('aria-label', tr('自动配对强调色', 'Auto Pair Accent'));
    autoSeedBtn.setAttribute('aria-pressed', String(prefs.seedId === 'auto-pair'));
    for (const preset of SEED_PRESETS) {
      const btn = seedButtons.get(preset.id);
      if (!btn) continue;
      const name = tr(preset.nameZh, preset.nameEn);
      btn.title = name;
      btn.setAttribute('aria-label', name);
      btn.setAttribute('aria-pressed', String(prefs.seedId === preset.id));
    }

    styleLabel.textContent = tr('表面色彩风格', 'Color Style');
    styleButtons.get('vivid')!.textContent = tr('鲜明', 'Vivid');
    styleButtons.get('tinted')!.textContent = tr('微染', 'Tinted');
    styleButtons.get('soft')!.textContent = tr('柔彩', 'Soft');
    styleButtons.get('monochrome')!.textContent = tr('极简', 'Mono');
    for (const [key, btn] of styleButtons.entries()) {
      btn.setAttribute('aria-pressed', String(prefs.colorStyle === key));
    }

    pureBlackCtrl.title.textContent = tr('纯黑深色 (OLED)', 'Pure Black Dark');
    pureBlackCtrl.sub.textContent = tr('深色模式下采用纯黑底色', 'True black background in dark mode');
    pureBlackCtrl.input.checked = prefs.pureBlack;

    glassCtrl.title.textContent = tr('Liquid Glass 浮层', 'Liquid Glass');
    glassCtrl.sub.textContent = tr('工具条与提示浮层启用毛玻璃', 'Translucent glass floating surfaces');
    glassCtrl.input.checked = prefs.liquidGlass;

    langLabel.textContent = tr('界面语言', 'Language');
    langButtons.get('auto')!.textContent = tr('跟随系统', 'Auto');
    langButtons.get('zh')!.textContent = '简体中文';
    langButtons.get('en')!.textContent = 'English';
    for (const [key, btn] of langButtons.entries()) {
      btn.setAttribute('aria-pressed', String(localePref === key));
    }
  }

  function positionNearAnchor(anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 8;
    const edgeMargin = 10;

    // 先测量面板尺寸
    const panelWidth = Math.min(316, Math.max(240, vw - edgeMargin * 2));
    panelEl.style.width = `${panelWidth}px`;
    const panelRect = panelEl.getBoundingClientRect();
    const panelHeight = panelRect.height || 390;

    const spaceBelow = vh - rect.bottom - edgeMargin;
    const spaceAbove = rect.top - edgeMargin;
    const openAbove = spaceBelow < panelHeight + gap && spaceAbove > spaceBelow;

    let top = openAbove ? rect.top - panelHeight - gap : rect.bottom + gap;
    top = Math.max(edgeMargin, Math.min(top, Math.max(edgeMargin, vh - panelHeight - edgeMargin)));

    let left = rect.right - panelWidth;
    left = Math.max(edgeMargin, Math.min(left, Math.max(edgeMargin, vw - panelWidth - edgeMargin)));

    panelEl.style.top = `${Math.round(top)}px`;
    panelEl.style.left = `${Math.round(left)}px`;

    // 对齐触发按钮方向作为缩放弹出原点（遵循 natural-interactions 指南）
    const anchorCenterX = rect.left + rect.width / 2;
    const originX = Math.max(20, Math.min(panelWidth - 20, anchorCenterX - left));
    panelEl.style.transformOrigin = `${Math.round(originX)}px ${openAbove ? 'bottom' : 'top'}`;
    panelEl.dataset.openDirection = openAbove ? 'up' : 'down';
  }

  function isOpen(): boolean {
    if (SUPPORTS_POPOVER) {
      return panelEl.matches(':popover-open');
    }
    return manualOpen && !panelEl.hidden;
  }

  function close(): void {
    if (!isOpen()) return;
    if (SUPPORTS_POPOVER) {
      try {
        panelEl.hidePopover();
      } catch {
        // 忽略已关闭状态异常
      }
    } else {
      manualOpen = false;
      panelEl.hidden = true;
    }
    currentAnchor?.setAttribute('aria-expanded', 'false');
    currentAnchor = null;
  }

  function open(anchor: HTMLElement): void {
    syncState();
    if (currentAnchor && currentAnchor !== anchor) {
      currentAnchor.setAttribute('aria-expanded', 'false');
    }
    currentAnchor = anchor;
    currentAnchor.setAttribute('aria-expanded', 'true');

    if (SUPPORTS_POPOVER) {
      if (!panelEl.matches(':popover-open')) {
        panelEl.showPopover();
      }
    } else {
      manualOpen = true;
      panelEl.hidden = false;
    }
    positionNearAnchor(anchor);
    styleIndicator.update(true);
    langIndicator.update(true);
    refreshLiquidGlass(panelEl);
  }

  function toggle(anchorEl: HTMLElement): void {
    if (destroyed) return;
    if (isOpen() && currentAnchor === anchorEl) {
      close();
      return;
    }
    open(anchorEl);
  }

  closeBtn.addEventListener('click', () => {
    const restore = currentAnchor;
    close();
    restore?.focus();
  });

  const handleToggleEvent = (event: Event) => {
    const toggleEvent = event as ToggleEvent;
    if (toggleEvent.newState === 'closed') {
      currentAnchor?.setAttribute('aria-expanded', 'false');
      currentAnchor = null;
    }
  };

  const handleDocumentPointerDown = (event: PointerEvent) => {
    if (SUPPORTS_POPOVER || !isOpen()) return;
    const target = event.target as Node | null;
    if (!target) return;
    if (panelEl.contains(target) || currentAnchor?.contains(target)) return;
    close();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && isOpen()) {
      const restore = currentAnchor;
      close();
      restore?.focus();
    }
  };

  const handleResize = () => {
    if (isOpen() && currentAnchor) {
      positionNearAnchor(currentAnchor);
    }
  };

  if (SUPPORTS_POPOVER) {
    panelEl.addEventListener('toggle', handleToggleEvent);
  } else {
    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
  }
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('resize', handleResize);

  const stopAppearanceSync = subscribeAppearanceChanges(() => syncState());
  const stopLocaleSync = onLocaleChange(() => syncState());
  syncState();

  return {
    toggle,
    close,
    isOpen,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      stopAppearanceSync();
      stopLocaleSync();
      if (SUPPORTS_POPOVER) {
        panelEl.removeEventListener('toggle', handleToggleEvent);
      } else {
        document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      }
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
      styleIndicator.destroy();
      langIndicator.destroy();
      detachGlass();
      panelEl.remove();
    },
  };
}
