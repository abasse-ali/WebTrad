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
  /** The lettering is coloured (pink whispers, red shouts), not dark. */
  tinted?: boolean;
}

/** Coloured lettering on paper: clearly not white, clearly a colour. */
function isTint(data: Uint8ClampedArray, i: number): boolean {
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  return Math.max(r, g, b) - Math.min(r, g, b) >= 60 && (r * 299 + g * 587 + b * 114) / 1000 < 215;
}

export function luminance(data: Uint8ClampedArray, i: number): number {
  return (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
}

/**
 * A bright area is a bubble when its inside is plain paper: no colour
 * (lit skin is pink, a lamp is yellow) and flat (a white shirt, a fist or
 * a highlight has shading). Measured on the middle of the area, where the
 * lettering and a grainy rim weigh least; dark pixels (the letters) and the
 * grey of anti-aliasing around them are left out.
 */
export function looksLikeBubble(
  data: Uint8ClampedArray,
  labels: Int32Array,
  id: number,
  W: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  maxSpread = 9,
  maxChroma = 22,
): boolean {
  const mx = Math.round((x1 - x0) * 0.2);
  const my = Math.round((y1 - y0) * 0.2);
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)));
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  let chroma = 0;
  for (let y = y0 + my; y <= y1 - my; y += step) {
    for (let x = x0 + mx; x <= x1 - mx; x += step) {
      const p = y * W + x;
      if (labels[p] !== id) continue;
      const i = p * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const l = (r * 299 + g * 587 + b * 114) / 1000;
      n++;
      sum += l;
      sumSq += l * l;
      chroma += Math.max(r, g, b) - Math.min(r, g, b);
    }
  }
  if (n < 12) return true; // too small to judge: the other checks decide
  const mean = sum / n;
  const spread = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return chroma / n < maxChroma && spread < maxSpread;
}

/**
 * Lettering switches between ink and paper many times along a line (every
 * stroke of every letter); the folds of a white shirt or the outline of an
 * arm cross a row once or twice. Counted on the rows that hold ink, per 100
 * pixels of width.
 */
export function looksLikeLettering(lum: Uint8Array, W: number, box: Box, isInk?: (p: number) => boolean): boolean {
  let rows = 0;
  let switches = 0;
  for (let y = box.y; y < box.y + box.h; y++) {
    let prev = false;
    let n = 0;
    for (let x = box.x; x < box.x + box.w; x++) {
      const dark = isInk ? isInk(y * W + x) : lum[y * W + x] < 128;
      if (dark !== prev) n++;
      prev = dark;
    }
    if (n > 0) {
      rows++;
      switches += n;
    }
  }
  if (rows === 0) return false;
  // Narrow ink ("I…", "!") is judged on its own width, but never below 4 switches a row.
  return switches / rows >= Math.min(4, Math.max(2, (box.w / 100) * 5));
}

/**
 * Finds speech bubbles: connected regions of bright pixels, large enough,
 * not spanning the whole page, and containing enclosed dark "ink".
 */
export function detectBubbles(px: Pixels, opts: { bright?: number; minSide?: number; shaded?: boolean } = {}): BubbleRegion[] {
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
    // Bubbles are ellipses or rounded boxes (≥ 0.78 of their box); clothes and
    // highlights are ragged. A little margin for grainy rims and letters.
    if (area < w * h * 0.6) continue;
    // Shaded ones: pure grey (no colour at all), gradients and highlights allowed.
    if (!looksLikeBubble(data, labels, id, W, x0, y0, x1, y1, opts.shaded ? 36 : 9, opts.shaded ? 6 : 22)) continue;
    // Shaded (grey, glossy) bubbles are only taken on a dark page, where
    // nothing else light and round holds lettering.
    // They are wide ovals inside the page (a lit desk or wall is tall, or cut by the edge).
    if (opts.shaded && (w < h * 0.9 || area < w * h * 0.7 || x0 <= 2 || x1 >= W - 3 || ringLuminance(data, W, H, x0, y0, x1, y1) > 150)) continue;
    comps.push({ id, x0, y0, x1, y1, area });
  }

  const regions: BubbleRegion[] = [];
  for (const c of comps) {
    const h = c.y1 - c.y0 + 1;
    const spans = new Int32Array(h * 2).fill(-1);
    let ink = 0;
    let ix0 = W, iy0 = H, ix1 = -1, iy1 = -1;
    // Coloured lettering (pink, red…), counted apart: used when there is no dark ink.
    let tint = 0;
    let tx0 = W, ty0 = H, tx1 = -1, ty1 = -1;
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
        if (labels[p] === c.id) continue;
        if (lum[p] < 128) {
          ink++;
          if (x < ix0) ix0 = x;
          if (x > ix1) ix1 = x;
          if (y < iy0) iy0 = y;
          if (y > iy1) iy1 = y;
        } else if (isTint(data, p * 4)) {
          tint++;
          if (x < tx0) tx0 = x;
          if (x > tx1) tx1 = x;
          if (y < ty0) ty0 = y;
          if (y > ty1) ty1 = y;
        }
      }
    }
    // Coloured marks and (almost) no dark ink: a bubble lettered in colour.
    const tinted = tint >= 24 && tint > ink * 3;
    if (tinted) {
      ink = tint;
      ix0 = tx0;
      iy0 = ty0;
      ix1 = tx1;
      iy1 = ty1;
    }
    // A few dozen ink pixels already make a short word ("I...") at small sizes.
    if (ink < 6 || ink > c.area * 0.6) continue;
    const inkBox = { x: ix0, y: iy0, w: ix1 - ix0 + 1, h: iy1 - iy0 + 1 };
    // Text should sit well inside the bubble, not be a line hugging its border.
    if (inkBox.w < 6 || inkBox.h < 6) continue;
    // Its ink must look like letters, not like the folds of a white shirt.
    if (!looksLikeLettering(lum, W, inkBox, tinted ? (p) => lum[p] >= 128 && isTint(data, p * 4) : undefined)) continue;
    regions.push({ x: c.x0, y: c.y0, w: c.x1 - c.x0 + 1, h, spans, area: c.area, inkBox, ink, ...(tinted ? { tinted } : {}) });
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
  // Whispered lines: grey bubbles with a gradient and a glossy highlight,
  // on a dark page. Missed above (not plain white), their text was taken
  // for part of the artwork: blurred away, or left in English.
  for (const shaded of detectBubbles(px, { bright: 170, shaded: true })) {
    if (!regions.some((r) => overlap(r, shaded) > 0.3)) regions.push(shaded);
  }
  return regions;
}

