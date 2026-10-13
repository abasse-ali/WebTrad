/**
 * Small image-processing toolkit working on raw RGBA pixels:
 *  - speech-bubble detection (bright connected regions that contain dark text)
 *  - background colour estimation for erasing text
 *  - largest text area that fits inside a bubble
 * Everything is plain TypeScript so it runs in the main thread or a worker.
 */
import type { Box } from './text';

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface BubbleRegion extends Box {
  /** Per-row horizontal extent of the bubble interior, relative to `y`. */
  spans: Int32Array; // [minX0, maxX0, minX1, maxX1, ...] (absolute x), -1 when empty
  area: number;
  /** Dark pixels enclosed by the bubble (≈ text). */
  inkBox: Box;
  ink: number;
}

export function luminance(data: Uint8ClampedArray, i: number): number {
  return (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
}

/**
 * Finds speech bubbles: connected regions of bright pixels, large enough,
 * not spanning the whole page, and containing enclosed dark "ink".
 */
export function detectBubbles(px: Pixels, opts: { bright?: number; minSide?: number } = {}): BubbleRegion[] {
  const { data, width: W, height: H } = px;
  const bright = opts.bright ?? 200;
  const minSide = opts.minSide ?? Math.max(24, Math.round(W * 0.04));
  const lum = new Uint8Array(W * H);
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) lum[p] = luminance(data, i);

  const labels = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  const comps: { id: number; x0: number; y0: number; x1: number; y1: number; area: number }[] = [];
  let next = 1;
  for (let start = 0; start < lum.length; start++) {
    if (labels[start] !== 0 || lum[start] < bright) continue;
    const id = next++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % W;
      const y = (p - x) / W;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && labels[p - 1] === 0 && lum[p - 1] >= bright) { labels[p - 1] = id; stack[sp++] = p - 1; }
      if (x < W - 1 && labels[p + 1] === 0 && lum[p + 1] >= bright) { labels[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && labels[p - W] === 0 && lum[p - W] >= bright) { labels[p - W] = id; stack[sp++] = p - W; }
      if (y < H - 1 && labels[p + W] === 0 && lum[p + W] >= bright) { labels[p + W] = id; stack[sp++] = p + W; }
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (w < minSide || h < minSide) continue;
    if (w > W * 0.92) continue; // page background / gutter, not a bubble
    if (area < w * h * 0.45) continue; // thin or ragged shape
    comps.push({ id, x0, y0, x1, y1, area });
  }

  const regions: BubbleRegion[] = [];
  for (const c of comps) {
    const h = c.y1 - c.y0 + 1;
    const spans = new Int32Array(h * 2).fill(-1);
    let ink = 0;
    let ix0 = W, iy0 = H, ix1 = -1, iy1 = -1;
    for (let r = 0; r < h; r++) {
      const y = c.y0 + r;
      let minX = -1, maxX = -1;
      for (let x = c.x0; x <= c.x1; x++) {
        if (labels[y * W + x] === c.id) {
          if (minX < 0) minX = x;
          maxX = x;
        }
      }
      spans[r * 2] = minX;
      spans[r * 2 + 1] = maxX;
      if (minX < 0) continue;
      // Skip the inner rim: textured or blurred bubble borders are not text.
      const rim = Math.max(3, Math.round((maxX - minX) * 0.04));
      for (let x = minX + rim; x <= maxX - rim; x++) {
        const p = y * W + x;
        if (labels[p] !== c.id && lum[p] < 128) {
          ink++;
          if (x < ix0) ix0 = x;
          if (x > ix1) ix1 = x;
          if (y < iy0) iy0 = y;
          if (y > iy1) iy1 = y;
        }
      }
    }
    if (ink < 30 || ink > c.area * 0.6) continue;
    const inkBox = { x: ix0, y: iy0, w: ix1 - ix0 + 1, h: iy1 - iy0 + 1 };
    // Text should sit well inside the bubble, not be a line hugging its border.
    if (inkBox.w < 6 || inkBox.h < 6) continue;
    regions.push({ x: c.x0, y: c.y0, w: c.x1 - c.x0 + 1, h, spans, area: c.area, inkBox, ink });
  }
  return regions;
}

