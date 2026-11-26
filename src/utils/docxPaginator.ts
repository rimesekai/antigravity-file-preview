import { DOCX_SECTION_END_CLASS_PREFIX } from './docxPageFields';

export const DOCX_KEEP_NEXT_CLASS = 'fp-docx-keep-next';
export const DOCX_KEEP_LINES_CLASS = 'fp-docx-keep-lines';
export const DOCX_TBL_HEADER_CLASS = 'fp-docx-tbl-header';
export const DOCX_CONTINUED_PARA_CLASS = 'fp-docx-continued-para';

const DEFAULT_PT_TO_PX = 96 / 72;
const WORD_AUTO_LINE_HEIGHT_RATIO = 1.3;
const SECTION_OVERFLOW_TOLERANCE_PX = 6;
const RENDERED_BREAK_OVERFLOW_RATIO = 1.28;
const FIT_TOLERANCE_PX = 1;
const MIN_SPLIT_HEIGHT_PX = 36;
const MAX_KEEP_NEXT_GROUP_SIZE = 3;
const MEDIA_READY_TIMEOUT_MS = 1500;
const INDIVISIBLE_SELECTOR = 'img, svg, canvas, table, video, audio, iframe, object, embed';
const MEDIA_ONLY_SELECTOR = 'img, svg, canvas';
const UNITLESS_LINE_HEIGHT_VALUE_RE = /^\d+(?:\.\d+)?$/;
const STYLE_UNITLESS_LINE_HEIGHT_RE = /(line-height\s*:\s*)(\d+(?:\.\d+)?)(\s*(?:;|(?=\})))/gi;
const LINE_HEIGHT_NORMALIZED_ATTR = 'data-fp-lh-normalized';

export interface DocxPaginationSectionMeta {
  sectProps: any;
}

export interface DocxPaginationMeta {
  hasLastRenderedPageBreak: boolean;
  evenAndOddHeaders: boolean;
  sectionMetas: DocxPaginationSectionMeta[];
}

export interface HeaderFooterTemplatePair {
  header: HTMLElement | null;
  footer: HTMLElement | null;
}

export interface DocxHeaderFooterTemplates {
  first?: HeaderFooterTemplatePair;
  even?: HeaderFooterTemplatePair;
  default?: HeaderFooterTemplatePair;
}

export interface BlockBoxMetrics {
  height: number;
  marginTop: number;
  marginBottom: number;
}

export interface DocxPaginationMeasurer {
  getSectionMinHeightPx(section: HTMLElement): number;
  getSectionHeightPx(section: HTMLElement): number;
  getMaxArticleHeightPx(section: HTMLElement, pageMinHeightPx: number): number;
  getArticleColumnCount(article: HTMLElement): number;
  measureBlock(block: HTMLElement, section: HTMLElement): BlockBoxMetrics;
  splitParagraph(
    para: HTMLElement,
    availableHeightPx: number,
    section: HTMLElement,
    allowEmptyPageSplit: boolean,
  ): { head: HTMLElement; tail: HTMLElement } | null;
  splitTable(
    table: HTMLElement,
    availableHeightPx: number,
    section: HTMLElement,
    isPageEmpty: boolean,
  ): { head: HTMLElement; tail: HTMLElement } | null;
}

export interface PaginateDocxOptions {
  renderHeaderFooterTemplates?: (sectProps: any) => Promise<DocxHeaderFooterTemplates | null>;
  measurer?: DocxPaginationMeasurer;
}

function appendClassName(node: { className?: string }, cls: string): void {
  const existing = (node.className ?? '').trim();
  if (!existing) {
    node.className = cls;
    return;
  }
  const parts = existing.split(/\s+/);
  if (!parts.includes(cls)) {
    node.className = `${existing} ${cls}`;
  }
}

function resolveStyleKeepFlags(
  styleName: string | undefined,
  styleMap: Map<string, any>,
  defaultParaStyleId: string | undefined,
): { keepNext?: boolean; keepLines?: boolean } {
  let keepNext: boolean | undefined;
  let keepLines: boolean | undefined;
  const seen = new Set<string>();

  const walk = (startId?: string) => {
    let curr = startId;
    while (curr && !seen.has(curr)) {
      seen.add(curr);
      const st = styleMap.get(curr);
      if (!st) break;
      const pProps = st.paragraphProps;
      if (pProps) {
        if (keepNext === undefined && typeof pProps.keepNext === 'boolean') {
          keepNext = pProps.keepNext;
        }
        if (keepLines === undefined && typeof pProps.keepLines === 'boolean') {
          keepLines = pProps.keepLines;
        }
      }
      if (keepNext !== undefined && keepLines !== undefined) return;
      curr = st.basedOn;
    }
  };

  if (styleName) {
    walk(styleName);
  }
  if (defaultParaStyleId && !seen.has(defaultParaStyleId)) {
    walk(defaultParaStyleId);
  }
  return { keepNext, keepLines };
}

/**
 * 在 docx-preview parseAsync 之后、preprocessDocxPageFields 之前采集分页所需的文档元数据：
 * 1. 检测文档正文是否包含 Word 预渲染分页符 (<w:lastRenderedPageBreak/>)；
 * 2. 将段落 keepNext / keepLines（含样式继承链）与表格行 tblHeader 转为 DOM 标记类名；
 * 3. 按分节顺序采集每个分节的 sectProps 及奇偶页配置。
 */
export function collectDocxPaginationMeta(doc: any): DocxPaginationMeta {
  const sectionMetas: DocxPaginationSectionMeta[] = [];
  const evenAndOddHeaders = Boolean(doc?.settingsPart?.settings?.evenAndOddHeaders);
  let hasLastRenderedPageBreak = false;

  if (!doc || typeof doc !== 'object') {
    return { hasLastRenderedPageBreak, evenAndOddHeaders, sectionMetas };
  }

  const styleMap = new Map<string, any>();
  let defaultParaStyleId: string | undefined;
  const styles = doc.stylesPart?.styles;
  if (Array.isArray(styles)) {
    for (const st of styles) {
      if (!st?.id) continue;
      styleMap.set(st.id, st);
      if (st.isDefault && (st.target === 'p' || st.target == null) && !defaultParaStyleId) {
        defaultParaStyleId = st.id;
      }
    }
  }

  const visited = new WeakSet<object>();
  const walkBody = (node: unknown): void => {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walkBody(item);
      return;
    }

    const rec = node as Record<string, any>;
    if (rec.type === 'break' && rec.break === 'lastRenderedPageBreak') {
      hasLastRenderedPageBreak = true;
    } else if (rec.type === 'paragraph') {
      const inherited = resolveStyleKeepFlags(rec.styleName, styleMap, defaultParaStyleId);
      const keepNext = typeof rec.keepNext === 'boolean' ? rec.keepNext : Boolean(inherited.keepNext);
      const keepLines = typeof rec.keepLines === 'boolean' ? rec.keepLines : Boolean(inherited.keepLines);
      if (keepNext) {
        appendClassName(rec, DOCX_KEEP_NEXT_CLASS);
      }
      if (keepLines) {
        appendClassName(rec, DOCX_KEEP_LINES_CLASS);
      }
    } else if (rec.type === 'row' && rec.isHeader === true) {
      appendClassName(rec, DOCX_TBL_HEADER_CLASS);
    }

    if (Array.isArray(rec.children)) {
      for (const child of rec.children) walkBody(child);
    }
  };

  const body = doc.documentPart?.body;
  if (body) {
    walkBody(body);
    if (Array.isArray(body.children)) {
      for (const child of body.children) {
        if (child?.type === 'paragraph' && child.sectionProps) {
          sectionMetas.push({ sectProps: child.sectionProps });
        }
      }
    }
    if (body.props) {
      sectionMetas.push({ sectProps: body.props });
    }
  }

  return {
    hasLastRenderedPageBreak,
    evenAndOddHeaders,
    sectionMetas,
  };
}