/** Mean luminance just outside a box (a few pixels around it). */
function ringLuminance(data: Uint8ClampedArray, W: number, H: number, x0: number, y0: number, x1: number, y1: number): number {
  const d = 4;
  let sum = 0;
  let n = 0;
  const add = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    sum += luminance(data, (y * W + x) * 4);
    n++;
  };
  for (let x = x0 - d; x <= x1 + d; x += 2) {
    add(x, y0 - d);
    add(x, y1 + d);
  }
  for (let y = y0 - d; y <= y1 + d; y += 2) {
    add(x0 - d, y);
    add(x1 + d, y);
  }
  return n ? sum / n : 255;
}

/**
 * The bubble around some lettering, found from the lettering itself: the
 * light paper it sits on, flooded from `seed` (a box on the letters) until
 * its outline. Finds the bubbles `detectBubbles` leaves out for their shape:
 * spiky shouts, torn or jagged rims, bubbles as wide as the page, or holding
 * only "…?". Null when the paper is not enclosed (the page background),
 * is not plain (a white shirt, a lit wall) or holds no ink.
 */
export function enclosingBubble(px: Pixels, seed: Box, bright = 200): BubbleRegion | null {
  const { data, width: W, height: H } = px;
  // A bubble is never much taller than the page is wide: the search stays in a window.
  const reach = Math.round(W * 0.9);
  const wy0 = Math.max(0, Math.floor(seed.y) - reach);
  const wy1 = Math.min(H, Math.ceil(seed.y + seed.h) + reach);
  const wh = wy1 - wy0;
  if (wh <= 0) return null;
  const seen = new Uint8Array(W * wh);
  const stack: number[] = [];
  const isBright = (x: number, y: number) => luminance(data, (y * W + x) * 4) >= bright;
  const sx0 = Math.max(0, Math.floor(seed.x) - 2);
  const sx1 = Math.min(W - 1, Math.ceil(seed.x + seed.w) + 2);
  const sy0 = Math.max(wy0, Math.floor(seed.y) - 2);
  const sy1 = Math.min(wy1 - 1, Math.ceil(seed.y + seed.h) + 2);
  for (let y = sy0; y <= sy1; y++) {
    for (let x = sx0; x <= sx1; x++) {
      const q = (y - wy0) * W + x;
      if (!seen[q] && isBright(x, y)) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  if (stack.length === 0) return null;
  let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0;
  while (stack.length > 0) {
    const q = stack.pop()!;
    const x = q % W;
    const wy = (q - x) / W;
    const y = wy + wy0;
    area++;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (x > 0 && !seen[q - 1] && isBright(x - 1, y)) { seen[q - 1] = 1; stack.push(q - 1); }
    if (x < W - 1 && !seen[q + 1] && isBright(x + 1, y)) { seen[q + 1] = 1; stack.push(q + 1); }
    if (wy > 0 && !seen[q - W] && isBright(x, y - 1)) { seen[q - W] = 1; stack.push(q - W); }
    if (wy < wh - 1 && !seen[q + W] && isBright(x, y + 1)) { seen[q + W] = 1; stack.push(q + W); }
  }
  // Paper running out of the window above or below is the page, not a bubble.
  if ((y0 <= wy0 && wy0 > 0) || (y1 >= wy1 - 1 && wy1 < H)) return null;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (h > reach || w < seed.w * 0.8 || h < seed.h * 0.8) return null;
  const spans = new Int32Array(h * 2).fill(-1);
  let n = 0, sum = 0, sumSq = 0, chroma = 0;
  const step = Math.max(1, Math.round(Math.sqrt(area / 4000)));
  for (let r = 0; r < h; r++) {
    const row = (y0 + r - wy0) * W;
    let minX = -1, maxX = -1;
    for (let x = x0; x <= x1; x++) {
      if (!seen[row + x]) continue;
      if (minX < 0) minX = x;
      maxX = x;
      if (r % step === 0 && x % step === 0) {
        const i = ((y0 + r) * W + x) * 4;
        const l = luminance(data, i);
        n++;
        sum += l;
        sumSq += l * l;
        chroma += Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
      }
    }
    spans[r * 2] = minX;
    spans[r * 2 + 1] = maxX;
  }
  // Plain paper only, as for the other bubbles.
  if (n >= 12) {
    const mean = sum / n;
    if (chroma / n >= 22 || Math.sqrt(Math.max(0, sumSq / n - mean * mean)) >= 9) return null;
  }
  // The ink it encloses, away from the rim.
  let ink = 0;
  let ix0 = W, iy0 = H, ix1 = -1, iy1 = -1;
  for (let r = 0; r < h; r++) {
    const minX = spans[r * 2];
    const maxX = spans[r * 2 + 1];
    if (minX < 0) continue;
    const y = y0 + r;
    const row = (y - wy0) * W;
    const rim = Math.max(3, Math.round((maxX - minX) * 0.04));
    for (let x = minX + rim; x <= maxX - rim; x++) {
      if (seen[row + x] || luminance(data, (y * W + x) * 4) >= 128) continue;
      ink++;
      if (x < ix0) ix0 = x;
      if (x > ix1) ix1 = x;
      if (y < iy0) iy0 = y;
      if (y > iy1) iy1 = y;
    }
  }
  if (ink < 6 || ink > area * 0.6) return null;
  return { x: x0, y: y0, w, h, spans, area, inkBox: { x: ix0, y: iy0, w: ix1 - ix0 + 1, h: iy1 - iy0 + 1 }, ink };
}

/** Copies a region to a new RGBA buffer, painting everything outside the bubble white. */
export function maskedCrop(px: Pixels, region: BubbleRegion, pad = 6): { pixels: Pixels; x: number; y: number; ink: Box | null } {
  const x0 = Math.max(0, region.x - pad);
  const y0 = Math.max(0, region.y - pad);
  const x1 = Math.min(px.width, region.x + region.w + pad);
  const y1 = Math.min(px.height, region.y + region.h + pad);
  const w = x1 - x0;
  const h = y1 - y0;
  const out = new Uint8ClampedArray(w * h * 4).fill(255);
  // The inner edge of the bubble is left white: the specks of grainy or spiky
  // rims were read as stray characters ("3 AND I SHOULD… &", "% TISSUES").
  const bandX = Math.max(3, Math.round(region.w * 0.07));
  const bandY = Math.max(3, Math.round(region.h * 0.07));
  // Ink left once the rim is blanked: the lettering alone.
  let ix0 = Infinity, iy0 = Infinity, ix1 = -1, iy1 = -1;
  const inkX: number[] = [];
  const inkY: number[] = [];
  // Ink without colour: the lettering. A watermark crossing the bubble
  // ("TOOMICS.com" in red) is left out when most of the ink is plain.
  const plainX: number[] = [];
  const plainY: number[] = [];
  const top = new Int32Array(region.w).fill(-1);
  const bottom = new Int32Array(region.w).fill(-1);
  for (let r = 0; r < region.h; r++) {
    const minX = region.spans[r * 2];
    const maxX = region.spans[r * 2 + 1];
    if (minX < 0) continue;
    for (let x = minX; x <= maxX; x++) {
      const c = x - region.x;
      if (top[c] < 0) top[c] = r;
      bottom[c] = r;
    }
  }
  for (let y = y0; y < y1; y++) {
    const r = y - region.y;
    if (r < 0 || r >= region.h) continue;
    const minX = region.spans[r * 2];
    const maxX = region.spans[r * 2 + 1];
    if (minX < 0) continue;
    const from = Math.max(minX + bandX, x0);
    const to = Math.min(maxX - bandX, x1 - 1);
    for (let x = from; x <= to; x++) {
      const c = x - region.x;
      if (r < top[c] + bandY || r > bottom[c] - bandY) continue;
      if (region.tinted ? isTint(px.data, (y * px.width + x) * 4) : luminance(px.data, (y * px.width + x) * 4) < 128) {
        if (x < ix0) ix0 = x;
        if (x > ix1) ix1 = x;
        if (y < iy0) iy0 = y;
        if (y > iy1) iy1 = y;
        inkX.push(x);
        inkY.push(y);
        const i = (y * px.width + x) * 4;
        const d = px.data;
        if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) < 70) {
          plainX.push(x);
          plainY.push(y);
        }
      }
      const si = (y * px.width + x) * 4;
      const di = ((y - y0) * w + (x - x0)) * 4;
      out[di] = px.data[si];
      out[di + 1] = px.data[si + 1];
      out[di + 2] = px.data[si + 2];
    }
  }
  const usePlain = !region.tinted && plainX.length >= inkX.length * 0.3;
  const ink = ix1 >= 0 ? (lettering(usePlain ? plainX : inkX, usePlain ? plainY : inkY, region) ?? { x: ix0, y: iy0, w: ix1 - ix0 + 1, h: iy1 - iy0 + 1 }) : null;
  return { pixels: { data: out, width: w, height: h }, x: x0, y: y0, ink };
}

