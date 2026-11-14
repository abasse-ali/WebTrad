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
    // A few dozen ink pixels already make a short word ("I...") at small sizes.
    if (ink < 6 || ink > c.area * 0.6) continue;
    const inkBox = { x: ix0, y: iy0, w: ix1 - ix0 + 1, h: iy1 - iy0 + 1 };
    // Text should sit well inside the bubble, not be a line hugging its border.
    if (inkBox.w < 6 || inkBox.h < 6) continue;
    regions.push({ x: c.x0, y: c.y0, w: c.x1 - c.x0 + 1, h, spans, area: c.area, inkBox, ink });
  }
  return regions;
}

/**
 * Bubbles of every kind. Thought bubbles with a soft, grainy rim on a light
 * background (pink, grey) blend into it at the usual threshold and come out
 * as one huge rejected area: a stricter pass finds their pure-white inside.
 */
export function detectAllBubbles(px: Pixels): BubbleRegion[] {
  const regions = detectBubbles(px);
  const overlap = (a: Box, b: Box) => {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? (w * h) / Math.min(a.w * a.h, b.w * b.h) : 0;
  };
  for (const strict of detectBubbles(px, { bright: 240 })) {
    if (!regions.some((r) => overlap(r, strict) > 0.5)) regions.push(strict);
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

// --- look of the original lettering ---------------------------------------------

export interface InkInfo {
  /** Colour of the letters as #rrggbb (near-black and near-white are snapped). */
  color: string;
  /** Exact colours to erase: the letters and, when they are outlined, their outline. */
  tones: [number, number, number][];
}

const colorDistance = (data: Uint8ClampedArray, i: number, c: readonly number[]) =>
  Math.abs(data[i] - c[0]) + Math.abs(data[i + 1] - c[1]) + Math.abs(data[i + 2] - c[2]);

function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

const toHex = (c: readonly number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

export function parseHex(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * Colour of the lettering inside a box: the pixels that stand out from the
 * background, darker or lighter, whichever group is bigger. The other group,
 * when sizeable, is the outline of the letters.
 */
export function sampleInk(px: Pixels, box: Box, background: string): InkInfo | null {
  const { data, width: W, height: H } = px;
  const bg = parseHex(background);
  const bgLum = (bg[0] * 299 + bg[1] * 587 + bg[2] * 114) / 1000;
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(W, Math.round(box.x + box.w));
  const y1 = Math.min(H, Math.round(box.y + box.h));
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 20000)));
  const dark: number[][] = [[], [], []];
  const light: number[][] = [[], [], []];
  // Pixels of each group that sit right next to the background: an outline
  // touches it, the letters it surrounds do not.
  let darkEdge = 0;
  let lightEdge = 0;
  const isBackground = (x: number, y: number) => x < 0 || x >= W || colorDistance(data, (y * W + x) * 4, bg) < 110;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * W + x) * 4;
      if (colorDistance(data, i, bg) < 110) continue;
      const isDark = luminance(data, i) < bgLum;
      const edge = isBackground(x - 3, y) || isBackground(x + 3, y) ? 1 : 0;
      if (isDark) darkEdge += edge;
      else lightEdge += edge;
      const group = isDark ? dark : light;
      group[0].push(data[i]);
      group[1].push(data[i + 1]);
      group[2].push(data[i + 2]);
    }
  }
  let [main, other] = dark[0].length >= light[0].length ? [dark, light] : [light, dark];
  if (main[0].length < 12) return null;
  const outlined = other[0].length >= Math.max(12, main[0].length * 0.25);
  if (outlined) {
    // Outlined letters: the outline can weigh as much as the letters. The
    // letters are the group that is cut off from the background.
    const edgeShare = (g: number[][]) => (g === dark ? darkEdge : lightEdge) / g[0].length;
    if (edgeShare(main) > edgeShare(other) * 1.5) [main, other] = [other, main];
  }
  // Small lettering is mostly anti-aliased edge: take the half of the pixels
  // furthest from the background (the core of the strokes), not all of them.
  const core = (g: number[][]): number[][] => {
    const idx = g[0].map((_, i) => i);
    const lum = (i: number) => (g[0][i] * 299 + g[1][i] * 587 + g[2][i] * 114) / 1000;
    idx.sort((a, b) => Math.abs(lum(b) - bgLum) - Math.abs(lum(a) - bgLum));
    const keep = idx.slice(0, Math.max(6, Math.ceil(idx.length / 2)));
    return [keep.map((i) => g[0][i]), keep.map((i) => g[1][i]), keep.map((i) => g[2][i])];
  };
  const strokes = core(main);
  const rgb: [number, number, number] = [medianOf(strokes[0]), medianOf(strokes[1]), medianOf(strokes[2])];
  const tones = [rgb];
  if (outlined) tones.push([medianOf(other[0]), medianOf(other[1]), medianOf(other[2])]);
  const lum = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
  const spread = Math.max(...rgb) - Math.min(...rgb);
  const color = lum < 60 && spread < 40 ? '#111111' : lum > 228 && spread < 30 ? '#ffffff' : toHex(rgb);
  return { color, tones };
}