function hasMediaDescendant(el: HTMLElement): boolean {
  if (typeof el.querySelector === 'function') {
    return Boolean(el.querySelector(MEDIA_ONLY_SELECTOR));
  }
  return false;
}

function hasIndivisibleDescendant(el: HTMLElement): boolean {
  if (typeof el.querySelector === 'function') {
    return Boolean(el.querySelector(INDIVISIBLE_SELECTOR));
  }
  return false;
}

function isImageOnlyParagraph(el: HTMLElement): boolean {
  if (el.tagName?.toUpperCase() !== 'P') return false;
  if (!hasMediaDescendant(el)) return false;
  const text = (el.textContent ?? '').replace(/[\s\u00a0\u200B\uFEFF]/g, '');
  return text.length === 0;
}

function isShortCaptionLikeParagraph(
  el: HTMLElement,
  metric: BlockBoxMetrics,
  maxArticleHeightPx: number,
): boolean {
  if (el.tagName?.toUpperCase() !== 'P') return false;
  if (hasIndivisibleDescendant(el)) return false;
  return metric.height <= Math.min(120, maxArticleHeightPx * 0.18);
}

function getLocalXmlName(node: { localName?: string; tagName?: string }): string {
  if (node.localName) return node.localName;
  const tag = node.tagName ?? '';
  const idx = tag.indexOf(':');
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

function getXmlAttr(
  el: { getAttribute?: (name: string) => string | null; attributes?: ArrayLike<{ name: string; value: string }> },
  names: string[],
): string | null {
  for (const name of names) {
    const val = el.getAttribute?.(name);
    if (val !== null && val !== undefined && val !== '') {
      return val;
    }
  }
  if (el.attributes) {
    for (let i = 0; i < el.attributes.length; i += 1) {
      const attr = el.attributes[i];
      if (!attr) continue;
      const local = attr.name.includes(':') ? attr.name.split(':').pop() : attr.name;
      if (local && names.includes(local) && attr.value !== '') {
        return attr.value;
      }
    }
  }
  return null;
}

function normalizeVmlColor(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'auto' || trimmed.toLowerCase() === 'none') {
    return null;
  }
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
    return `#${trimmed}`;
  }
  return trimmed;
}

/**
 * 修正并补全 docx-preview 解析 <w:background> 时的页面背景色：
 * 1. 当 <w:background w:color="auto"/> 时，docx-preview 会错误将其映射为 'black'，此处清理以保持白纸底色；
 * 2. 若 <w:background> 仅通过子元素 <v:background fillcolor="..."/> 指定底色，则补齐到 body.cssStyle['background-color']。
 */
export function sanitizeDocxPageBackground(doc: any): void {
  const body = doc?.documentPart?.body;
  if (!body || typeof body !== 'object') return;

  const rootEl = doc?.documentPart?._xmlDocument?.firstElementChild;
  if (!rootEl || !rootEl.children) return;

  let bgEl: any = null;
  for (const child of Array.from(rootEl.children as ArrayLike<any>)) {
    if (getLocalXmlName(child) === 'background') {
      bgEl = child;
      break;
    }
  }
  if (!bgEl) return;

  if (!body.cssStyle || typeof body.cssStyle !== 'object') {
    body.cssStyle = {};
  }

  const wColor = getXmlAttr(bgEl, ['w:color', 'color']);
  if (wColor?.trim().toLowerCase() === 'auto' && body.cssStyle['background-color'] === 'black') {
    delete body.cssStyle['background-color'];
  }

  if (!body.cssStyle['background-color'] && bgEl.children) {
    for (const child of Array.from(bgEl.children as ArrayLike<any>)) {
      if (getLocalXmlName(child) !== 'background') continue;
      const fillColor = normalizeVmlColor(getXmlAttr(child, ['fillcolor']));
      if (fillColor) {
        body.cssStyle['background-color'] = fillColor;
        break;
      }
    }
  }
}

/**
 * 修正 docx-preview 将 Word <w:spacing w:lineRule="auto"/> 直接映射为 CSS 无单位 line-height 造成的行高偏矮问题：
 * Word 中单倍行距 (240) 约为字号的 1.3 倍自然行框高度，而在 CSS 中无单位 line-height 直接乘以 font-size。
 * 本函数将 <style> 规则与正文段落上的纯数字无单位 line-height 统一乘以 1.3（跳过纯图片段落与已处理节点）。
 */