/**
 * Box of the lettering among the dark pixels of a bubble. Grainy or spiky
 * bubble rims leave specks far from the text: taken into the box, they made
 * it nearly as big as the bubble and off-centre, and the translation was
 * then lettered too big, in a tall narrow column, beside the original place.
 * Rows (then columns) holding ink are grouped when they are close; the group
 * holding most ink is the text.
 */
export function lettering(xs: number[], ys: number[], region: Box): Box | null {
  if (xs.length === 0) return null;
  const densest = (values: number[], from: number, size: number, gap: number): [number, number] | null => {
    const counts = new Int32Array(size);
    for (const v of values) counts[v - from]++;
    // A row with one or two dark pixels is a speck, not a line of letters.
    let peak = 0;
    for (const c of counts) peak = Math.max(peak, c);
    const floor = Math.max(1, Math.min(3, Math.round(peak * 0.04)));
    let best: [number, number] | null = null;
    let bestSum = 0;
    let start = -1;
    let end = -1;
    let sum = 0;
    let empty = 0;
    for (let i = 0; i <= size; i++) {
      const on = i < size && counts[i] >= floor;
      if (on) {
        if (start < 0) start = i;
        end = i;
        sum += counts[i];
        empty = 0;
      } else if (start >= 0 && ++empty > gap) {
        if (sum > bestSum) {
          bestSum = sum;
          best = [start + from, end + from];
        }
        start = -1;
        sum = 0;
        empty = 0;
      }
    }
    if (start >= 0 && sum > bestSum) best = [start + from, end + from];
    return best;
  };
  const rows = densest(ys, region.y, region.h, Math.max(4, Math.round(region.h * 0.08)));
  if (!rows) return null;
  const inRows = xs.filter((_, i) => ys[i] >= rows[0] && ys[i] <= rows[1]);
  const cols = densest(inRows, region.x, region.w, Math.max(6, Math.round(region.w * 0.1)));
  if (!cols) return null;
  return { x: cols[0], y: rows[0], w: cols[1] - cols[0] + 1, h: rows[1] - rows[0] + 1 };
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
    // Prefer roomy areas, wider than tall like a block of text: a tall
    // narrow column (a bubble merged with bright artwork below) is avoided.
    const aspect = w / h;
    const score = w * h * (aspect > 4 ? 4 / aspect : aspect < 1.1 ? (aspect / 1.1) ** 2 : 1);
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
 * Clears from `mask` the connected marks that are not lettering: those that
 * touch its border and are longer than a letter, and those far bigger than
 * a line of letters.
 */
function keepLines(mask: Uint8Array, w: number, h: number, maxGlyph: number): void {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const members: number[] = [];
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const p = stack.pop()!;
      members.push(p);
      const x = p % w;
      const y = (p - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (mask[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    const cw = x1 - x0 + 1;
    const ch = y1 - y0 + 1;
    const onBorder = x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1;
    // Lines crossing the box, and shapes far bigger than letters (hair, a shirt of the ink colour).
    if ((onBorder && (cw > maxGlyph || ch > maxGlyph)) || (cw > maxGlyph * 3 && ch > maxGlyph * 3)) for (const p of members) mask[p] = 0;
  }
}

/**
 * The background under a box rebuilt from what lies around it: each pixel
 * blends the colours just left and right of its row with those just above
 * and below its column (a gradient, a shading carries on under the
 * letters), with the grain of the drawing around added. For lettering the
 * letter-by-letter repair leaves readable (screen tones, grainy shading).
 */
export function smoothFill(px: Pixels, box: Box, within?: (x: number, y: number) => boolean): (Pixels & { grain: number }) | null {
  const { width: W, height: H, data } = px;
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const w = Math.min(W, Math.round(box.x + box.w)) - x0;
  const h = Math.min(H, Math.round(box.y + box.h)) - y0;
  if (w < 4 || h < 4) return null;
  const B = 3;
  const avg = (xs: number[], ys: number[]): [number, number, number] | null => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const y of ys)
      for (const x of xs) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = (y * W + x) * 4;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
    return n ? [r / n, g / n, b / n] : null;
  };
  const range = (a: number, n: number) => Array.from({ length: n }, (_, k) => a + k);
  const left: ([number, number, number] | null)[] = [];
  const right: ([number, number, number] | null)[] = [];
  for (let y = 0; y < h; y++) {
    left.push(avg(range(x0 - B, B), [y0 + y]));
    right.push(avg(range(x0 + w, B), [y0 + y]));
  }
  const top: ([number, number, number] | null)[] = [];
  const bottom: ([number, number, number] | null)[] = [];
  for (let x = 0; x < w; x++) {
    top.push(avg([x0 + x], range(y0 - B, B)));
    bottom.push(avg([x0 + x], range(y0 + h, B)));
  }
  // The grain: how much neighbouring pixels around the box differ.
  let dev = 0;
  let dn = 0;
  const lumAt = (x: number, y: number) => luminance(data, (y * W + x) * 4);
  for (let x = x0; x < x0 + w - 1; x++)
    for (const y of [y0 - 2, y0 + h + 1]) {
      if (y < 0 || y >= H) continue;
      dev += (lumAt(x, y) - lumAt(x + 1, y)) ** 2;
      dn++;
    }
  for (let y = y0; y < y0 + h - 1; y++)
    for (const x of [x0 - 2, x0 + w + 1]) {
      if (x < 0 || x >= W - 1) continue;
      dev += (lumAt(x, y) - lumAt(x, y + 1)) ** 2;
      dn++;
    }
  const grain = dn ? Math.min(30, Math.sqrt(dev / dn / 2)) : 0;
  let seed = 12345;
  const noise = () => {
    // Sum of uniforms: about a normal spread.
    let t = 0;
    for (let k = 0; k < 3; k++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      t += seed / 0x7fffffff - 0.5;
    }
    return t * 2;
  };
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const src = ((y0 + y) * W + x0 + x) * 4;
      if (within && !within(x0 + x, y0 + y)) {
        out.set(data.subarray(src, src + 4), o);
        continue;
      }
      const u = (x + 0.5) / w;
      const v = (y + 0.5) / h;
      const L = left[y] ?? right[y];
      const R = right[y] ?? left[y];
      const T = top[x] ?? bottom[x];
      const Bm = bottom[x] ?? top[x];
      const n = grain * noise();
      for (let c = 0; c < 3; c++) {
        const hz = L && R ? L[c] * (1 - u) + R[c] * u : null;
        const vt = T && Bm ? T[c] * (1 - v) + Bm[c] * v : null;
        // The nearer pair of sides counts more.
        const wh = 1 / (Math.min(u, 1 - u) + 0.05);
        const wv = 1 / (Math.min(v, 1 - v) + 0.05);
        const val = hz !== null && vt !== null ? (hz * wh + vt * wv) / (wh + wv) : (hz ?? vt ?? data[src + c]);
        out[o + c] = val + n;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h, grain };
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
  /**
   * Size of the biggest letter, in pixels. When given, marks of the ink
   * colour that run out of the box and are longer than a letter (the outline
   * of a bubble, the border of a panel, a strand of hair) are kept.
   */
  maxGlyph?: number,
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
  if (maxGlyph) keepLines(mask, w, h, maxGlyph);
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
export function cleanBubble(
  px: Pixels,
  region: BubbleRegion,
  rect: Box,
  fill: string,
  /** Size of the biggest letter: longer marks crossing the box (the bubble's own outline, where its shape was not closed) are kept. */
  maxGlyph?: number,
): { pixels: Pixels; x: number; y: number } {
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
  if (maxGlyph) keepLines(mask, w, h, maxGlyph);
  // Two to four more pixels around each letter (more for bigger lettering)
  // for the faint edge of anti-aliasing and of a soft or enlarged page:
  // with one, the outline of the letters stayed as a grey ghost of the
  // English under the translation.
  const passes = Math.max(2, Math.min(4, Math.round(Math.min(w, h) / 30)));
  for (let pass = 0; pass < passes; pass++) {
    const was = mask.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!inside[p] || was[p]) continue;
        if ((x > 0 && was[p - 1]) || (x < w - 1 && was[p + 1]) || (y > 0 && was[p - w]) || (y < h - 1 && was[p + w])) mask[p] = 2;
      }
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

/**
 * Letter edges of a box (strong horizontal steps of brightness), whatever
 * the colours of the letters: points of the strokes of dark, light or
 * outlined lettering drawn on the artwork.
 */
function strokePoints(px: Pixels, box: Box, across = false): { xs: number[]; ys: number[] } {
  const { data, width: W, height: H } = px;
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(W - 1, Math.round(box.x + box.w));
  const y1 = Math.min(H, Math.round(box.y + box.h));
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 30000)));
  const xs: number[] = [];
  const ys: number[] = [];
  // `across`: steps between a pixel and the one below (the tops and feet of
  // letters, which line up along the lines), else the one beside (the sides
  // of strokes, which lean with italic letters).
  const next = across ? W * 4 : 4;
  for (let y = y0; y < y1 - (across ? 1 : 0); y += step) {
    const row: number[] = [];
    for (let x = x0; x < x1 - 1; x += step) {
      const i = (y * W + x) * 4;
      if (Math.abs(luminance(data, i) - luminance(data, i + next)) > 60) row.push(x - x0);
    }
    // A straight line across the box (the border of a panel) is no letter.
    if (across && row.length * step > (x1 - x0) * 0.5) continue;
    for (const x of row) {
      xs.push(x);
      ys.push(y - y0);
    }
  }
  return { xs, ys };
}

