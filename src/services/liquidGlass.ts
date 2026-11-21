/**
 * FlClash Liquid Glass Optical Filter Generator (TypeScript Web Engine)
 * 移植自 D:/ui-resources/flclash-ui/js/liquid-glass.js：
 * - 边缘圆形倒角折射剖面：depth = depthMax * (1 - sqrt(1 - rise^2))
 * - 凸透镜外凸折射剖面（lens）：rimBand + edgePush
 * - RGB 三通道差异位移实现边缘棱镜色散（中心 0 位移，边缘自动分色）
 * - 自动绑定跟手交互辉光（--fc-gx / --fc-gy）与 data-liquid-glass="true" 全局联动
 */

export type LiquidGlassPreset = 'regular' | 'pill' | 'menu' | 'tinted' | 'lens';

export interface LiquidGlassOptions {
  bevel?: number;
  refraction?: number;
  dispersion?: number;
  lens?: boolean;
}

interface ResolvedGlassOptions {
  bevel: number;
  refraction: number;
  dispersion: number;
  lens: boolean;
}

interface TrackedGlassMeta {
  filterId: string;
  preset: LiquidGlassPreset;
  opts: ResolvedGlassOptions;
  lastKey: string;
  cleanupPointer: () => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

const PRESETS: Record<LiquidGlassPreset, ResolvedGlassOptions> = {
  regular: { bevel: 18, refraction: 22, dispersion: 0.14, lens: false },
  pill: { bevel: 20, refraction: 26, dispersion: 0.16, lens: false },
  menu: { bevel: 18, refraction: 16, dispersion: 0.08, lens: false },
  tinted: { bevel: 16, refraction: 18, dispersion: 0.1, lens: false },
  lens: { bevel: 24, refraction: 34, dispersion: 0.24, lens: true },
};

const PRESET_CLASSES: readonly string[] = [
  'fc-glass--regular',
  'fc-glass--pill',
  'fc-glass--menu',
  'fc-glass--tinted',
  'fc-glass--lens',
];

let svgDefs: SVGDefsElement | null = null;
let idCounter = 0;

/**
 * 仅在 Chromium/Blink 引擎启用 SVG backdrop-filter 位移映射（Safari/Firefox 暂不支持 url() 作为 backdrop-filter）。
 */
export const supportsOpticalRefraction: boolean = (() => {
  if (typeof window === 'undefined' || typeof CSS === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isChromium = /Chrome|Chromium|Edg\//.test(ua) && !/Firefox/.test(ua);
  return isChromium && CSS.supports('backdrop-filter', 'blur(1px)');
})();

const reducedMotionMedia =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

function isLiquidGlassEnabled(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.dataset.liquidGlass === 'true';
}

function ensureSvgHost(): SVGDefsElement {
  if (svgDefs && svgDefs.isConnected) return svgDefs;
  const existing = document.getElementById('fc-liquid-glass-defs-host');
  if (existing) {
    const existingDefs = existing.querySelector('defs');
    if (existingDefs) {
      svgDefs = existingDefs;
      return svgDefs;
    }
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('id', 'fc-liquid-glass-defs-host');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText =
    'position:fixed;left:-9999px;top:-9999px;width:0;height:0;pointer-events:none;';
  const defs = document.createElementNS(SVG_NS, 'defs');
  svg.appendChild(defs);
  document.body.appendChild(svg);
  svgDefs = defs;
  return defs;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, 1e-4), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * 复刻 liquid_glass.frag 中的圆角矩形有向距离与外法线。
 */
function roundedBoxDistanceAndNormal(
  px: number,
  py: number,
  hx: number,
  hy: number,
  radius: number,
): { inset: number; nx: number; ny: number } {
  const ax = Math.abs(px);
  const ay = Math.abs(py);
  const qx = ax - hx + radius;
  const qy = ay - hy + radius;
  const mx = Math.max(qx, 0);
  const my = Math.max(qy, 0);
  const dist = Math.hypot(mx, my) + Math.min(Math.max(qx, qy), 0) - radius;

  let nx = 0;
  let ny = 0;
  if (qx > 0 && qy > 0) {
    const len = Math.hypot(qx, qy) || 1;
    nx = qx / len;
    ny = qy / len;
  } else if (qx > qy) {
    nx = 1;
    ny = 0;
  } else {
    nx = 0;
    ny = 1;
  }

  return {
    inset: Math.max(-dist, 0),
    nx: px < 0 ? -nx : nx,
    ny: py < 0 ? -ny : ny,
  };
}

/**
 * 生成光学折射位移贴图 Data URL（R 通道 = X 偏移，G 通道 = Y 偏移）。
 * 对超大浮层按比例下采样至最长边不超过 240px，保持亚毫秒级计算开销。
 */
function buildDisplacementMap(
  width: number,
  height: number,
  radius: number,
  opts: ResolvedGlassOptions,
): { dataUrl: string; scale: number } {
  const maxDim = Math.max(width, height);
  const mapScale = maxDim > 240 ? 240 / maxDim : 1;
  const w = Math.max(24, Math.round(width * mapScale));
  const h = Math.max(24, Math.round(height * mapScale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { dataUrl: '', scale: 0 };
  }

  const img = ctx.createImageData(w, h);
  const data = img.data;

  const hx = w * 0.5;
  const hy = h * 0.5;
  const halfMinor = Math.min(hx, hy);
  const r = Math.min(radius * mapScale, halfMinor);
  const bevel = Math.max(Math.min(opts.bevel * mapScale, halfMinor * 0.65), 2);
  const maxShift = Math.max(opts.refraction, 1);
  const scale = maxShift * 2;

  for (let y = 0; y < h; y++) {
    const py = y + 0.5 - hy;
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hx;
      const { inset, nx, ny } = roundedBoxDistanceAndNormal(px, py, hx, hy, r);

      let sx = 0;
      let sy = 0;
      if (inset > 0) {
        if (opts.lens) {
          const rimBand =
            smoothstep(0, bevel * 0.65, inset) *
            (1 - smoothstep(bevel * 0.65, halfMinor * 0.95, inset));
          const edgePush =
            1 - Math.sqrt(Math.max(0, 1 - Math.pow(1 - clamp(inset / bevel, 0, 1), 2)));
          const mag = maxShift * (0.45 * rimBand + 0.55 * edgePush);
          sx = -nx * mag;
          sy = -ny * mag;
        } else {
          const rise = 1 - clamp(inset / bevel, 0, 1);
          const depth = maxShift * (1 - Math.sqrt(Math.max(0, 1 - rise * rise)));
          sx = -nx * depth;
          sy = -ny * depth;
        }
      }

      const idx = (y * w + x) * 4;
      data[idx] = clamp(Math.round(127.5 + (sx / scale) * 255), 0, 255);
      data[idx + 1] = clamp(Math.round(127.5 + (sy / scale) * 255), 0, 255);
      data[idx + 2] = 128;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  return { dataUrl: canvas.toDataURL('image/png'), scale };
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  return node;
}

function upsertSvgFilter(
  filterId: string,
  mapUrl: string,
  scale: number,
  dispersion: number,
): void {
  const defs = ensureSvgHost();
  let filter = document.getElementById(filterId) as SVGFilterElement | null;
  if (!filter) {
    filter = svgEl('filter', { id: filterId });
    defs.appendChild(filter);
  }

  filter.setAttribute('x', '0%');
  filter.setAttribute('y', '0%');
  filter.setAttribute('width', '100%');
  filter.setAttribute('height', '100%');
  filter.setAttribute('filterUnits', 'objectBoundingBox');
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  filter.replaceChildren();

  const feImg = svgEl('feImage', {
    href: mapUrl,
    x: '0%',
    y: '0%',
    width: '100%',
    height: '100%',
    preserveAspectRatio: 'none',
    result: 'fcMap',
  });
  feImg.setAttributeNS(XLINK_NS, 'xlink:href', mapUrl);
  filter.appendChild(feImg);

  const disp = clamp(dispersion || 0, 0, 0.35);
  const scaleR = (scale * (1 + disp)).toFixed(2);
  const scaleG = scale.toFixed(2);
  const scaleB = (scale * (1 - disp)).toFixed(2);

  if (disp > 0.01) {
    filter.appendChild(
      svgEl('feDisplacementMap', {
        in: 'SourceGraphic',
        in2: 'fcMap',
        scale: scaleR,
        xChannelSelector: 'R',
        yChannelSelector: 'G',
        result: 'dispR',
      }),
    );
    filter.appendChild(
      svgEl('feColorMatrix', {
        in: 'dispR',
        type: 'matrix',
        values: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
        result: 'onlyR',
      }),
    );

    filter.appendChild(
      svgEl('feDisplacementMap', {
        in: 'SourceGraphic',
        in2: 'fcMap',
        scale: scaleG,
        xChannelSelector: 'R',
        yChannelSelector: 'G',
        result: 'dispG',
      }),
    );
    filter.appendChild(
      svgEl('feColorMatrix', {
        in: 'dispG',
        type: 'matrix',
        values: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
        result: 'onlyG',
      }),
    );

    filter.appendChild(
      svgEl('feDisplacementMap', {
        in: 'SourceGraphic',
        in2: 'fcMap',
        scale: scaleB,
        xChannelSelector: 'R',
        yChannelSelector: 'G',
        result: 'dispB',
      }),
    );
    filter.appendChild(
      svgEl('feColorMatrix', {
        in: 'dispB',
        type: 'matrix',
        values: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0',
        result: 'onlyB',
      }),
    );

    filter.appendChild(
      svgEl('feBlend', {
        in: 'onlyR',
        in2: 'onlyG',
        mode: 'screen',
        result: 'rg',
      }),
    );
    filter.appendChild(
      svgEl('feBlend', {
        in: 'rg',
        in2: 'onlyB',
        mode: 'screen',
      }),
    );
  } else {
    filter.appendChild(
      svgEl('feDisplacementMap', {
        in: 'SourceGraphic',
        in2: 'fcMap',
        scale: scaleG,
        xChannelSelector: 'R',
        yChannelSelector: 'G',
      }),
    );
  }
}

const trackedElements = new Map<HTMLElement, TrackedGlassMeta>();

function clearElementOpticalFilter(el: HTMLElement, meta?: TrackedGlassMeta): void {
  el.style.removeProperty('--fc-lg-filter');
  el.dataset.glassHover = 'false';
  el.dataset.glassPressed = 'false';
  if (meta) {
    meta.lastKey = '';
  }
}

/**
 * 重新计算并同步单个液态玻璃元素的光学折射 SVG 滤镜。
 */
export function refreshLiquidGlass(el: HTMLElement): void {
  const meta = trackedElements.get(el);
  if (!meta) return;

  if (!isLiquidGlassEnabled()) {
    clearElementOpticalFilter(el, meta);
    return;
  }

  if (!supportsOpticalRefraction || !el.isConnected) return;

  const rect = el.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return;

  const style = getComputedStyle(el);
  const rawRadius = Number.parseFloat(style.borderTopLeftRadius);
  const radius = Number.isFinite(rawRadius)
    ? rawRadius
    : Math.min(rect.width, rect.height) * 0.5;

  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  const key = `${w}x${h}:${Math.round(radius)}:${meta.opts.bevel}:${meta.opts.refraction}:${meta.opts.dispersion}:${meta.opts.lens}`;
  if (meta.lastKey === key) return;
  meta.lastKey = key;

  const { dataUrl, scale } = buildDisplacementMap(w, h, radius, meta.opts);
  if (!dataUrl || scale <= 0) return;
  upsertSvgFilter(meta.filterId, dataUrl, scale, meta.opts.dispersion);
  el.style.setProperty('--fc-lg-filter', `url(#${meta.filterId})`);
}

/**
 * 同步所有已挂载液态玻璃元素的开关与折射滤镜状态（适用于开关切换或主题变化后）。
 */
export function refreshAllLiquidGlass(): void {
  for (const el of trackedElements.keys()) {
    refreshLiquidGlass(el);
  }
}

const resizeObserver =
  typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => {
        for (const entry of entries) {
          refreshLiquidGlass(entry.target as HTMLElement);
        }
      })
    : null;

function bindGlowPointer(el: HTMLElement): () => void {
  const updatePoint = (e: PointerEvent) => {
    if (reducedMotionMedia?.matches || !isLiquidGlassEnabled()) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--fc-gx', `${(e.clientX - r.left).toFixed(1)}px`);
    el.style.setProperty('--fc-gy', `${(e.clientY - r.top).toFixed(1)}px`);
  };

  const onEnter = (e: PointerEvent) => {
    if (reducedMotionMedia?.matches || !isLiquidGlassEnabled()) return;
    updatePoint(e);
    el.dataset.glassHover = 'true';
  };
  const onMove = (e: PointerEvent) => updatePoint(e);
  const onDown = (e: PointerEvent) => {
    if (reducedMotionMedia?.matches || !isLiquidGlassEnabled()) return;
    updatePoint(e);
    el.dataset.glassPressed = 'true';
  };
  const onUp = () => {
    el.dataset.glassPressed = 'false';
  };
  const onLeave = () => {
    el.dataset.glassHover = 'false';
    el.dataset.glassPressed = 'false';
  };

  el.addEventListener('pointerenter', onEnter);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('pointercancel', onLeave);

  return () => {
    el.removeEventListener('pointerenter', onEnter);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointerleave', onLeave);
    el.removeEventListener('pointercancel', onLeave);
  };
}

/**
 * 为浮层元素挂载 FlClash 五层光学液态玻璃，并返回清理函数。
 */
export function attachLiquidGlass(
  el: HTMLElement,
  preset: LiquidGlassPreset = 'regular',
  customOpts?: LiquidGlassOptions,
): () => void {
  el.classList.add('fc-glass');
  el.classList.remove(...PRESET_CLASSES);
  el.classList.add(`fc-glass--${preset}`);
  el.dataset.fcGlass = preset;

  const base = PRESETS[preset] ?? PRESETS.regular;
  const opts: ResolvedGlassOptions = { ...base, ...(customOpts ?? {}) };

  const existing = trackedElements.get(el);
  if (existing) {
    existing.preset = preset;
    existing.opts = opts;
    existing.lastKey = '';
    refreshLiquidGlass(el);
  } else {
    const cleanupPointer = bindGlowPointer(el);
    const meta: TrackedGlassMeta = {
      filterId: `fc-lg-f-${++idCounter}`,
      preset,
      opts,
      lastKey: '',
      cleanupPointer,
    };
    trackedElements.set(el, meta);
    resizeObserver?.observe(el);
    refreshLiquidGlass(el);
  }

  return () => {
    const current = trackedElements.get(el);
    if (!current) return;
    current.cleanupPointer();
    resizeObserver?.unobserve(el);
    const filterEl = document.getElementById(current.filterId);
    filterEl?.remove();
    clearElementOpticalFilter(el, current);
    trackedElements.delete(el);
  };
}