export function normalizeDocxAutoLineHeight(stageEl: HTMLElement): void {
  if (typeof stageEl?.querySelectorAll !== 'function') return;

  const styles = Array.from(stageEl.querySelectorAll<HTMLElement>('style'));
  for (const styleEl of styles) {
    if (styleEl.getAttribute?.(LINE_HEIGHT_NORMALIZED_ATTR) === '1') continue;
    const cssText = styleEl.textContent ?? '';
    if (cssText) {
      const updated = cssText.replace(
        STYLE_UNITLESS_LINE_HEIGHT_RE,
        (full, prefix: string, numStr: string, suffix: string) => {
          const val = Number.parseFloat(numStr);
          if (!Number.isFinite(val) || val <= 0) return full;
          return `${prefix}${Number((val * WORD_AUTO_LINE_HEIGHT_RATIO).toFixed(3))}${suffix}`;
        },
      );
      if (updated !== cssText) {
        styleEl.textContent = updated;
      }
    }
    styleEl.setAttribute?.(LINE_HEIGHT_NORMALIZED_ATTR, '1');
  }

  const paragraphs = Array.from(stageEl.querySelectorAll<HTMLElement>('p'));
  for (const p of paragraphs) {
    if (p.getAttribute?.(LINE_HEIGHT_NORMALIZED_ATTR) === '1') continue;
    if (typeof p.closest === 'function' && p.closest('header, footer')) {
      p.setAttribute?.(LINE_HEIGHT_NORMALIZED_ATTR, '1');
      continue;
    }

    const rawLineHeight = p.style?.lineHeight?.trim() ?? '';
    if (isImageOnlyParagraph(p)) {
      if (!rawLineHeight) {
        p.style.lineHeight = '1.2';
      }
      p.setAttribute?.(LINE_HEIGHT_NORMALIZED_ATTR, '1');
      continue;
    }

    if (UNITLESS_LINE_HEIGHT_VALUE_RE.test(rawLineHeight)) {
      const val = Number.parseFloat(rawLineHeight);
      if (Number.isFinite(val) && val > 0) {
        p.style.lineHeight = `${Number((val * WORD_AUTO_LINE_HEIGHT_RATIO).toFixed(3))}`;
      }
    }
    p.setAttribute?.(LINE_HEIGHT_NORMALIZED_ATTR, '1');
  }
}

/**
 * 等待舞台内所有图片完成加载与解码（带超时兜底），确保分页测量时图像占据真实几何高度。
 */
export async function waitForDocxMediaReady(
  stageEl: HTMLElement,
  timeoutMs = MEDIA_READY_TIMEOUT_MS,
): Promise<void> {
  if (typeof stageEl?.querySelectorAll !== 'function') return;
  const imgs = Array.from(stageEl.querySelectorAll<HTMLImageElement>('img'));
  if (imgs.length === 0) return;

  const cleanups: Array<() => void> = [];
  const tasks: Promise<void>[] = [];

  for (const img of imgs) {
    if (!img.complete) {
      tasks.push(
        new Promise<void>((resolve) => {
          const done = () => {
            img.removeEventListener('load', done);
            img.removeEventListener('error', done);
            if (img.naturalWidth > 0 && typeof img.decode === 'function') {
              img.decode().then(resolve, resolve);
            } else {
              resolve();
            }
          };
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
          cleanups.push(() => {
            img.removeEventListener('load', done);
            img.removeEventListener('error', done);
          });
        }),
      );
    } else if (img.naturalWidth > 0 && typeof img.decode === 'function') {
      tasks.push(img.decode().catch(() => {}));
    }
  }

  if (tasks.length === 0) return;

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    for (const fn of cleanups) fn();
  }
}

export function parseCssLengthToPx(
  raw: string | null | undefined,
  ptToPx = DEFAULT_PT_TO_PX,
): number | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === 'auto' || trimmed === 'none') return null;
  const match = /^(-?\d+(?:\.\d+)?)(px|pt|in|cm|mm|pc)?$/.exec(trimmed);
  if (!match) return null;
  const num = Number.parseFloat(match[1]);
  if (!Number.isFinite(num)) return null;
  const unit = match[2] ?? 'px';
  switch (unit) {
    case 'px':
      return num;
    case 'pt':
      return num * ptToPx;
    case 'pc':
      return num * 12 * ptToPx;
    case 'in':
      return num * 72 * ptToPx;
    case 'cm':
      return (num / 2.54) * 72 * ptToPx;
    case 'mm':
      return (num / 25.4) * 72 * ptToPx;
    default:
      return null;
  }
}

function collapseMargins(mb: number, mt: number): number {
  if (mb >= 0 && mt >= 0) return Math.max(mb, mt);
  if (mb < 0 && mt < 0) return Math.min(mb, mt);
  return mb + mt;
}

function getDirectChildrenByTag(parent: HTMLElement, tagUpper: string): HTMLElement[] {
  const result: HTMLElement[] = [];
  for (const child of Array.from(parent.children)) {
    if (child.tagName?.toUpperCase() === tagUpper) {
      result.push(child as HTMLElement);
    }
  }
  return result;
}

function getSafeComputedStyle(el: HTMLElement): CSSStyleDeclaration | null {
  if (typeof getComputedStyle !== 'function') return null;
  try {
    return getComputedStyle(el);
  } catch {
    return null;
  }
}

function readNumericStylePx(
  el: HTMLElement,
  cs: CSSStyleDeclaration | null,
  prop: 'marginTop' | 'marginBottom' | 'paddingTop' | 'paddingBottom' | 'borderTopWidth' | 'borderBottomWidth' | 'minHeight',
): number {
  const fromCs = cs ? parseCssLengthToPx(cs[prop]) : null;
  if (fromCs !== null) return fromCs;
  const fromInline = el.style ? parseCssLengthToPx(el.style[prop]) : null;
  return fromInline ?? 0;
}

function moveSectionEndClasses(fromEl: HTMLElement, toEl: HTMLElement): void {
  const toMove: string[] = [];
  if (fromEl.classList) {
    for (const cls of Array.from(fromEl.classList)) {
      if (cls.startsWith(DOCX_SECTION_END_CLASS_PREFIX)) {
        toMove.push(cls);
      }
    }
    for (const cls of toMove) {
      fromEl.classList.remove(cls);
      toEl.classList.add(cls);
    }
    return;
  }

  const parts = (fromEl.className ?? '').split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const cls of parts) {
    if (cls.startsWith(DOCX_SECTION_END_CLASS_PREFIX)) {
      toMove.push(cls);
    } else {
      kept.push(cls);
    }
  }
  if (toMove.length > 0) {
    fromEl.className = kept.join(' ');
    const targetParts = new Set((toEl.className ?? '').split(/\s+/).filter(Boolean));
    for (const cls of toMove) targetParts.add(cls);
    toEl.className = Array.from(targetParts).join(' ');
  }
}

function stripDuplicateIds(root: HTMLElement): void {
  root.removeAttribute?.('id');
  if (typeof root.querySelectorAll === 'function') {
    for (const el of root.querySelectorAll('[id]')) {
      el.removeAttribute('id');
    }
  }
}

function hasClass(el: HTMLElement, cls: string): boolean {
  if (el.classList && typeof el.classList.contains === 'function') {
    return el.classList.contains(cls);
  }
  return (el.className ?? '').split(/\s+/).includes(cls);
}

function addClass(el: HTMLElement, cls: string): void {
  if (el.classList && typeof el.classList.add === 'function') {
    el.classList.add(cls);
    return;
  }
  const parts = new Set((el.className ?? '').split(/\s+/).filter(Boolean));
  parts.add(cls);
  el.className = Array.from(parts).join(' ');
}

