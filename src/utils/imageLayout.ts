export const MIN_IMAGE_ZOOM = 0.1;
export const MAX_IMAGE_ZOOM = 8.0;

export type NormalizedRotation = 0 | 90 | 180 | 270;

export interface ImageDisplayMetricsInput {
  naturalWidth: number;
  naturalHeight: number;
  rotation: number;
  viewportWidth: number;
  viewportHeight: number;
  paddingX?: number;
  paddingY?: number;
  fitMode: boolean;
  zoom: number;
}

export interface ImageDisplayMetrics {
  rotation: NormalizedRotation;
  scale: number;
  boxWidth: number;
  boxHeight: number;
  rotatedWidth: number;
  rotatedHeight: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 将任意角度（以 90° 为步进）归一化为 0 / 90 / 180 / 270。
 */
export function normalizeImageRotation(deg: number): NormalizedRotation {
  if (!Number.isFinite(deg)) return 0;
  const snapped = Math.round(deg / 90) * 90;
  const mod = ((snapped % 360) + 360) % 360;
  if (mod === 90 || mod === 180 || mod === 270) {
    return mod;
  }
  return 0;
}

/**
 * 计算图片在适应视口或指定缩放比下的渲染尺寸与旋转外接包围盒尺寸。
 * 适应视口模式下将最大缩放比封顶为 100%，避免小图标被过度放大模糊。
 */
export function computeImageDisplayMetrics(input: ImageDisplayMetricsInput): ImageDisplayMetrics {
  const rotation = normalizeImageRotation(input.rotation);
  const isQuarterTurn = rotation === 90 || rotation === 270;

  const natW = Math.max(1, Number.isFinite(input.naturalWidth) ? input.naturalWidth : 1);
  const natH = Math.max(1, Number.isFinite(input.naturalHeight) ? input.naturalHeight : 1);
  const rotatedNatW = isQuarterTurn ? natH : natW;
  const rotatedNatH = isQuarterTurn ? natW : natH;

  const padX = Math.max(0, input.paddingX ?? 32);
  const padY = Math.max(0, input.paddingY ?? 32);
  const availW = Math.max(32, (Number.isFinite(input.viewportWidth) ? input.viewportWidth : 0) - padX);
  const availH = Math.max(32, (Number.isFinite(input.viewportHeight) ? input.viewportHeight : 0) - padY);

  let rawScale: number;
  if (input.fitMode) {
    const fitRatio = Math.min(1, availW / rotatedNatW, availH / rotatedNatH);
    rawScale = Math.floor(fitRatio * 1000 + 1e-9) / 1000;
  } else {
    rawScale = Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1;
  }

  const scale = clamp(Math.round(rawScale * 1000) / 1000, MIN_IMAGE_ZOOM, MAX_IMAGE_ZOOM);
  const boxWidth = Math.max(1, Math.round(natW * scale));
  const boxHeight = Math.max(1, Math.round(natH * scale));
  const rotatedWidth = isQuarterTurn ? boxHeight : boxWidth;
  const rotatedHeight = isQuarterTurn ? boxWidth : boxHeight;

  return {
    rotation,
    scale,
    boxWidth,
    boxHeight,
    rotatedWidth,
    rotatedHeight,
  };
}
