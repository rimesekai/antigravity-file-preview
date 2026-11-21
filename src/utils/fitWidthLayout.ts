/**
 * 文档“适应宽度”缩放与防滚动条震荡计算器：
 * - 严格扣除滚动容器自身水平内边距与安全余量，避免适应宽度模式下误触发横向滚动条；
 * - 结合容器外框尺寸（不随滚动条出现/消失而变化）与历史观测滚动条宽度，在缺失
 *   `scrollbar-gutter: stable` 支持或处于临界高度边界时自动锁定稳定缩放比，彻底阻断
 *   “无滚动条 → 放大溢出 → 出现滚动条 → 缩小不再溢出 → 滚动条消失”的死循环震荡。
 */

const DEFAULT_HORIZONTAL_SAFETY_PX = 4;
const DEFAULT_VERTICAL_TOLERANCE_PX = 2;
const MIN_CLASSIC_SCROLLBAR_PX = 4;
export const DEFAULT_FALLBACK_SCROLLBAR_WIDTH = 16;

export interface ScrollContainerBox {
  clientWidth: number;
  clientHeight: number;
  outerWidth: number;
  outerHeight: number;
  paddingX: number;
  paddingY: number;
}

export interface FitWidthMetrics {
  /** 滚动容器 clientWidth（含内边距，不含边框与已占位纵向滚动条） */
  viewportClientWidth: number;
  /** 滚动容器 clientHeight（含内边距，不含边框与已占位横向滚动条） */
  viewportClientHeight: number;
  /** 滚动容器不含边框的外部宽度（offsetWidth - borderX），不随滚动条显隐变化 */
  viewportOuterWidth: number;
  /** 滚动容器不含边框的外部高度（offsetHeight - borderY），不随横向滚动条显隐变化 */
  viewportOuterHeight: number;
  /** 滚动容器左右内边距之和（paddingLeft + paddingRight） */
  paddingX: number;
  /** 滚动容器上下内边距之和（paddingTop + paddingBottom） */
  paddingY: number;
  /** 内容之外的垂直额外占位（如 sizer 的 marginTop + marginBottom 或页间 gap） */
  extraVerticalSpace: number;
  /** 待适配内容的未缩放原始宽度 */
  rawWidth: number;
  /** 待适配内容的未缩放原始高度 */
  rawHeight: number;
  /** 此前观测到的经典纵向滚动条宽度（px）；0 表示尚未观测到或系统使用浮层滚动条 */
  observedScrollbarWidth: number;
  /** 缩放下限 */
  minScale: number;
  /** 缩放上限 */
  maxScale: number;
  /** 水平防亚像素溢出安全余量（px，默认 4） */
  horizontalSafetyPx?: number;
  /** 垂直临界高度容差（px，默认 2，吸收 HiDPI 亚像素取整误差） */
  verticalTolerancePx?: number;
  /** 可选缩放取整策略（默认向下截断至 4 位小数） */
  quantizeScale?: (scale: number) => number;
}