function findMaxEndedSectionIndex(sectionEl: HTMLElement): number | null {
  if (typeof sectionEl.querySelectorAll !== 'function') return null;
  const markers = sectionEl.querySelectorAll(`[class*="${DOCX_SECTION_END_CLASS_PREFIX}"]`);
  let maxIdx: number | null = null;
  for (const el of markers) {
    const classes = el.classList ? Array.from(el.classList) : (el.className ?? '').split(/\s+/);
    for (const cls of classes) {
      if (!cls.startsWith(DOCX_SECTION_END_CLASS_PREFIX)) continue;
      const parsed = Number.parseInt(cls.slice(DOCX_SECTION_END_CLASS_PREFIX.length), 10);
      if (Number.isFinite(parsed) && (maxIdx === null || parsed > maxIdx)) {
        maxIdx = parsed;
      }
    }
  }
  return maxIdx;
}

/**
 * 二分查找满足 height(unit) <= availableHeightPx 的最大切分单元索引（范围 [1, totalUnits - 1]）。
 * 若连第 1 个单元都超出可用高度，则返回 0。
 */
export function findBestSplitUnitIndex(
  totalUnits: number,
  availableHeightPx: number,
  measureBottomAtUnit: (unitIdx: number) => number,
): number {
  if (totalUnits < 2) return 0;
  let lo = 1;
  let hi = totalUnits - 1;
  let best = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const bottom = measureBottomAtUnit(mid);
    if (bottom <= availableHeightPx + FIT_TOLERANCE_PX) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * 对切分后的段落首尾片段统一应用分页样式规则：
 * - 首段清除段后距、并在两端对齐时补充 text-align-last: justify；
 * - 续段归零首行缩进与段前距、标记 fp-docx-continued-para；
 * - 将分节结束标记类（fp-sect-end-*）迁移至末片段。
 */
export function applyParagraphSplitPostProcess(
  pHead: HTMLElement,
  pTail: HTMLElement,
  isJustified: boolean,
): void {
  pHead.style.marginBottom = '0px';
  if (isJustified) {
    pHead.style.textAlignLast = 'justify';
  }
  pTail.style.textIndent = '0px';
  pTail.style.marginTop = '0px';
  addClass(pTail, DOCX_CONTINUED_PARA_CLASS);
  moveSectionEndClasses(pHead, pTail);
}

/**
 * 计算表格中每一行之后的切分是否安全（不截断任何跨行合并 rowSpan > 1 的单元格）。
 */
export function computeSafeTableSplitBoundaries(rows: HTMLElement[]): boolean[] {
  const safeAfter = new Array<boolean>(rows.length).fill(true);
  let maxSpanEnd = -1;
  for (let r = 0; r < rows.length; r += 1) {
    const cells = Array.from(rows[r].children).filter((el) => {
      const tag = el.tagName?.toUpperCase();
      return tag === 'TD' || tag === 'TH';
    }) as HTMLElement[];
    for (const cell of cells) {
      const rawAttr = typeof cell.getAttribute === 'function' ? cell.getAttribute('rowspan') : null;
      const spanProp = (cell as HTMLTableCellElement).rowSpan;
      const span =
        typeof spanProp === 'number' && Number.isFinite(spanProp)
          ? spanProp
          : Number.parseInt(rawAttr ?? '1', 10);
      if (Number.isFinite(span) && span > 1) {
        maxSpanEnd = Math.max(maxSpanEnd, r + span - 1);
      }
    }
    safeAfter[r] = r >= maxSpanEnd;
  }
  return safeAfter;
}

interface ParagraphSplitUnit {
  kind: 'text' | 'atomic';
  node: Node;
  cumStart: number;
  cumEnd: number;
}

function collectParagraphSplitUnits(para: HTMLElement): {
  units: ParagraphSplitUnit[];
  totalUnits: number;
} {
  const units: ParagraphSplitUnit[] = [];
  let cursor = 0;

  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const len = node.nodeValue?.length ?? 0;
      if (len > 0) {
        units.push({ kind: 'text', node, cumStart: cursor, cumEnd: cursor + len });
        cursor += len;
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName?.toUpperCase();
    if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT') return;
    if (tag === 'MATH' || tag === 'SVG') {
      units.push({ kind: 'atomic', node: el, cumStart: cursor, cumEnd: cursor + 1 });
      cursor += 1;
      return;
    }
    for (const child of Array.from(el.childNodes)) {
      walk(child);
    }
  };

  for (const child of Array.from(para.childNodes)) {
    walk(child);
  }
  return { units, totalUnits: cursor };
}

function setRangeBoundaryAtUnit(
  range: Range,
  units: ParagraphSplitUnit[],
  unitIdx: number,
  edge: 'start' | 'end',
): void {
  // unitIdx 为逻辑位置 [0..totalUnits]，locate 找到其所在单元及内部偏移
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (edge === 'start' && unitIdx === u.cumEnd && i + 1 < units.length) {
      continue;
    }
    if (unitIdx <= u.cumEnd) {
      if (u.kind === 'text') {
        const localOffset = Math.max(0, Math.min(u.cumEnd - u.cumStart, unitIdx - u.cumStart));
        if (edge === 'end') {
          range.setEnd(u.node, localOffset);
        } else {
          range.setStart(u.node, localOffset);
        }
      } else if (unitIdx <= u.cumStart) {
        if (edge === 'end') range.setEndBefore(u.node);
        else range.setStartBefore(u.node);
      } else {
        if (edge === 'end') range.setEndAfter(u.node);
        else range.setStartAfter(u.node);
      }
      return;
    }
  }
  const last = units[units.length - 1];
  if (!last) return;
  if (last.kind === 'text') {
    const len = last.node.nodeValue?.length ?? 0;
    if (edge === 'end') range.setEnd(last.node, len);
    else range.setStart(last.node, len);
  } else {
    if (edge === 'end') range.setEndAfter(last.node);
    else range.setStartAfter(last.node);
  }
}

function hasVisibleInlineContent(root: Node): boolean {
  const text = root.textContent ?? '';
  if (text.replace(/[\s\u00a0\u200B\uFEFF]/g, '').length > 0) {
    return true;
  }
  if (root instanceof Element || root instanceof DocumentFragment) {
    return Boolean(root.querySelector('math, svg, img, canvas'));
  }
  return false;
}

interface DirectTableStructure {
  colgroup: HTMLElement | null;
  usesSectionContainers: boolean;
  allRows: HTMLElement[];
  rowBodyParentTag: 'TBODY' | 'TABLE';
}

