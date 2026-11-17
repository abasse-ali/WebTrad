/**
 * A gentle scroll of the page by a given distance, for the volume buttons
 * of the reader. The browser's own "smooth" scroll on iOS jumped most of a
 * screen in a blink; this one eases in and out over about half a second,
 * and a press during the move carries on from where the last one aimed.
 */

/** Share of the screen one press of a volume button scrolls. */
export const VOLUME_STEPS = { short: 0.3, medium: 0.45, long: 0.65 } as const;
export type VolumeStep = keyof typeof VOLUME_STEPS;

/** Ease in and out: slow start, slow stop (t from 0 to 1). */
export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

let moving: { from: number; to: number; start: number; frame: number } | null = null;

/** Scrolls the window by `by` pixels, softly. */
export function glideBy(by: number, duration = 520): void {
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  // A press during a move: from where the page is, to beyond the last aim.
  const aim = moving ? moving.to : window.scrollY;
  if (moving) cancelAnimationFrame(moving.frame);
  const to = Math.min(max, Math.max(0, aim + by));
  const from = window.scrollY;
  if (Math.abs(to - from) < 1) {
    moving = null;
    return;
  }
  const state = { from, to, start: performance.now(), frame: 0 };
  moving = state;
  const step = (now: number) => {
    if (moving !== state) return;
    const t = (now - state.start) / duration;
    window.scrollTo(0, state.from + (state.to - state.from) * easeInOut(t));
    if (t < 1) state.frame = requestAnimationFrame(step);
    else moving = null;
  };
  state.frame = requestAnimationFrame(step);
}
