/**
 * Keeps a running job alive: translating a chapter takes minutes, long enough
 * for a phone to dim, lock and suspend the page half-way.
 *  - a screen wake lock is held while pages are being processed;
 *  - a shared Web Lock tells the other tabs that a job is alive here, so they
 *    do not mistake its in-flight pages for leftovers of a dead session.
 */

import { logInfo } from './log';
import { isNativeApp, nativeKeepAlive, otherAudioPlaying } from './native';
import { getSettings } from './settings';

const JOB_LOCK = 'webtrad-job';

// --- working in the background (iPhone app) ---------------------------------
//
// iOS suspends an app a few seconds after it leaves the screen, and the
// translation stops with it. While a chapter is processed the app plays
// silence: natively (keeps the app running, mixed with other sounds) and in
// the page itself (keeps the web view's JavaScript running). The page's
// sound is not mixable: WebKit takes the audio for it and would stop a
// video playing in Safari or YouTube. It is only played while nothing else
// plays, and never started again over another app's sound.

/** One second of silence, as a WAV data URL. */
function silentWav(): string {
  const n = 8000;
  const bytes = new Uint8Array(44 + n);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + n, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, 'data');
  view.setUint32(40, n, true);
  bytes.fill(128, 44);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return `data:audio/wav;base64,${btoa(bin)}`;
}

let silence: HTMLAudioElement | null = null;

function silenceElement(): HTMLAudioElement {
  if (!silence) {
    silence = new Audio(silentWav());
    silence.loop = true;
    silence.volume = 0.01;
    silence.setAttribute('playsinline', '');
    // Paused by another app's video or music: played again while a chapter
    // is being translated (the native side keeps the app itself alive).
    silence.addEventListener('pause', () => {
      if (processing && getSettings().background !== false) setTimeout(() => void playPageSilence(), 1500);
    });
  }
  return silence;
}

/** Plays the page's silence, unless another app is playing sound (it would be cut). */
async function playPageSilence(): Promise<void> {
  if (!processing || getSettings().background === false) return;
  if (await otherAudioPlaying()) {
    logInfo('app', 'Son d’une autre appli en cours : la traduction ne le coupe pas');
    return;
  }
  await silenceElement().play().catch(() => undefined);
}

// What happened while the app was out of sight, for the activity log.
let hiddenSince = 0;
if (typeof document !== 'undefined' && isNativeApp()) {
  document.addEventListener('visibilitychange', () => {
    if (!processing) return;
    if (document.hidden) {
      hiddenSince = Date.now();
      logInfo('app', 'Appli quittée pendant une traduction : le travail continue en arrière-plan');
    } else if (hiddenSince) {
      logInfo('app', `Retour dans l’appli après ${Math.round((Date.now() - hiddenSince) / 1000)} s en arrière-plan`);
      hiddenSince = 0;
      void playPageSilence();
    }
  });
}

// iOS only lets a page start a sound from a tap: the element is unlocked by
// the reader's first tap, so it can be started later by the job itself.
if (typeof window !== 'undefined' && isNativeApp()) {
  const unlock = () => {
    const audio = silenceElement();
    // Unlocked muted: a muted element takes no audio from other apps (a
    // video playing in Safari is not interrupted by a tap in WebTrad).
    audio.muted = true;
    void audio
      .play()
      .then(() => {
        audio.pause();
        audio.muted = false;
        if (processing) void playPageSilence();
      })
      .catch(() => {
        audio.muted = false;
      });
    window.removeEventListener('pointerdown', unlock, true);
  };
  window.addEventListener('pointerdown', unlock, true);
}

function backgroundWork(on: boolean): void {
  if (!isNativeApp()) return;
  const wanted = on && getSettings().background !== false;
  void nativeKeepAlive(wanted);
  if (wanted) {
    void playPageSilence();
    logInfo('app', 'Traduction en arrière-plan activée (son silencieux)');
  } else silence?.pause();
}

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
    backgroundWork(true);
  } else {
    backgroundWork(false);
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