function getDirectTableStructure(table: HTMLElement): DirectTableStructure {
  let colgroup: HTMLElement | null = null;
  let usesSectionContainers = false;
  const allRows: HTMLElement[] = [];
  let rowBodyParentTag: 'TBODY' | 'TABLE' = 'TABLE';

  for (const child of Array.from(table.children)) {
    const tag = child.tagName?.toUpperCase();
    if (tag === 'COLGROUP') {
      colgroup = child as HTMLElement;
    } else if (tag === 'TR') {
      allRows.push(child as HTMLElement);
    } else if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') {
      usesSectionContainers = true;
      if (tag === 'TBODY') rowBodyParentTag = 'TBODY';
      for (const row of Array.from(child.children)) {
        if (row.tagName?.toUpperCase() === 'TR') {
          allRows.push(row as HTMLElement);
        }
      }
    }
  }

  return { colgroup, usesSectionContainers, allRows, rowBodyParentTag };
}

function createDefaultDomMeasurer(): DocxPaginationMeasurer {
  return {
    getSectionMinHeightPx(section) {
      const cs = getSafeComputedStyle(section);
      const fromCs = cs ? parseCssLengthToPx(cs.minHeight) : null;
      if (fromCs !== null && fromCs > 0) return fromCs;
      const fromStyle = parseCssLengthToPx(section.style?.minHeight);
      return fromStyle ?? 0;
    },

    getSectionHeightPx(section) {
      return section.offsetHeight ?? 0;
    },

    getMaxArticleHeightPx(section, pageMinHeightPx) {
      const cs = getSafeComputedStyle(section);
      const borderTop = readNumericStylePx(section, cs, 'borderTopWidth');
      const borderBottom = readNumericStylePx(section, cs, 'borderBottomWidth');
      const padTop = readNumericStylePx(section, cs, 'paddingTop');
      const padBottom = readNumericStylePx(section, cs, 'paddingBottom');

      let chromeHeight = 0;
      for (const tag of ['HEADER', 'FOOTER'] as const) {
        const els = getDirectChildrenByTag(section, tag);
        for (const el of els) {
          const elCs = getSafeComputedStyle(el);
          const mt = readNumericStylePx(el, elCs, 'marginTop');
          const mb = readNumericStylePx(el, elCs, 'marginBottom');
          chromeHeight += Math.max(0, (el.offsetHeight ?? 0) + mt + mb);
        }
      }

      return pageMinHeightPx - borderTop - borderBottom - padTop - padBottom - chromeHeight;
    },

    getArticleColumnCount(article) {
      const cs = getSafeComputedStyle(article);
      const raw = cs?.columnCount || article.style?.columnCount;
      if (!raw || raw === 'auto') return 1;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed > 1 ? parsed : 1;
    },

    measureBlock(block) {
      const cs = getSafeComputedStyle(block);
      return {
        height: block.offsetHeight ?? 0,
        marginTop: readNumericStylePx(block, cs, 'marginTop'),
        marginBottom: readNumericStylePx(block, cs, 'marginBottom'),
      };
    },

    splitParagraph(para, availableHeightPx, _section, allowEmptyPageSplit) {
      if (typeof document === 'undefined' || typeof document.createRange !== 'function') {
        return null;
      }
      if (hasClass(para, DOCX_KEEP_LINES_CLASS)) return null;
      if (hasIndivisibleDescendant(para)) {
        return null;
      }

      const cs = getSafeComputedStyle(para);
      const fontSizePx = parseCssLengthToPx(cs?.fontSize) ?? 14;
      const rawLineHeight = cs?.lineHeight;
      const parsedLineHeight =
        rawLineHeight && rawLineHeight !== 'normal' ? parseCssLengthToPx(rawLineHeight) : null;
      const lineHeightPx =
        parsedLineHeight && parsedLineHeight > 0 ? parsedLineHeight : fontSizePx * 1.35;
      const minKeepHeightPx = Math.max(MIN_SPLIT_HEIGHT_PX, lineHeightPx * 1.8);

      if (!allowEmptyPageSplit && availableHeightPx < minKeepHeightPx) {
        return null;
      }

      const { units, totalUnits } = collectParagraphSplitUnits(para);
      if (totalUnits < 2) return null;

      const paraRect = para.getBoundingClientRect();
      const paraOffsetHeight = para.offsetHeight || paraRect.height;
      const cssScale = paraOffsetHeight > 0 && paraRect.height > 0 ? paraRect.height / paraOffsetHeight : 1;
      const paddingBottom = readNumericStylePx(para, cs, 'paddingBottom');
      const borderBottom = readNumericStylePx(para, cs, 'borderBottomWidth');
      const halfLeadingBottom = Math.max(0, (lineHeightPx - fontSizePx) / 2);
      const effectiveAvailable = availableHeightPx - paddingBottom - borderBottom - halfLeadingBottom;

      if (!allowEmptyPageSplit && effectiveAvailable < lineHeightPx * 0.9) {
        return null;
      }

      const probeRange = document.createRange();
      const measureBottomAtUnit = (unitIdx: number): number => {
        probeRange.setStart(para, 0);
        setRangeBoundaryAtUnit(probeRange, units, unitIdx, 'end');
        const rect = probeRange.getBoundingClientRect();
        return (rect.bottom - paraRect.top) / cssScale;
      };

      const bestUnit = findBestSplitUnitIndex(totalUnits, effectiveAvailable, measureBottomAtUnit);
      if (bestUnit <= 0 || bestUnit >= totalUnits) {
        return null;
      }

      const headBottom = measureBottomAtUnit(bestUnit);
      if (!allowEmptyPageSplit && headBottom < minKeepHeightPx * 0.9) {
        return null;
      }

      // 检查下半段是否确实包含可见内容且不是退化空片段
      const tailRange = document.createRange();
      setRangeBoundaryAtUnit(tailRange, units, bestUnit, 'start');
      tailRange.setEnd(para, para.childNodes.length);
      const tailRect = tailRange.getBoundingClientRect();
      const tailFragClone = tailRange.cloneContents();
      if (!hasVisibleInlineContent(tailFragClone)) {
        return null;
      }
      const tailHeightPx = tailRect.height / cssScale;
      if (!allowEmptyPageSplit && tailHeightPx > 0 && tailHeightPx < lineHeightPx * 0.4) {
        return null;
      }

      const tailFrag = tailRange.extractContents();
      const pHead = para;
      const pTail = para.cloneNode(false) as HTMLElement;
      stripDuplicateIds(pTail);
      pTail.appendChild(tailFrag);

      const isJustified = (cs?.textAlign || para.style?.textAlign) === 'justify';
      applyParagraphSplitPostProcess(pHead, pTail, isJustified);

      pHead.parentNode?.insertBefore(pTail, pHead.nextSibling);
      return { head: pHead, tail: pTail };
    },

    splitTable(table, availableHeightPx, _section, isPageEmpty) {
      const structure = getDirectTableStructure(table);
      const rows = structure.allRows;
      if (rows.length <= 1) return null;

      const safeAfter = computeSafeTableSplitBoundaries(rows);
      let headerCount = 0;
      while (headerCount < rows.length && hasClass(rows[headerCount], DOCX_TBL_HEADER_CLASS)) {
        headerCount += 1;
      }
      if (headerCount >= rows.length) {
        headerCount = 0;
      } else if (headerCount > 0 && !safeAfter[headerCount - 1]) {
        while (headerCount < rows.length && !safeAfter[headerCount - 1]) {
          headerCount += 1;
        }
        if (headerCount >= rows.length) headerCount = 0;
      }

      const tableRect = table.getBoundingClientRect();
      const tableOffsetHeight = table.offsetHeight || tableRect.height;
      const cssScale = tableOffsetHeight > 0 && tableRect.height > 0 ? tableRect.height / tableOffsetHeight : 1;

      let bestSplitRow = -1;
      for (let r = headerCount; r < rows.length - 1; r += 1) {
        if (!safeAfter[r]) continue;
        const rowRect = rows[r].getBoundingClientRect();
        const rowBottomPx = (rowRect.bottom - tableRect.top) / cssScale;
        if (rowBottomPx <= availableHeightPx + FIT_TOLERANCE_PX) {
          bestSplitRow = r;
        } else {
          break;
        }
      }

      if (bestSplitRow < 0) {
        if (!isPageEmpty) return null;
        for (let r = headerCount; r < rows.length - 1; r += 1) {
          if (safeAfter[r]) {
            bestSplitRow = r;
            break;
          }
        }
        if (bestSplitRow < 0) return null;
      }

      const tableHead = table;
      const tableTail = table.cloneNode(false) as HTMLElement;
      stripDuplicateIds(tableTail);

      if (structure.colgroup) {
        tableTail.appendChild(structure.colgroup.cloneNode(true));
      }

      const clonedHeaderRows: HTMLElement[] = [];
      for (let h = 0; h < headerCount; h += 1) {
        const clonedRow = rows[h].cloneNode(true) as HTMLElement;
        stripDuplicateIds(clonedRow);
        clonedHeaderRows.push(clonedRow);
      }

      const tailRows = rows.slice(bestSplitRow + 1);
      if (structure.usesSectionContainers) {
        if (clonedHeaderRows.length > 0 && typeof document !== 'undefined') {
          const thead = document.createElement('thead');
          for (const hr of clonedHeaderRows) thead.appendChild(hr);
          tableTail.appendChild(thead);
        }
        const bodyContainer =
          structure.rowBodyParentTag === 'TBODY' && typeof document !== 'undefined'
            ? document.createElement('tbody')
            : tableTail;
        if (clonedHeaderRows.length > 0 && typeof document === 'undefined') {
          for (const hr of clonedHeaderRows) bodyContainer.appendChild(hr);
        }
        for (const tr of tailRows) {
          bodyContainer.appendChild(tr);
        }
        if (bodyContainer !== tableTail) {
          tableTail.appendChild(bodyContainer);
        }
      } else {
        for (const hr of clonedHeaderRows) tableTail.appendChild(hr);
        for (const tr of tailRows) tableTail.appendChild(tr);
      }

      tableHead.style.marginBottom = '0px';
      tableTail.style.marginTop = '0px';
      moveSectionEndClasses(tableHead, tableTail);

      tableHead.parentNode?.insertBefore(tableTail, tableHead.nextSibling);
      return { head: tableHead, tail: tableTail };
    },
  };
}