/**
 * Tilt of lettering drawn on the artwork (degrees, clockwise), from the
 * angle at which its strokes line up best in rows. 0 when unsure.
 */
export function boxSkew(px: Pixels, box: Box, maxAngle = 20): number {
  const { xs, ys } = strokePoints(px, box, true);
  if (xs.length < 60) return 0;
  const diag = Math.ceil(Math.hypot(box.w, box.h)) + 2;
  const bins = new Float64Array(diag * 2);
  const scoreAt = (a: number) => {
    const t = (a * Math.PI) / 180;
    const sin = Math.sin(t);
    const cos = Math.cos(t);
    bins.fill(0);
    for (let i = 0; i < xs.length; i++) bins[Math.round(-xs[i] * sin + ys[i] * cos) + diag]++;
    let score = 0;
    for (let i = 0; i < bins.length; i++) score += bins[i] * bins[i];
    return score;
  };
  const flat = scoreAt(0);
  let best = 0;
  let bestScore = flat;
  for (let a = -maxAngle; a <= maxAngle; a += 1) {
    const sc = scoreAt(a);
    if (sc > bestScore) {
      bestScore = sc;
      best = a;
    }
  }
  // Only a clear tilt: lettering set level stays level.
  return Math.abs(best) >= 3 && bestScore > flat * 1.12 ? best : 0;
}