/** Copies a region to a new RGBA buffer, painting everything outside the bubble white. */
export function maskedCrop(px: Pixels, region: BubbleRegion, pad = 6): { pixels: Pixels; x: number; y: number } {
  const x0 = Math.max(0, region.x - pad);
  const y0 = Math.max(0, region.y - pad);
  const x1 = Math.min(px.width, region.x + region.w + pad);
  const y1 = Math.min(px.height, region.y + region.h + pad);
  const w = x1 - x0;
  const h = y1 - y0;
  const out = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = y0; y < y1; y++) {
    const r = y - region.y;
    if (r < 0 || r >= region.h) continue;
    const minX = region.spans[r * 2];
    const maxX = region.spans[r * 2 + 1];
    if (minX < 0) continue;
    const from = Math.max(minX, x0);
    const to = Math.min(maxX, x1 - 1);
    for (let x = from; x <= to; x++) {
      const si = (y * px.width + x) * 4;
      const di = ((y - y0) * w + (x - x0)) * 4;
      out[di] = px.data[si];
      out[di + 1] = px.data[si + 1];
      out[di + 2] = px.data[si + 2];
    }
  }
  return { pixels: { data: out, width: w, height: h }, x: x0, y: y0 };
}

/** Largest axis-aligned rectangle centred on (cx, cy) that stays inside the bubble. */
export function innerBox(region: BubbleRegion, cx: number, cy: number, minH: number): Box {
  let best: Box = { x: cx, y: cy, w: 0, h: 0 };
  let bestScore = -1;
  const halfMax = Math.max(Math.round(cy - region.y), Math.round(region.y + region.h - cy));
  const step = Math.max(2, Math.round(region.h / 60));
  for (let half = Math.max(4, Math.round(minH / 2)); half <= halfMax; half += step) {
    const top = Math.round(cy - half);
    const bottom = Math.round(cy + half);
    if (top < region.y || bottom >= region.y + region.h) break;
    let halfW = Infinity;
    for (let y = top; y <= bottom; y++) {
      const r = y - region.y;
      const minX = region.spans[r * 2];
      const maxX = region.spans[r * 2 + 1];
      if (minX < 0) { halfW = 0; break; }
      halfW = Math.min(halfW, cx - minX, maxX - cx);
    }
    if (halfW <= 0 || !Number.isFinite(halfW)) break;
    const w = halfW * 2;
    const h = half * 2;
    // Prefer roomy but not extremely flat or tall areas.
    const aspect = w / h;
    const score = w * h * (aspect > 4 ? 4 / aspect : aspect < 0.5 ? aspect / 0.5 : 1);
    if (score > bestScore) {
      bestScore = score;
      best = { x: cx - halfW, y: top, w, h };
    }
  }
  return best;
}

export interface BackgroundInfo {
  /** Median colour on the box border, as #rrggbb. */
  fill: string;
  /** Share of border pixels close to the median: 1 = flat bubble background. */
  uniformity: number;
  luminance: number;
}

/** Estimates the colour behind a text box by sampling a ring around it. */
export function sampleBackground(px: Pixels, box: Box, ring = 3): BackgroundInfo {
  const { data, width: W, height: H } = px;
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const x0 = Math.max(0, Math.round(box.x) - ring);
  const y0 = Math.max(0, Math.round(box.y) - ring);
  const x1 = Math.min(W - 1, Math.round(box.x + box.w) + ring);
  const y1 = Math.min(H - 1, Math.round(box.y + box.h) + ring);
  const push = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  };
  const stepX = Math.max(1, Math.round((x1 - x0) / 80));
  const stepY = Math.max(1, Math.round((y1 - y0) / 80));
  for (let x = x0; x <= x1; x += stepX) {
    push(x, y0);
    push(x, y1);
  }
  for (let y = y0; y <= y1; y += stepY) {
    push(x0, y);
    push(x1, y);
  }
  const median = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 255;
  };
  const r = median(rs);
  const g = median(gs);
  const b = median(bs);
  let close = 0;
  for (let i = 0; i < rs.length; i++) {
    if (Math.abs(rs[i] - r) + Math.abs(gs[i] - g) + Math.abs(bs[i] - b) < 60) close++;
  }
  const hex = (v: number) => v.toString(16).padStart(2, '0');
  return {
    fill: `#${hex(r)}${hex(g)}${hex(b)}`,
    uniformity: rs.length ? close / rs.length : 1,
    luminance: (r * 299 + g * 587 + b * 114) / 1000,
  };
}

export function contrastColor(fill: string): string {
  const v = parseInt(fill.slice(1), 16);
  const lum = (((v >> 16) & 255) * 299 + ((v >> 8) & 255) * 587 + (v & 255) * 114) / 1000;
  return lum > 140 ? '#111111' : '#ffffff';
}