interface ArticlePagePlan {
  templateArticle: HTMLElement;
  blocks: HTMLElement[];
}

interface SectionPagePlan {
  articles: ArticlePagePlan[];
}

function isSplittableLongTextParagraph(el: HTMLElement, metric: BlockBoxMetrics): boolean {
  if (el.tagName?.toUpperCase() !== 'P') return false;
  if (hasClass(el, DOCX_KEEP_LINES_CLASS)) return false;
  if (hasIndivisibleDescendant(el)) return false;
  return metric.height > MIN_SPLIT_HEIGHT_PX * 2;
}

function measureGroupHeight(
  queue: HTMLElement[],
  metrics: BlockBoxMetrics[],
  startIdx: number,
  endIdx: number,
  initialUsedEnd: number,
  initialLastMarginBottom: number,
): number {
  let usedEnd = initialUsedEnd;
  let lastMb = initialLastMarginBottom;
  for (let i = startIdx; i <= endIdx; i += 1) {
    const m = metrics[i];
    const gap = i === startIdx && initialUsedEnd === 0 && initialLastMarginBottom === 0
      ? m.marginTop
      : collapseMargins(lastMb, m.marginTop);
    const effectiveHeight =
      i === endIdx && isSplittableLongTextParagraph(queue[i], m)
        ? Math.min(m.height, Math.max(MIN_SPLIT_HEIGHT_PX, 64))
        : m.height;
    usedEnd += gap + effectiveHeight;
    lastMb = m.marginBottom;
  }
  return usedEnd;
}

function computeKeepNextGroupEnd(
  queue: HTMLElement[],
  metrics: BlockBoxMetrics[],
  idx: number,
  maxArticleHeightPx: number,
): number {
  const first = queue[idx];
  if (first.tagName?.toUpperCase() !== 'P') {
    return idx;
  }

  const hasExplicitKeepNext = hasClass(first, DOCX_KEEP_NEXT_CLASS);
  const hasImplicitImageCaptionKeep =
    idx + 1 < queue.length &&
    isImageOnlyParagraph(first) &&
    isShortCaptionLikeParagraph(queue[idx + 1], metrics[idx + 1], maxArticleHeightPx);

  if (!hasExplicitKeepNext && !hasImplicitImageCaptionKeep) {
    return idx;
  }

  let endIdx = idx;
  while (
    endIdx + 1 < queue.length &&
    endIdx - idx + 1 < MAX_KEEP_NEXT_GROUP_SIZE
  ) {
    const curr = queue[endIdx];
    const currExplicit =
      curr.tagName?.toUpperCase() === 'P' && hasClass(curr, DOCX_KEEP_NEXT_CLASS);
    const currImplicitImgCap =
      isImageOnlyParagraph(curr) &&
      isShortCaptionLikeParagraph(queue[endIdx + 1], metrics[endIdx + 1], maxArticleHeightPx);
    if (!currExplicit && !currImplicitImgCap) {
      break;
    }
    endIdx += 1;
  }
  return endIdx;
}