/**
 * Slant of lettering drawn on the artwork (italic, handwriting): how far a
 * stroke leans right per pixel of height, from the shear that stands its
 * strokes up straightest. 0 when the letters stand upright.
 */
export function boxSlant(px: Pixels, box: Box, rotation = 0): number {
  const { xs, ys } = strokePoints(px, box);
  if (xs.length < 60) return 0;
  // In the frame of the tilted lines.
  const t = (-rotation * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const cx = box.w / 2;
  const cy = box.h / 2;
  const u = xs.map((x, i) => (x - cx) * cos - (ys[i] - cy) * sin);
  const v = xs.map((x, i) => (x - cx) * sin + (ys[i] - cy) * cos);
  const span = Math.ceil(Math.hypot(box.w, box.h)) + 2;
  const bins = new Float64Array(span * 2);
  const scoreAt = (k: number) => {
    bins.fill(0);
    // Leaning right: the top of a stroke sits further right; undone by x + k·y.
    for (let i = 0; i < u.length; i++) bins[Math.round(u[i] + k * v[i]) + span]++;
    let score = 0;
    for (let i = 0; i < bins.length; i++) score += bins[i] * bins[i];
    return score;
  };
  const upright = scoreAt(0);
  let best = 0;
  let bestScore = upright;
  for (let k = -0.2; k <= 0.5001; k += 0.025) {
    const sc = scoreAt(k);
    if (sc > bestScore) {
      bestScore = sc;
      best = k;
    }
  }
  return Math.abs(best) >= 0.12 && bestScore > upright * 1.03 ? Math.round(best * 100) / 100 : 0;
}

/**
 * Colour inside a bubble, away from its rim and its text: the median of the
 * region's own pixels. Sampling around the text box instead picked the grey
 * of a grainy rim whenever the text came close to it.
 */
export function regionFill(px: Pixels, region: BubbleRegion): string {
  const { data, width: W } = px;
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const step = Math.max(1, Math.round(Math.sqrt(region.area / 4000)));
  const band = Math.max(3, Math.round(Math.min(region.w, region.h) * 0.1));
  for (let r = band; r < region.h - band; r += step) {
    const minX = region.spans[r * 2];
    const maxX = region.spans[r * 2 + 1];
    if (minX < 0) continue;
    for (let x = minX + band; x <= maxX - band; x += step) {
      const i = ((region.y + r) * W + x) * 4;
      // Bright pixels only: the bubble itself, not its lettering.
      if (luminance(data, i) < 150) continue;
      rs.push(data[i]);
      gs.push(data[i + 1]);
      bs.push(data[i + 2]);
    }
  }
  if (rs.length === 0) return '#ffffff';
  return toHex([medianOf(rs), medianOf(gs), medianOf(bs)]);
}

/**
 * Grows a text box over the lines of lettering just above or below it. A
 * model's box over text drawn on the artwork (white letters with a black
 * outline on a grey drawing) sometimes holds only its first lines: the
 * last ones stayed visible under the translation. A row next to the box
 * belongs to the text when it has about as many letter edges as the rows
 * inside; a gap of more than a line ends it. At most the box's height
 * is added on each side. `box` is in the pixels of `px`.
 */
export function growToText(px: Pixels, box: Box, sideways = true): Box {
  const { data, width: W, height: H } = px;
  const x0 = Math.max(0, Math.round(box.x));
  const x1 = Math.min(W - 1, Math.round(box.x + box.w));
  const y0 = Math.max(0, Math.round(box.y));
  const y1 = Math.min(H, Math.round(box.y + box.h));
  if (x1 - x0 < 4 || y1 - y0 < 4) return box;
  const rowEdges = (y: number) => {
    let n = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      if (Math.abs(luminance(data, i) - luminance(data, i + 4)) > 48) n++;
    }
    return n;
  };
  const inside: number[] = [];
  for (let y = y0; y < y1; y++) inside.push(rowEdges(y));
  const lettered = inside.filter((n) => n > 0).sort((a, b) => a - b);
  if (lettered.length < 3) return box;
  // Rows of letters inside: the upper half of the rows that have edges.
  const typical = lettered[Math.floor(lettered.length * 0.6)];
  const min = Math.max(2, typical * 0.35);
  // The largest gap between lines inside the box: a line spacing.
  let gapIn = 0;
  let run = 0;
  let lines = 0;
  let letterRows = 0;
  let prev = false;
  for (const n of inside) {
    const on = n >= min;
    if (on) letterRows++;
    if (on && !prev) lines++;
    prev = on;
    run = on ? 0 : run + 1;
    gapIn = Math.max(gapIn, run);
  }
  // A box over one line tells no spacing: about a letter's height then.
  const lineH = letterRows / Math.max(1, lines);
  const maxGap = Math.max(4, Math.round(lines > 1 ? Math.min(gapIn * 1.5 + 2, box.h * 0.3) : lineH));
  // Up to the box's height, or about three more lines for a box over one line.
  const reach = Math.round(Math.max(box.h, lineH * 4));
  const extend = (from: number, step: number, limit: number) => {
    let last = from - step;
    let gap = 0;
    for (let y = from, k = 0; y >= 0 && y < H && k < limit; y += step, k++) {
      if (rowEdges(y) >= min) {
        last = y;
        gap = 0;
      } else if (++gap > maxGap) break;
    }
    return last;
  };
  const bottom = extend(y1, 1, reach) + 1;
  const top = extend(y0 - 1, -1, reach);
  const ny0 = Math.min(y0, top);
  const ny1 = Math.max(y1, bottom);
  // Then sideways: the ends of lines longer than the box ("US… ALL" left
  // visible on both sides of the translation). A column belongs to the text
  // while it holds letter edges; a gap wider than about a letter ends it.
  const colEdges = (x: number) => {
    let n = 0;
    for (let y = ny0; y < ny1; y++) {
      const i = (y * W + x) * 4;
      if (Math.abs(luminance(data, i) - luminance(data, i + 4)) > 70) n++;
    }
    return n;
  };
  const cols: number[] = [];
  for (let x = x0; x < x1; x++) cols.push(colEdges(x));
  const litCols = cols.filter((n) => n > 0).sort((a, b) => a - b);
  let nx0 = x0;
  let nx1 = x1;
  // Only on a plain background: on bricks, foliage or hatching the drawing
  // itself is full of edges like letters, and the box spread over it (and
  // over a sound effect beside the text).
  const band = Math.max(4, Math.round(Math.min((ny1 - ny0) * 0.5, lineH * 1.2)));
  let around = 0;
  let aroundRows = 0;
  for (const [a, b] of [
    [Math.max(0, ny0 - band), ny0],
    [ny1, Math.min(H - 1, ny1 + band)],
  ]) {
    for (let y = a; y < b; y++) {
      aroundRows++;
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        if (Math.abs(luminance(data, i) - luminance(data, i + 4)) > 70) around++;
      }
    }
  }
  const insideDensity = cols.reduce((a, n) => a + n, 0) / Math.max(1, (ny1 - ny0) * (x1 - x0));
  const aroundDensity = around / Math.max(1, aroundRows * (x1 - x0));
  // Lines not told apart (tilted lines overlapping rows): their ends neither.
  const plain = aroundRows > 0 && aroundDensity < insideDensity * 0.12 && (lines >= 2 || y1 - y0 < (x1 - x0) * 0.4);
  // Rows of the box between its lines (letters on none of them).
  const offRow: boolean[] = [];
  for (let y = ny0; y < ny1; y++) offRow.push(y < y0 || y >= y1 ? false : inside[y - y0] < min * 0.5);
  const offRows = offRow.filter(Boolean).length;
  const between = (x: number) => {
    let n = 0;
    for (let y = ny0; y < ny1; y++) {
      if (!offRow[y - ny0]) continue;
      const i = (y * W + x) * 4;
      if (Math.abs(luminance(data, i) - luminance(data, i + 4)) > 70) n++;
    }
    return n;
  };
  const beyond = (x: number) => {
    let n = 0;
    for (const [a, b] of [
      [Math.max(0, ny0 - band), ny0],
      [ny1, Math.min(H, ny1 + band)],
    ]) {
      for (let y = a; y < b; y++) {
        const i = (y * W + x) * 4;
        if (Math.abs(luminance(data, i) - luminance(data, i + 4)) > 70) n++;
      }
    }
    return n;
  };
  // A column of the text: its ink stays on the lines, not above or below
  // them (a sound effect, hair, a drawn edge) nor as much between them
  // (foliage, bricks, hatching).
  const textLike = (x: number, n: number) =>
    beyond(x) <= Math.max(4, n * 0.8) && !(offRows >= 3 && between(x) >= 3 && between(x) > n * 0.5 * (offRows / (ny1 - ny0)));
  if (sideways && plain && litCols.length > 3) {
    const colMin = Math.max(2, litCols[Math.floor(litCols.length * 0.5)] * 0.3);
    const colMax = Math.max(colMin * 2, litCols[Math.floor(litCols.length * 0.9)] * 2.5);
    const gapX = Math.max(4, Math.round(lineH * 1.4));
    // The model's box sometimes holds only the first half of the lines.
    const reachX = Math.round(Math.max(box.w * 1.2, lineH * 10));
    const side = (from: number, step: number) => {
      let last = from - step;
      let gap = 0;
      for (let x = from, k = 0; x >= 0 && x < W - 1 && k < reachX; x += step, k++) {
        const n = colEdges(x);
        // Far more edges than a column of the text: a big drawn sound effect next to it.
        if (n > colMax) break;
        // Ink that goes on above or below the lines (a sound effect, hair, a
        // drawn edge beside the text): not the end of a line of it.
        if (n >= colMin && !textLike(x, n)) break;
        if (n >= colMin) {
          last = x;
          gap = 0;
        } else if (++gap > gapX) break;
      }
      return last;
    };
    nx0 = Math.min(x0, side(x0 - 1, -1));
    nx1 = Math.max(x1, side(x1, 1) + 1);
  }
  // The model's box also over something else beside the text (a sound
  // effect): its edge columns that are not text are left out, as long as
  // most of the box stays.
  if (sideways && plain && litCols.length > 3 && nx0 === x0 && nx1 === x1) {
    const colMin = Math.max(2, litCols[Math.floor(litCols.length * 0.5)] * 0.3);
    const strayCol = (x: number) => {
      const n = cols[x - x0];
      return n >= colMin && !textLike(x, n);
    };
    const keep = Math.round((x1 - x0) * 0.5);
    const trim = (from: number, step: number) => {
      let last = from;
      let quiet = 0;
      for (let x = from, k = 0; k < x1 - x0 - keep; x += step, k++) {
        if (strayCol(x)) {
          last = x + step;
          quiet = 0;
        } else if (cols[x - x0] >= colMin && ++quiet > 3) break;
      }
      return last;
    };
    nx0 = trim(x0, 1);
    nx1 = trim(x1 - 1, -1) + 1;
    if (nx1 - nx0 < keep) {
      nx0 = x0;
      nx1 = x1;
    }
  }
  if (ny0 === y0 && ny1 === y1 && nx0 === x0 && nx1 === x1) return box;
  return { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 };
}