export interface FitWidthResult {
  /** 最终稳定缩放比 */
  scale: number;
  /** 缩放后内容宽度（px，整数） */
  scaledWidth: number;
  /** 缩放后内容高度（px，整数） */
  scaledHeight: number;
  /** 更新后的已观测纵向滚动条宽度（px） */
  observedScrollbarWidth: number;
  /** 本次是否启用了纵向滚动条预留回退路径 */
  reservedScrollbarGutter: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 向下截断至 4 位小数，避免浮点向上舍入导致缩放后宽度超出可用内容区 */
export function floorScalePrecision(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  return Math.floor(scale * 10000 + 1e-9) / 10000;
}

/** 向下截断至百分比精度（0.01），供 PDF 等按 1% 步进渲染的视图使用 */
export function floorZoomPercent(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  return Math.floor(scale * 100 + 1e-9) / 100;
}

/** 读取滚动容器的内外盒尺寸与内边距，兼容无 DOM/getComputedStyle 的轻量测试环境 */
export function measureScrollContainerBox(
  el: Pick<HTMLElement, 'clientWidth' | 'clientHeight' | 'offsetWidth' | 'offsetHeight'>,
  fallbackPaddingX = 0,
  fallbackPaddingY = 0,
): ScrollContainerBox {
  let padLeft = 0;
  let padRight = 0;
  let padTop = 0;
  let padBottom = 0;
  let borderLeft = 0;
  let borderRight = 0;
  let borderTop = 0;
  let borderBottom = 0;
  let hasComputedStyle = false;

  if (typeof getComputedStyle === 'function') {
    try {
      const cs = getComputedStyle(el as unknown as Element);
      if (cs) {
        hasComputedStyle = true;
        padLeft = Number.parseFloat(cs.paddingLeft) || 0;
        padRight = Number.parseFloat(cs.paddingRight) || 0;
        padTop = Number.parseFloat(cs.paddingTop) || 0;
        padBottom = Number.parseFloat(cs.paddingBottom) || 0;
        borderLeft = Number.parseFloat(cs.borderLeftWidth) || 0;
        borderRight = Number.parseFloat(cs.borderRightWidth) || 0;
        borderTop = Number.parseFloat(cs.borderTopWidth) || 0;
        borderBottom = Number.parseFloat(cs.borderBottomWidth) || 0;
      }
    } catch {
      // 忽略轻量测试替身触发的 getComputedStyle 异常
    }
  }

  const clientWidth = Math.max(0, el.clientWidth || 0);
  const clientHeight = Math.max(0, el.clientHeight || 0);
  const rawOffsetW = typeof el.offsetWidth === 'number' && el.offsetWidth > 0 ? el.offsetWidth : clientWidth;
  const rawOffsetH = typeof el.offsetHeight === 'number' && el.offsetHeight > 0 ? el.offsetHeight : clientHeight;

  return {
    clientWidth,
    clientHeight,
    outerWidth: Math.max(clientWidth, rawOffsetW - borderLeft - borderRight),
    outerHeight: Math.max(clientHeight, rawOffsetH - borderTop - borderBottom),
    paddingX: hasComputedStyle ? padLeft + padRight : Math.max(0, fallbackPaddingX),
    paddingY: hasComputedStyle ? padTop + padBottom : Math.max(0, fallbackPaddingY),
  };
}

/** 读取元素上下外边距之和（marginTop + marginBottom） */
export function measureVerticalMargins(el: Element, fallback = 0): number {
  if (typeof getComputedStyle === 'function') {
    try {
      const cs = getComputedStyle(el);
      if (cs) {
        const mt = Number.parseFloat(cs.marginTop) || 0;
        const mb = Number.parseFloat(cs.marginBottom) || 0;
        return Math.max(0, mt + mb);
      }
    } catch {
      // 忽略非标准节点异常
    }
  }
  return Math.max(0, fallback);
}

/**
 * 计算稳定的“适应宽度”缩放结果：
 * 1. 当容器已由 `scrollbar-gutter: stable` 或当前可见滚动条预留了纵向滚动条槽时，直接基于 `clientWidth` 计算；
 * 2. 当浏览器不支持 `scrollbar-gutter: stable` 且当前未显示纵向滚动条时，先试算全宽缩放；若试算高度
 *    超过可视区高度（或逼近临界容差）且已知经典滚动条宽度，则主动扣除滚动条宽度求解，确保单步收敛无震荡。
 */
export function computeFitWidthLayout(metrics: FitWidthMetrics): FitWidthResult {
  const safety = Math.max(0, metrics.horizontalSafetyPx ?? DEFAULT_HORIZONTAL_SAFETY_PX);
  const verticalTol = Math.max(0, metrics.verticalTolerancePx ?? DEFAULT_VERTICAL_TOLERANCE_PX);
  const quantize = metrics.quantizeScale ?? floorScalePrecision;

  const padX = Math.max(0, metrics.paddingX);
  const padY = Math.max(0, metrics.paddingY);
  const extraV = Math.max(0, metrics.extraVerticalSpace);
  const outerW = Math.max(metrics.viewportClientWidth, metrics.viewportOuterWidth);
  const outerH = Math.max(metrics.viewportClientHeight, metrics.viewportOuterHeight);

  // 忽略 1~3px 的 HiDPI 亚像素取整差值，仅将 >= 4px 的差值识别为真实经典布局滚动条
  const rawScrollbarDiff = Math.round(outerW - metrics.viewportClientWidth);
  const currentScrollbarW = rawScrollbarDiff >= MIN_CLASSIC_SCROLLBAR_PX ? rawScrollbarDiff : 0;
  const nextObservedScrollbarW =
    currentScrollbarW > 0
      ? currentScrollbarW
      : Math.max(0, Math.round(metrics.observedScrollbarWidth));

  const solveForClientWidth = (clientW: number) => {
    const innerW = Math.max(0, clientW - padX);
    const availW = Math.max(0, innerW - safety);
    const rawScale = metrics.rawWidth > 0 ? availW / metrics.rawWidth : 1;
    const scale = clamp(quantize(rawScale), metrics.minScale, metrics.maxScale);
    const scaledWidth = Math.max(1, Math.ceil(metrics.rawWidth * scale));
    const scaledHeight = Math.max(1, Math.ceil(metrics.rawHeight * scale));
    return { scale, scaledWidth, scaledHeight };
  };

  if (currentScrollbarW > 0) {
    const solved = solveForClientWidth(metrics.viewportClientWidth);
    return {
      ...solved,
      observedScrollbarWidth: nextObservedScrollbarW,
      reservedScrollbarGutter: false,
    };
  }

  const full = solveForClientWidth(metrics.viewportClientWidth);
  const availH = Math.max(0, Math.min(metrics.viewportClientHeight, outerH) - padY);
  const wouldOverflowVertically =
    metrics.rawHeight > 0 &&
    availH > 0 &&
    full.scaledHeight + extraV > availH - verticalTol;

  if (wouldOverflowVertically) {
    const predictedW = nextObservedScrollbarW > 0 ? nextObservedScrollbarW : DEFAULT_FALLBACK_SCROLLBAR_WIDTH;
    const reservedClientW = Math.max(0, outerW - predictedW);
    const reserved = solveForClientWidth(reservedClientW);
    return {
      ...reserved,
      observedScrollbarWidth: predictedW,
      reservedScrollbarGutter: true,
    };
  }

  return {
    ...full,
    observedScrollbarWidth: nextObservedScrollbarW,
    reservedScrollbarGutter: false,
  };
}
