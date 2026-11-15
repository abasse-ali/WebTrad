import { useEffect, useRef } from 'react';

/** Number of speeds of the automatic scrolling. */
export const SPEED_LEVELS = 9;
export const DEFAULT_SPEED = 4;

export function clampSpeed(level: number): number {
  return Number.isFinite(level) ? Math.min(SPEED_LEVELS, Math.max(1, Math.round(level))) : DEFAULT_SPEED;
}

/** Pixels scrolled per second at a speed level (each level is about a third faster). */
export function scrollSpeed(level: number): number {
  return Math.round(30 * 1.32 ** (clampSpeed(level) - 1));
}

/** After a wheel turn or a finger leaves the screen, let the reader's own scroll settle. */
const HOLD_MS = 700;

/**
 * Automatic scrolling: the page moves down on its own at a steady pace while
 * `active`. The reader keeps the hand: a finger on the screen or a turn of
 * the wheel suspends it for a moment, and it goes on from wherever they left
 * the page. `onEnd` is called at the bottom of the page.
 */
export function useAutoScroll(active: boolean, level: number, onEnd: () => void): void {
  const end = useRef(onEnd);
  end.current = onEnd;
  const speed = useRef(scrollSpeed(level));
  speed.current = scrollSpeed(level);

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    let last = 0;
    // The position is tracked here: browsers that round the scroll position
    // would never move by a fraction of a pixel per frame.
    let target = window.scrollY;
    let touching = false;
    let heldUntil = 0;

    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      // The reader moved the page (finger, wheel, keyboard, scrollbar): follow them.
      if (touching || now < heldUntil || Math.abs(window.scrollY - target) > 2) {
        target = window.scrollY;
        if (touching || now < heldUntil) return;
      }
      target += speed.current * dt;
      window.scrollTo({ top: target, behavior: 'instant' });
      const bottom = document.documentElement.scrollHeight - window.innerHeight;
      if (target >= bottom - 1) end.current();
    };
    frame = requestAnimationFrame(step);

    const hold = () => (heldUntil = performance.now() + HOLD_MS);
    const touchStart = () => (touching = true);
    const touchEnd = (e: TouchEvent) => {
      touching = e.touches.length > 0;
      if (!touching) hold();
    };
    window.addEventListener('wheel', hold, { passive: true });
    window.addEventListener('touchstart', touchStart, { passive: true });
    window.addEventListener('touchend', touchEnd, { passive: true });
    window.addEventListener('touchcancel', touchEnd, { passive: true });

    // Nobody touches the screen while it scrolls: keep it from going to sleep.
    let lock: WakeLockSentinel | null = null;
    let stopped = false;
    const acquire = async () => {
      if (stopped || lock || document.visibilityState !== 'visible') return;
      try {
        const l = await navigator.wakeLock?.request('screen');
        if (!l) return;
        if (stopped || lock) return void l.release().catch(() => undefined);
        lock = l;
        l.addEventListener('release', () => {
          if (lock === l) lock = null;
        });
      } catch {
        /* unsupported or refused: the scrolling still works */
      }
    };
    const onVisible = () => void acquire();
    document.addEventListener('visibilitychange', onVisible);
    void acquire();

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      window.removeEventListener('wheel', hold);
      window.removeEventListener('touchstart', touchStart);
      window.removeEventListener('touchend', touchEnd);
      window.removeEventListener('touchcancel', touchEnd);
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
      lock = null;
    };
  }, [active]);
}