/**
 * Moves a text box onto the lettering it is meant to cover. Vision models
 * often place boxes of signs, screens and game chats a line too high or
 * too low: the translation then sat next to the original, which stayed
 * visible. The box keeps its size and slides (by up to about its height)
 * to where the most letter edges are; it stays put when nothing clearly
 * better is found. `box` is in the pixels of `px`.
 */
export function snapToText(
  px: Pixels,
  box: Box,
  /** How far to look: in box heights vertically, in box widths sideways. */
  reach: { y?: number; x?: number; minY?: number } = {},
): Box & { found: boolean } {
  const { data, width: W, height: H } = px;
  const bw = Math.max(2, Math.round(box.w));
  const bh = Math.max(2, Math.round(box.h));
  if (bw >= W || bh >= H) return { ...box, found: false };
  const reachY = Math.round(Math.max(4, reach.minY ?? 0, box.h * (reach.y ?? 1.2)));
  const reachX = Math.round(box.w * (reach.x ?? 0.3));
  // Strong horizontal steps of brightness: the strokes of letters.
  const edge = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return Math.abs(luminance(data, i) - luminance(data, i + 4)) > 48 ? 1 : 0;
  };
  /** Best start of a window of `len` along one axis (`limit` long, `cross` wide), and its share of letter edges. */
  const slide = (
    from: number,
    to: number,
    len: number,
    start: number,
    limit: number,
    cross: number,
    count: (pos: number) => number,
    gain: number,
  ): { pos: number; density: number } => {
    const lo = Math.max(0, from);
    const hi = Math.min(to, limit - 1);
    const n = hi - lo + 1;
    if (n <= len) return { pos: start, density: 0 };
    const sums = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) sums[i + 1] = sums[i] + count(lo + i);
    const at = (pos: number) => sums[Math.min(n, pos - lo + len)] - sums[Math.max(0, pos - lo)];
    const here = at(Math.min(Math.max(start, lo), hi - len + 1));
    let best = start;
    let bestScore = here;
    for (let pos = lo; pos + len - 1 <= hi; pos++) {
      // A small preference for staying close: two lines of a chat keep their own box.
      const score = at(pos) * (1 - (0.12 * Math.abs(pos - start)) / Math.max(len, reachY / 2));
      if (score > bestScore) {
        bestScore = score;
        best = pos;
      }
    }
    // Only a clearly better place, with real lettering in it.
    const density = at(best) / (len * cross);
    if (bestScore > here * gain && density > 0.03) return { pos: best, density };
    return { pos: start, density: here / (len * cross) };
  };
  const x0 = Math.max(0, Math.round(box.x));
  const x1 = Math.min(W - 2, Math.round(box.x + box.w));
  const v = slide(Math.round(box.y) - reachY, Math.round(box.y + box.h) + reachY, bh, Math.round(box.y), H, bw, (y) => {
    let c = 0;
    for (let x = x0; x <= x1; x++) c += edge(x, y);
    return c;
  }, 1.3);
  const y0 = Math.max(0, v.pos);
  const y1 = Math.min(H - 1, v.pos + bh - 1);
  const h = slide(Math.round(box.x) - reachX, Math.round(box.x + box.w) + reachX, bw, Math.round(box.x), W, bh, (x) => {
    if (x >= W - 1) return 0;
    let c = 0;
    for (let y = y0; y <= y1; y++) c += edge(x, y);
    return c;
  }, 1.08);
  return { x: h.pos, y: v.pos, w: box.w, h: box.h, found: Math.max(v.density, h.density) > 0.03 };
}