/**
 * Removes lettering drawn over artwork: pixels close to the ink colours are
 * masked (plus a margin for anti-aliasing) and filled from their surroundings,
 * layer by layer from the edge of each letter inwards. Returns the repaired
 * crop, or null when too much of the box would have to be invented.
 */
export function inpaintText(
  px: Pixels,
  box: Box,
  tones: readonly (readonly number[])[],
  margin: number,
  /** Limits what may be erased (page coordinates of `px`), e.g. to a tilted band. */
  within?: (x: number, y: number) => boolean,
): Pixels | null {
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const w = Math.min(px.width, Math.round(box.x + box.w)) - x0;
  const h = Math.min(px.height, Math.round(box.y + box.h)) - y0;
  if (w < 4 || h < 4 || tones.length === 0) return null;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const start = ((y0 + y) * px.width + x0) * 4;
    out.set(px.data.subarray(start, start + w * 4), y * w * 4);
  }
  let mask = new Uint8Array(w * h);
  for (let p = 0; p < mask.length; p++) {
    if (within && !within(x0 + (p % w), y0 + Math.floor(p / w))) continue;
    if (tones.some((c) => colorDistance(out, p * 4, c) < 120)) mask[p] = 1;
  }
  // Grow the mask over the blurred rim of the letters.
  const grow = Math.max(1, Math.min(6, Math.round(margin)));
  for (let pass = 0; pass < grow; pass++) {
    const next = mask.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (mask[p]) continue;
        if ((x > 0 && mask[p - 1]) || (x < w - 1 && mask[p + 1]) || (y > 0 && mask[p - w]) || (y < h - 1 && mask[p + w])) next[p] = 1;
      }
    }
    mask = next;
  }
  let masked = 0;
  for (let p = 0; p < mask.length; p++) masked += mask[p];
  if (masked === 0 || masked > mask.length * 0.75) return null;
  const hole = mask.slice();
  // Onion peel: every pass fills the masked pixels that touch known ones.
  for (let guard = 0; masked > 0 && guard < w + h; guard++) {
    const filled: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!mask[p]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const q = yy * w + xx;
            if (mask[q]) continue;
            r += out[q * 4];
            g += out[q * 4 + 1];
            b += out[q * 4 + 2];
            n++;
          }
        }
        if (n === 0) continue;
        out[p * 4] = r / n;
        out[p * 4 + 1] = g / n;
        out[p * 4 + 2] = b / n;
        out[p * 4 + 3] = 255;
        filled.push(p);
      }
    }
    if (filled.length === 0) return null; // nothing known to start from
    for (const p of filled) mask[p] = 0;
    masked -= filled.length;
  }
  // Soften the filled area so the layers do not show.
  for (let pass = 0; pass < 2; pass++) {
    const src = out.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (!hole[p]) continue;
        for (let c = 0; c < 3; c++) {
          out[p * 4 + c] =
            (src[p * 4 + c] * 4 + src[(p - 1) * 4 + c] + src[(p + 1) * 4 + c] + src[(p - w) * 4 + c] + src[(p + w) * 4 + c]) / 8;
        }
      }
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Erases the lettering of a plain bubble without leaving its outline: inside
 * `rect`, every pixel of the bubble interior that differs from the fill (the
 * letters, their anti-aliasing, stray dots OCR boxes missed) is painted with
 * the fill. Pixels outside the bubble shape are kept, so nothing sticks out
 * of a round or grainy bubble. Returns the repaired crop of `rect`.
 */