function clampTrailingMarginOnPage(
  page: SectionPagePlan,
  usedContentEnd: number,
  lastMarginBottom: number,
  maxArticleHeightPx: number,
): void {
  if (usedContentEnd + lastMarginBottom <= maxArticleHeightPx + FIT_TOLERANCE_PX) return;
  const lastArticle = page.articles[page.articles.length - 1];
  const lastBlock = lastArticle?.blocks[lastArticle.blocks.length - 1];
  if (!lastBlock) return;
  const clamped = Math.max(0, Math.floor(maxArticleHeightPx - usedContentEnd));
  lastBlock.style.marginBottom = `${clamped}px`;
}

function planSingleSectionPages(
  origSection: HTMLElement,
  articles: HTMLElement[],
  maxArticleHeightPx: number,
  measurer: DocxPaginationMeasurer,
): SectionPagePlan[] {
  const pages: SectionPagePlan[] = [];
  let currentPage: SectionPagePlan = { articles: [] };
  let usedContentEnd = 0;
  let lastMarginBottom = 0;
  let hasContentOnPage = false;

  const startNewPage = () => {
    clampTrailingMarginOnPage(currentPage, usedContentEnd, lastMarginBottom, maxArticleHeightPx);
    pages.push(currentPage);
    currentPage = { articles: [] };
    usedContentEnd = 0;
    lastMarginBottom = 0;
    hasContentOnPage = false;
  };

  const ensureCurrentArticle = (templateArticle: HTMLElement): ArticlePagePlan => {
    const existing = currentPage.articles[currentPage.articles.length - 1];
    if (existing && existing.templateArticle === templateArticle) {
      return existing;
    }
    const created: ArticlePagePlan = { templateArticle, blocks: [] };
    currentPage.articles.push(created);
    return created;
  };

  for (const article of articles) {
    const colCount = measurer.getArticleColumnCount(article);
    const children = Array.from(article.children) as HTMLElement[];

    // 多栏 <article> 作为不可内部拆分的整体流单元处理，避免破坏多栏布局
    if (colCount > 1) {
      const m = measurer.measureBlock(article, origSection);
      const topGap = hasContentOnPage ? collapseMargins(lastMarginBottom, m.marginTop) : m.marginTop;
      const nextEnd = usedContentEnd + topGap + m.height;
      if (hasContentOnPage && nextEnd > maxArticleHeightPx + FIT_TOLERANCE_PX) {
        startNewPage();
      }
      const freshGap = hasContentOnPage ? collapseMargins(lastMarginBottom, m.marginTop) : m.marginTop;
      currentPage.articles.push({ templateArticle: article, blocks: children });
      usedContentEnd += freshGap + m.height;
      lastMarginBottom = m.marginBottom;
      hasContentOnPage = true;
      continue;
    }

    if (children.length === 0) continue;

    const queue = [...children];
    const metrics = queue.map((el) => measurer.measureBlock(el, origSection));
    let idx = 0;

    while (idx < queue.length) {
      const block = queue[idx];
      const m = metrics[idx];

      // keepNext 标题保护：若当前页非空且整组放不下当前页但可放入整张新页，整体移至下一页
      if (hasContentOnPage) {
        const groupEnd = computeKeepNextGroupEnd(queue, metrics, idx, maxArticleHeightPx);
        if (groupEnd > idx) {
          const onCurrentEnd = measureGroupHeight(
            queue,
            metrics,
            idx,
            groupEnd,
            usedContentEnd,
            lastMarginBottom,
          );
          if (onCurrentEnd > maxArticleHeightPx + FIT_TOLERANCE_PX) {
            const onFreshEnd = measureGroupHeight(queue, metrics, idx, groupEnd, 0, 0);
            if (onFreshEnd <= maxArticleHeightPx + FIT_TOLERANCE_PX) {
              startNewPage();
              continue;
            }
          }
        }
      }

      const topGap = hasContentOnPage ? collapseMargins(lastMarginBottom, m.marginTop) : m.marginTop;
      const nextEnd = usedContentEnd + topGap + m.height;

      if (nextEnd <= maxArticleHeightPx + FIT_TOLERANCE_PX) {
        ensureCurrentArticle(article).blocks.push(block);
        usedContentEnd = nextEnd;
        lastMarginBottom = m.marginBottom;
        hasContentOnPage = true;
        idx += 1;
        continue;
      }

      // 当前块溢出当前页剩余空间：尝试按段落行或表格行切分
      const availableForBlock = maxArticleHeightPx - (usedContentEnd + topGap);
      const tag = block.tagName?.toUpperCase();
      let splitResult: { head: HTMLElement; tail: HTMLElement } | null = null;

      if (tag === 'P') {
        splitResult = measurer.splitParagraph(block, availableForBlock, origSection, !hasContentOnPage);
      } else if (tag === 'TABLE') {
        splitResult = measurer.splitTable(block, availableForBlock, origSection, !hasContentOnPage);
      }

      if (splitResult) {
        const headMetrics = measurer.measureBlock(splitResult.head, origSection);
        const tailMetrics = measurer.measureBlock(splitResult.tail, origSection);

        ensureCurrentArticle(article).blocks.push(splitResult.head);
        usedContentEnd += topGap + headMetrics.height;
        lastMarginBottom = headMetrics.marginBottom;
        hasContentOnPage = true;

        queue[idx] = splitResult.head;
        metrics[idx] = headMetrics;
        queue.splice(idx + 1, 0, splitResult.tail);
        metrics.splice(idx + 1, 0, tailMetrics);

        startNewPage();
        idx += 1;
        continue;
      }

      // 不可切分或剩余空间不足：若当前页已有内容，推进至下一页重排；否则强制放置以保证单调收敛
      if (hasContentOnPage) {
        startNewPage();
        continue;
      }

      ensureCurrentArticle(article).blocks.push(block);
      usedContentEnd = nextEnd;
      lastMarginBottom = m.marginBottom;
      hasContentOnPage = true;
      idx += 1;
    }
  }

  if (hasContentOnPage || pages.length === 0) {
    clampTrailingMarginOnPage(currentPage, usedContentEnd, lastMarginBottom, maxArticleHeightPx);
    pages.push(currentPage);
  }

  return pages;
}

function getTargetSectionElements(stageEl: HTMLElement): HTMLElement[] {
  if (typeof stageEl?.querySelectorAll !== 'function') return [];
  const wrapped = Array.from(stageEl.querySelectorAll<HTMLElement>('.docx-wrapper > section.docx'));
  if (wrapped.length > 0) return wrapped;
  return Array.from(stageEl.querySelectorAll<HTMLElement>('section.docx'));
}