/**
 * The shift that brings a model's boxes onto the letters, as a function of
 * the position: `measured` pairs (where the box was, how far the letters
 * really are). A straight line is fitted so that both a constant offset and
 * a scale error (boxes drifting more and more down the image) are fixed;
 * readings that disagree with the others are left out.
 */
export function fitShift(measured: { at: number; shift: number }[]): (at: number) => number {
  if (measured.length === 0) return () => 0;
  const median = (v: number[]) => {
    const s = v.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  if (measured.length < 3) {
    const m = median(measured.map((p) => p.shift));
    return () => m;
  }
  const line = (pts: typeof measured) => {
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p.at, 0) / n;
    const my = pts.reduce((a, p) => a + p.shift, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of pts) {
      num += (p.at - mx) * (p.shift - my);
      den += (p.at - mx) ** 2;
    }
    // A scale error of more than 30 % is not a model's habit: keep the offset only.
    const slope = den > 0 && Math.abs(num / den) < 0.3 ? num / den : 0;
    return { slope, base: my - slope * mx };
  };
  // Readings far from the others (a box snapped onto the wrong text) are dropped first.
  const mid = median(measured.map((p) => p.shift));
  const spread = median(measured.map((p) => Math.abs(p.shift - mid)));
  const kept = measured.filter((p) => Math.abs(p.shift - mid) <= Math.max(6, spread * 3));
  // Too few agreeing readings: the median offset is safer than a line.
  if (kept.length < 3) return () => mid;
  const fit = line(kept);
  return (at) => fit.base + fit.slope * at;
}

/**
 * Blocks of lettering on the page, found without the AI: small dark marks
 * (letters) on light paper, side by side on lines, lines stacked into a
 * block. Works whether or not the bubble around them was recognised (a
 * bubble touching the white margin of the page is not) and ignores drawn
 * sound effects (letters far too big) and the artwork (no light paper
 * around). Boxes in the pixels of `px`.
 */
export function findTextBlocks(px: Pixels): Box[] {
  const { data, width: W, height: H } = px;
  const lum = new Uint8Array(W * H);
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) lum[p] = luminance(data, i);
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const minH = Math.max(3, Math.round(W * 0.006));
  const maxH = Math.max(12, Math.round(W * 0.045));
  const marks: Box[] = [];
  for (let start = 0; start < lum.length; start++) {
    if (seen[start] || lum[start] >= 110) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0;
    let big = false;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % W;
      const y = (p - x) / W;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x1 - x0 > maxH * 3 || y1 - y0 > maxH * 2) big = true; // artwork: keep flooding, then drop
      if (x > 0 && !seen[p - 1] && lum[p - 1] < 110) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < W - 1 && !seen[p + 1] && lum[p + 1] < 110) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && !seen[p - W] && lum[p - W] < 110) { seen[p - W] = 1; stack[sp++] = p - W; }
      if (y < H - 1 && !seen[p + W] && lum[p + W] < 110) { seen[p + W] = 1; stack[sp++] = p + W; }
    }
    const h = y1 - y0 + 1;
    const w = x1 - x0 + 1;
    // Dots ("...") are kept: small but square.
    if (big || h > maxH || w > maxH * 1.6 || (h < minH && !(h >= 2 && w >= 2 && w <= h * 2))) continue;
    // Letters sit on paper: the ring around the mark is light.
    let ring = 0;
    let ringN = 0;
    const rx0 = Math.max(0, x0 - 2), rx1 = Math.min(W - 1, x1 + 2), ry0 = Math.max(0, y0 - 2), ry1 = Math.min(H - 1, y1 + 2);
    for (let x = rx0; x <= rx1; x++) {
      ring += lum[ry0 * W + x] + lum[ry1 * W + x];
      ringN += 2;
    }
    for (let y = ry0; y <= ry1; y++) {
      ring += lum[y * W + rx0] + lum[y * W + rx1];
      ringN += 2;
    }
    if (ring / ringN < 185 || n < 3) continue;
    marks.push({ x: x0, y: y0, w, h });
  }
  // Marks into lines: overlapping heights, small horizontal gap.
  marks.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: (Box & { count: number })[] = [];
  for (const m of marks) {
    const line = lines.find((l) => {
      const overlap = Math.min(l.y + l.h, m.y + m.h) - Math.max(l.y, m.y);
      const gap = Math.max(m.x - (l.x + l.w), l.x - (m.x + m.w));
      return overlap >= Math.min(l.h, m.h) * 0.4 && gap <= Math.max(l.h, m.h) * 1.4;
    });
    if (line) {
      const x1 = Math.max(line.x + line.w, m.x + m.w);
      const y1 = Math.max(line.y + line.h, m.y + m.h);
      line.x = Math.min(line.x, m.x);
      line.y = Math.min(line.y, m.y);
      line.w = x1 - line.x;
      line.h = y1 - line.y;
      line.count++;
    } else lines.push({ ...m, count: 1 });
  }
  // Lines into blocks: stacked closely, overlapping horizontally.
  const blocks: (Box & { count: number; lines: number })[] = [];
  for (const l of lines.filter((x) => x.count >= 2).sort((a, b) => a.y - b.y)) {
    const block = blocks.find((b) => {
      const gap = l.y - (b.y + b.h);
      const overlap = Math.min(b.x + b.w, l.x + l.w) - Math.max(b.x, l.x);
      return gap <= l.h * 1.2 && gap >= -l.h && overlap > Math.min(b.w, l.w) * 0.3;
    });
    if (block) {
      const x1 = Math.max(block.x + block.w, l.x + l.w);
      const y1 = Math.max(block.y + block.h, l.y + l.h);
      block.x = Math.min(block.x, l.x);
      block.y = Math.min(block.y, l.y);
      block.w = x1 - block.x;
      block.h = y1 - block.y;
      block.count += l.count;
      block.lines++;
    } else blocks.push({ ...l, lines: 1 });
  }
  // A word at least: three marks ("I…" included).
  return blocks.filter((b) => b.count >= 3).map(({ x, y, w, h }) => ({ x, y, w, h }));
}

