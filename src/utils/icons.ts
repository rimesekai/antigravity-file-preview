const SVG_NS = 'http://www.w3.org/2000/svg';

export type IconName =
  | 'folder'
  | 'folderOpen'
  | 'refresh'
  | 'search'
  | 'close'
  | 'chevronLeft'
  | 'chevronRight'
  | 'chevronUp'
  | 'chevronDown'
  | 'plus'
  | 'minus'
  | 'fit'
  | 'slideMode'
  | 'scrollMode'
  | 'thumbnails'
  | 'palette'
  | 'globe'
  | 'copy'
  | 'check'
  | 'upload'
  | 'alert'
  | 'shield'
  | 'play'
  | 'code'
  | 'rotateLeft'
  | 'rotateRight'
  | 'music'
  | 'fileText';

interface IconShape {
  paths?: string[];
  circles?: Array<{ cx: number; cy: number; r: number }>;
  rects?: Array<{ x: number; y: number; width: number; height: number; rx?: number }>;
  polylines?: string[];
}

const ICON_MAP: Record<IconName, IconShape> = {
  folder: {
    paths: ['M3 6a2 2 0 0 1 2-2h4.2l1.8 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  },
  folderOpen: {
    paths: [
      'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2',
    ],
  },
  refresh: {
    paths: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 4v5h-5'],
  },
  search: {
    circles: [{ cx: 11, cy: 11, r: 7 }],
    paths: ['M20 20l-3.65-3.65'],
  },
  close: {
    paths: ['M18 6L6 18', 'M6 6l12 12'],
  },
  chevronLeft: {
    polylines: ['15 18 9 12 15 6'],
  },
  chevronRight: {
    polylines: ['9 18 15 12 9 6'],
  },
  chevronUp: {
    polylines: ['18 15 12 9 6 15'],
  },
  chevronDown: {
    polylines: ['6 9 12 15 18 9'],
  },
  plus: {
    paths: ['M12 5v14', 'M5 12h14'],
  },
  minus: {
    paths: ['M5 12h14'],
  },
  fit: {
    paths: [
      'M8 3H5a2 2 0 0 0-2 2v3',
      'M21 8V5a2 2 0 0 0-2-2h-3',
      'M3 16v3a2 2 0 0 0 2 2h3',
      'M16 21h3a2 2 0 0 0 2-2v-3',
    ],
  },
  slideMode: {
    rects: [{ x: 3, y: 5, width: 18, height: 14, rx: 3 }],
    paths: ['M9 12h6'],
  },
  scrollMode: {
    rects: [
      { x: 4, y: 3.5, width: 16, height: 7, rx: 2 },
      { x: 4, y: 13.5, width: 16, height: 7, rx: 2 },
    ],
  },
  thumbnails: {
    rects: [{ x: 3, y: 4, width: 18, height: 16, rx: 3 }],
    paths: ['M9 4v16'],
  },
  palette: {
    paths: [
      'M12 21a9 9 0 1 1 8.85-10.6c.24 1.38-.78 2.6-2.18 2.6H16.5a2 2 0 0 0-2 2c0 .62.26 1.2.62 1.67.53.68.12 1.69-.73 1.98A9 9 0 0 1 12 21z',
    ],
    circles: [
      { cx: 7.5, cy: 10.5, r: 1 },
      { cx: 10.5, cy: 7.5, r: 1 },
      { cx: 14.5, cy: 7.5, r: 1 },
    ],
  },
  globe: {
    circles: [{ cx: 12, cy: 12, r: 9 }],
    paths: ['M3.5 9h17', 'M3.5 15h17', 'M12 3a13.5 13.5 0 0 1 0 18', 'M12 3a13.5 13.5 0 0 0 0 18'],
  },
  copy: {
    rects: [{ x: 9, y: 9, width: 11, height: 11, rx: 2.2 }],
    paths: ['M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  },
  check: {
    polylines: ['20 6 9 17 4 12'],
  },
  upload: {
    paths: ['M12 15V4', 'M7.5 8.5L12 4l4.5 4.5', 'M4 16.5v1.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5'],
  },
  alert: {
    circles: [{ cx: 12, cy: 12, r: 9 }],
    paths: ['M12 8v5', 'M12 16.2h.01'],
  },
  shield: {
    paths: ['M12 3l7 3v5c0 4.8-3 8.6-7 10-4-1.4-7-5.2-7-10V6l7-3z'],
  },
  play: {
    paths: ['M8 6l10 6-10 6V6z'],
  },
  code: {
    polylines: ['8 7 3 12 8 17', '16 7 21 12 16 17'],
    paths: ['M13.5 5.5l-3 13'],
  },
  rotateLeft: {
    paths: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5'],
  },
  rotateRight: {
    paths: ['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5'],
  },
  music: {
    paths: ['M9 18V5l12-2v13'],
    circles: [
      { cx: 6, cy: 18, r: 3 },
      { cx: 18, cy: 16, r: 3 },
    ],
  },
  fileText: {
    paths: [
      'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z',
      'M14 3v5h5',
      'M9 13h6',
      'M9 17h4',
    ],
  },
};

/**
 * 创建统一圆润笔触风格的矢量图标 SVG（遵循 `icons` 规范：currentColor + aria-hidden="true"）。
 */
export function createIcon(name: IconName, size = 16, strokeWidth = 1.9): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const shape = ICON_MAP[name];
  if (shape.rects) {
    for (const r of shape.rects) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(r.x));
      rect.setAttribute('y', String(r.y));
      rect.setAttribute('width', String(r.width));
      rect.setAttribute('height', String(r.height));
      if (r.rx !== undefined) rect.setAttribute('rx', String(r.rx));
      svg.appendChild(rect);
    }
  }
  if (shape.circles) {
    for (const c of shape.circles) {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(c.cx));
      circle.setAttribute('cy', String(c.cy));
      circle.setAttribute('r', String(c.r));
      svg.appendChild(circle);
    }
  }
  if (shape.polylines) {
    for (const pts of shape.polylines) {
      const pl = document.createElementNS(SVG_NS, 'polyline');
      pl.setAttribute('points', pts);
      svg.appendChild(pl);
    }
  }
  if (shape.paths) {
    for (const d of shape.paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
  }

  return svg;
}