function selectHeaderFooterPair(
  templates: DocxHeaderFooterTemplates | null,
  evenAndOddHeaders: boolean,
  globalPageIndex: number,
  origHeader: HTMLElement | null,
  origFooter: HTMLElement | null,
): { header: HTMLElement | null; footer: HTMLElement | null } {
  if (templates) {
    const pair =
      evenAndOddHeaders && globalPageIndex % 2 === 1
        ? (templates.even ?? templates.default)
        : templates.default;
    if (pair) {
      return {
        header: pair.header ? (pair.header.cloneNode(true) as HTMLElement) : null,
        footer: pair.footer ? (pair.footer.cloneNode(true) as HTMLElement) : null,
      };
    }
  }
  return {
    header: origHeader ? (origHeader.cloneNode(true) as HTMLElement) : null,
    footer: origFooter ? (origFooter.cloneNode(true) as HTMLElement) : null,
  };
}

/**
 * 检测 stageEl 中实际渲染高度超出单页纸张高度的 <section.docx>，
 * 对无预渲染分页符或严重溢出的分节执行块级/段落级/表格级几何自动分页。
 */
export async function paginateOverflowDocxSections(
  stageEl: HTMLElement,
  meta: DocxPaginationMeta,
  options?: PaginateDocxOptions,
): Promise<void> {
  const sections = getTargetSectionElements(stageEl);
  if (sections.length === 0) return;

  const measurer = options?.measurer ?? createDefaultDomMeasurer();
  const maxSectIdx = Math.max(0, meta.sectionMetas.length - 1);
  const templateCache = new Map<number, DocxHeaderFooterTemplates | null>();

  const getTemplatesForSection = async (
    sectIdx: number,
    sectProps: any,
  ): Promise<DocxHeaderFooterTemplates | null> => {
    if (templateCache.has(sectIdx)) {
      return templateCache.get(sectIdx) ?? null;
    }
    if (!options?.renderHeaderFooterTemplates || !sectProps) {
      templateCache.set(sectIdx, null);
      return null;
    }
    try {
      const tpl = await options.renderHeaderFooterTemplates(sectProps);
      templateCache.set(sectIdx, tpl);
      return tpl;
    } catch {
      templateCache.set(sectIdx, null);
      return null;
    }
  };

  let currentSectIdx = 0;
  let globalPageIndex = 0;

  for (let sIdx = 0; sIdx < sections.length; sIdx += 1) {
    const origSection = sections[sIdx];
    const endedIdx = findMaxEndedSectionIndex(origSection);
    const sectIdx = endedIdx !== null ? Math.min(endedIdx, maxSectIdx) : currentSectIdx;
    const sectProps = meta.sectionMetas[sectIdx]?.sectProps;

    if (endedIdx !== null) {
      currentSectIdx = Math.min(sectIdx + 1, maxSectIdx);
    }

    const pageMinHeightPx = measurer.getSectionMinHeightPx(origSection);
    const sectionHeightPx = measurer.getSectionHeightPx(origSection);

    const overflowThreshold = meta.hasLastRenderedPageBreak
      ? pageMinHeightPx * RENDERED_BREAK_OVERFLOW_RATIO
      : pageMinHeightPx + SECTION_OVERFLOW_TOLERANCE_PX;

    if (pageMinHeightPx <= 0 || sectionHeightPx <= overflowThreshold) {
      globalPageIndex += 1;
      continue;
    }

    const articles = getDirectChildrenByTag(origSection, 'ARTICLE');
    if (articles.length === 0) {
      globalPageIndex += 1;
      continue;
    }

    // 仅存在单一多栏 <article> 时跳过内部拆页，避免破坏多栏流
    if (articles.length === 1 && measurer.getArticleColumnCount(articles[0]) > 1) {
      globalPageIndex += 1;
      continue;
    }

    const maxArticleHeightPx = measurer.getMaxArticleHeightPx(origSection, pageMinHeightPx);
    if (maxArticleHeightPx <= 0) {
      globalPageIndex += 1;
      continue;
    }

    const origHeaders = getDirectChildrenByTag(origSection, 'HEADER');
    const origFooters = getDirectChildrenByTag(origSection, 'FOOTER');
    const origNotes = getDirectChildrenByTag(origSection, 'OL');
    const origHeader = origHeaders[0] ?? null;
    const origFooter = origFooters[origFooters.length - 1] ?? null;

    const plannedPages = planSingleSectionPages(origSection, articles, maxArticleHeightPx, measurer);
    if (plannedPages.length <= 1) {
      globalPageIndex += 1;
      continue;
    }

    const needsSpecialTemplates = Boolean(sectProps?.titlePage || meta.evenAndOddHeaders);
    const templates = needsSpecialTemplates
      ? await getTemplatesForSection(sectIdx, sectProps)
      : null;

    const newSectionElements: HTMLElement[] = [];

    for (let localIdx = 0; localIdx < plannedPages.length; localIdx += 1) {
      const pagePlan = plannedPages[localIdx];
      const pageSection = origSection.cloneNode(false) as HTMLElement;
      stripDuplicateIds(pageSection);

      let pageHeader: HTMLElement | null;
      let pageFooter: HTMLElement | null;

      if (localIdx === 0) {
        pageHeader = origHeader ? (origHeader.cloneNode(true) as HTMLElement) : null;
        pageFooter = origFooter ? (origFooter.cloneNode(true) as HTMLElement) : null;
      } else {
        const pair = selectHeaderFooterPair(
          templates,
          meta.evenAndOddHeaders,
          globalPageIndex,
          origHeader,
          origFooter,
        );
        pageHeader = pair.header;
        pageFooter = pair.footer;
      }

      if (pageHeader) {
        stripDuplicateIds(pageHeader);
        pageSection.appendChild(pageHeader);
      }

      for (const artPlan of pagePlan.articles) {
        const artEl = artPlan.templateArticle.cloneNode(false) as HTMLElement;
        stripDuplicateIds(artEl);
        for (const blk of artPlan.blocks) {
          artEl.appendChild(blk);
        }
        pageSection.appendChild(artEl);
      }

      if (localIdx === plannedPages.length - 1) {
        for (const noteList of origNotes) {
          pageSection.appendChild(noteList);
        }
      }

      if (pageFooter) {
        stripDuplicateIds(pageFooter);
        pageSection.appendChild(pageFooter);
      }

      newSectionElements.push(pageSection);
      globalPageIndex += 1;
    }

    const parentNode = origSection.parentNode;
    if (parentNode) {
      for (const newSec of newSectionElements) {
        parentNode.insertBefore(newSec, origSection);
      }
      origSection.remove();
    }
  }
}