/**
 * Height of the letters of the lines of text inside `box`, in pixels of
 * `px`: the rows that hold ink are grouped into lines and a low quartile of
 * their heights is taken (two lines that touch count as one tall line).
 * 0 when no line is found. `tinted`: coloured lettering instead of dark.
 */
export function letterHeight(px: Pixels, box: Box, tinted = false): number {
  const { data, width: W, height: H } = px;
  const x0 = Math.max(0, Math.round(box.x));
  const x1 = Math.min(W, Math.round(box.x + box.w));
  const y0 = Math.max(0, Math.round(box.y));
  const y1 = Math.min(H, Math.round(box.y + box.h));
  const runs: number[] = [];
  const edgeRuns: boolean[] = [];
  let start = -1;
  for (let y = y0; y <= y1; y++) {
    let ink = false;
    if (y < y1) {
      for (let x = x0; x < x1 && !ink; x++) {
        const i = (y * W + x) * 4;
        ink = tinted ? isTint(data, i) : luminance(data, i) < 128;
      }
    }
    if (ink && start < 0) start = y;
    if (!ink && start >= 0) {
      if (y - start >= 4) {
        runs.push(y - start);
        // Cut by the box and short: shading or a line half in it, not a line of letters.
        edgeRuns.push(start === y0 || y === y1);
      }
      start = -1;
    }
  }
  if (runs.length === 0) return 0;
  const longest = Math.max(...runs);
  const whole = runs.filter((r, k) => !edgeRuns[k] || r >= longest * 0.6);
  let pool = whole.length > 0 ? whole : runs;
  // Bits of punctuation alone on their rows (an apostrophe, the dot of an
  // italic "!") are not lines of letters.
  const median = [...pool].sort((a, b) => a - b)[Math.floor(pool.length / 2)];
  if (pool.some((r) => r >= median * 0.5)) pool = pool.filter((r) => r >= median * 0.5);
  pool.sort((a, b) => a - b);
  return pool[Math.floor((pool.length - 1) * 0.25)];
}

/**
 * Height of the letters of lettering drawn over the artwork, where nearly
 * every row of the box holds some dark pixel (the drawing, a bubble's rim)
 * and `letterHeight` only sees one tall run: the bands of rows rich in
 * letter edges, the lines being separated by rows with far fewer. 0 when no
 * such bands are found.
 */
export function letterHeightByEdges(px: Pixels, box: Box): number {
  const { data, width: W, height: H } = px;
  const x0 = Math.max(0, Math.round(box.x));
  const x1 = Math.min(W - 1, Math.round(box.x + box.w));
  const y0 = Math.max(0, Math.round(box.y));
  const y1 = Math.min(H, Math.round(box.y + box.h));
  if (x1 - x0 < 4 || y1 - y0 < 6) return 0;
  const rows: number[] = [];
  for (let y = y0; y < y1; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      if (Math.abs(luminance(data, i) - luminance(data, i + 4)) > 48) n++;
    }
    rows.push(n);
  }
  const sorted = [...rows].sort((a, b) => a - b);
  const high = sorted[Math.floor(sorted.length * 0.8)];
  if (high < 4) return 0;
  const min = high * 0.4;
  const runs: number[] = [];
  let start = -1;
  for (let k = 0; k <= rows.length; k++) {
    const on = k < rows.length && rows[k] >= min;
    if (on && start < 0) start = k;
    if (!on && start >= 0) {
      if (k - start >= 3) runs.push(k - start);
      start = -1;
    }
  }
  // One band over the whole box: no lines told apart.
  if (runs.length === 0 || (runs.length === 1 && runs[0] > rows.length * 0.8)) return 0;
  runs.sort((a, b) => a - b);
  return runs[Math.floor((runs.length - 1) * 0.5)];
}

/** Whether the band around a box is plain (no drawing): its edges are few. */
export function plainAround(px: Pixels, box: Box): boolean {
  const { data, width: W, height: H } = px;
  const band = Math.max(6, Math.round(Math.min(box.w, box.h) * 0.5));
  const x0 = Math.max(0, Math.round(box.x - band));
  const x1 = Math.min(W - 1, Math.round(box.x + box.w + band));
  const y0 = Math.max(0, Math.round(box.y - band));
  const y1 = Math.min(H, Math.round(box.y + box.h + band));
  let edges = 0;
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) continue;
      n++;
      const i = (y * W + x) * 4;
      if (Math.abs(luminance(data, i) - luminance(data, i + 4)) > 24) edges++;
    }
  return n > 0 && edges / n < 0.02;
}

/** Average brightness of a box of `px` (0 dark – 255 white). */
export function meanLuminance(px: Pixels, box: Box): number {
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(px.width - 1, Math.round(box.x + box.w));
  const y1 = Math.min(px.height - 1, Math.round(box.y + box.h));
  let sum = 0;
  let n = 0;
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0 + 1) * (y1 - y0 + 1)) / 2000)));
  for (let y = y0; y <= y1; y += step)
    for (let x = x0; x <= x1; x += step) {
      sum += luminance(px.data, (y * px.width + x) * 4);
      n++;
    }
  return n ? sum / n : 255;
}