export function cleanBubble(px: Pixels, region: BubbleRegion, rect: Box, fill: string): { pixels: Pixels; x: number; y: number } {
  const color = parseHex(fill);
  const x0 = Math.max(region.x, Math.floor(rect.x));
  const y0 = Math.max(region.y, Math.floor(rect.y));
  const x1 = Math.min(region.x + region.w, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(region.y + region.h, Math.ceil(rect.y + rect.h));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = new Uint8ClampedArray(w * h * 4);
  const mask = new Uint8Array(w * h);
  const inside = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y0 + y - region.y;
    const minX = region.spans[r * 2];
    const maxX = region.spans[r * 2 + 1];
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * px.width + (x0 + x)) * 4;
      const di = (y * w + x) * 4;
      out[di] = px.data[si];
      out[di + 1] = px.data[si + 1];
      out[di + 2] = px.data[si + 2];
      out[di + 3] = 255;
      const ax = x0 + x;
      // Two pixels away from the rim: the outline of the bubble stays.
      if (minX < 0 || ax < minX + 2 || ax > maxX - 2) continue;
      inside[y * w + x] = 1;
      if (colorDistance(px.data, si, color) > 45) mask[y * w + x] = 1;
    }
  }
  // One more pixel around each letter for the faint edge of anti-aliasing.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!inside[p] || mask[p] === 1) continue;
      if ((x > 0 && mask[p - 1] === 1) || (x < w - 1 && mask[p + 1] === 1) || (y > 0 && mask[p - w] === 1) || (y < h - 1 && mask[p + w] === 1)) mask[p] = 2;
    }
  }
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    out[p * 4] = color[0];
    out[p * 4 + 1] = color[1];
    out[p * 4 + 2] = color[2];
  }
  return { pixels: { data: out, width: w, height: h }, x: x0, y: y0 };
}

/**
 * Tilt of the lettering inside a region, in degrees clockwise: the angle at
 * which the ink pixels line up best in rows (projection profile). Does not
 * depend on how the OCR cut the text into lines. 0 when there is too little ink.
 */
export function textSkew(px: Pixels, region: BubbleRegion, maxAngle = 25): number {
  const { data, width: W } = px;
  const xs: number[] = [];
  const ys: number[] = [];
  const { x: bx, y: by, w: bw, h: bh } = region.inkBox;
  const step = Math.max(1, Math.round(Math.sqrt((bw * bh) / 20000)));
  for (let y = by; y < by + bh; y += step) {
    const r = y - region.y;
    const minX = region.spans[r * 2];
    const maxX = region.spans[r * 2 + 1];
    if (minX < 0) continue;
    for (let x = Math.max(bx, minX + 3); x < Math.min(bx + bw, maxX - 2); x += step) {
      if (luminance(data, (y * W + x) * 4) < 140) {
        xs.push(x - bx);
        ys.push(y - by);
      }
    }
  }
  if (xs.length < 40) return 0;
  const diag = Math.ceil(Math.hypot(bw, bh)) + 2;
  const bins = new Float64Array(diag * 2);
  let best = 0;
  let bestScore = -1;
  for (let a = -maxAngle; a <= maxAngle; a += 0.5) {
    const t = (a * Math.PI) / 180;
    const sin = Math.sin(t);
    const cos = Math.cos(t);
    bins.fill(0);
    for (let i = 0; i < xs.length; i++) {
      const v = Math.round(-xs[i] * sin + ys[i] * cos) + diag;
      bins[v]++;
    }
    // Sharp rows (all the ink of a line in few bins) give a high sum of squares.
    let score = 0;
    for (let i = 0; i < bins.length; i++) score += bins[i] * bins[i];
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) < 1e-9 && Math.abs(a) < Math.abs(best))) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}
