/**
 * Brings the text boxes of a vision model back onto the bubbles of the page.
 *
 * Some free models answer with boxes that are not only shifted but squeezed
 * or stretched (they place the texts of a tall image as if it were shorter):
 * a translation then landed on a shirt, far from its bubble. The bubbles
 * found by image analysis tell where the text really is. The vertical
 * mapping `y → a·y + b` that puts the most boxes inside distinct bubbles is
 * searched (from every pair of boxes matched to every pair of bubbles, and
 * every single box moved onto a bubble), and kept only when it explains
 * clearly more boxes than the boxes as given.
 */
import type { Box } from './text';

export interface Mapping {
  a: number;
  b: number;
  /** Boxes that fall in a bubble with this mapping. */
  matched: number;
}

const centre = (b: Box) => b.y + b.h / 2;
const centreX = (b: Box) => b.x + b.w / 2;

/**
 * Boxes of `items` falling (once mapped) inside `bubbles`, and how far from
 * their middle. A bubble may hold several texts: two bubbles drawn joined
 * are one white shape, and requiring one text per shape made a page of
 * correct boxes look wrong, so every box of the page was stretched away.
 */
function score(items: Box[], bubbles: Box[], a: number, b: number): { matched: number; error: number; target: number[] } {
  let matched = 0;
  const target: number[] = [];
  let error = 0;
  // Two texts at most per shape (two bubbles drawn joined). Without a limit,
  // squeezing the twenty lines of a game chat into one big bubble "explained"
  // them all, and they were lettered there, one over the other.
  const held = new Array<number>(bubbles.length).fill(0);
  for (const it of items) {
    const y = a * centre(it) + b;
    const x = centreX(it);
    let best = -1;
    let bestD = Infinity;
    for (const [j, r] of bubbles.entries()) {
      if (held[j] >= 2 || x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
      const d = Math.abs(y - centre(r)) / r.h;
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    target.push(best);
    if (best >= 0) {
      held[best]++;
      matched++;
      error += bestD;
    }
  }
  return { matched, error, target };
}

const strip = ({ a, b, matched }: Mapping): Mapping => ({ a, b, matched });

export function alignToBubbles(items: Box[], bubbles: Box[]): Mapping {
  const identity = { a: 1, b: 0, ...score(items, bubbles, 1, 0) };
  if (items.length === 0 || bubbles.length === 0) return identity;
  let best = identity;
  const consider = (a: number, b: number) => {
    // Models squeeze or stretch, never by more than two.
    if (!(a >= 0.5 && a <= 2) || !Number.isFinite(b)) return;
    const s = score(items, bubbles, a, b);
    if (s.matched > best.matched || (s.matched === best.matched && s.error < best.error - 1e-6)) best = { a, b, ...s };
  };
  // One box onto one bubble: a plain shift.
  for (const it of items) for (const r of bubbles) consider(1, centre(r) - centre(it));
  // Two boxes onto two bubbles, in the same order: shift and scale.
  for (let i = 0; i < items.length; i++)
    for (let k = i + 1; k < items.length; k++) {
      const yi = centre(items[i]);
      const yk = centre(items[k]);
      if (Math.abs(yi - yk) < 1) continue;
      for (let j = 0; j < bubbles.length; j++)
        for (let l = 0; l < bubbles.length; l++) {
          if (j === l) continue;
          const a = (centre(bubbles[j]) - centre(bubbles[l])) / (yi - yk);
          consider(a, centre(bubbles[j]) - a * yi);
        }
    }
  // Only a clear gain, confirmed by two boxes at least (one box alone could
  // be a sign moved into a bubble), and most of the boxes.
  // A box the model put in a bubble, moved out of it, is a loss: the
  // mapping must explain more boxes than it takes away. (Two texts, one
  // well placed in a dotted bubble: a shift of 557 px put both on white
  // shapes, the bubble's text on a shirt below it.)
  const lost = identity.target.filter((t, k) => t >= 0 && best.target[k] !== t).length;
  const gain = best.matched - identity.matched;
  if (gain > lost && best.matched >= Math.max(2, Math.ceil(items.length * 0.5))) return strip(best);
  return strip(identity);
}
