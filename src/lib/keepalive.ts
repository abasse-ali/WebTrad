/**
 * Keeps a running job alive: translating a chapter takes minutes, long enough
 * for a phone to dim, lock and suspend the page half-way.
 *  - a screen wake lock is held while pages are being processed;
 *  - a shared Web Lock tells the other tabs that a job is alive here, so they
 *    do not mistake its in-flight pages for leftovers of a dead session.
 */

const JOB_LOCK = 'webtrad-job';

let processing = false;
let sentinel: WakeLockSentinel | null = null;
let releaseJobLock: (() => void) | null = null;
let listening = false;

async function acquireWakeLock(): Promise<void> {
  if (!processing || sentinel || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
  try {
    const lock = await navigator.wakeLock?.request('screen');
    if (!lock) return;
    if (!processing || sentinel) {
      void lock.release().catch(() => undefined);
      return;
    }
    sentinel = lock;
    // The browser drops the lock when the page is hidden: forget it so it is
    // requested again when the page comes back.
    lock.addEventListener('release', () => {
      if (sentinel === lock) sentinel = null;
    });
  } catch {
    /* unsupported, battery saver… reading still works, the screen may just sleep */
  }
}

function holdJobLock(): void {
  if (typeof navigator === 'undefined' || !navigator.locks || releaseJobLock) return;
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  releaseJobLock = release;
  navigator.locks.request(JOB_LOCK, { mode: 'shared' }, () => held).catch(() => undefined);
}

/** Call whenever "is any chapter being processed?" changes. */
export function setProcessing(active: boolean): void {
  if (active === processing) return;
  processing = active;
  if (active) {
    if (!listening && typeof document !== 'undefined') {
      listening = true;
      document.addEventListener('visibilitychange', () => void acquireWakeLock());
    }
    void acquireWakeLock();
    holdJobLock();
  } else {
    void sentinel?.release().catch(() => undefined);
    sentinel = null;
    releaseJobLock?.();
    releaseJobLock = null;
  }
}

/** True when another tab of the app is processing a chapter right now. */
export async function otherTabIsProcessing(): Promise<boolean> {
  try {
    const state = await navigator.locks?.query();
    return Boolean(state?.held?.some((l) => l.name === JOB_LOCK));
  } catch {
    return false;
  }
}
