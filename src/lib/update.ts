/**
 * Updates of the iPhone app without a computer.
 *
 * The app installed with Sideloadly holds the web code it was built with.
 * Each new version published on GitHub also carries that web code alone
 * (web.zip) and a note (web.json): the app downloads them by itself, keeps
 * them in its own storage, and starts on them the next time it opens (or
 * as soon as it goes to the background with nothing being translated).
 *
 * Safety: a version needing native code the installed app lacks is not
 * taken (`native` level). The new code is only kept for good once it has
 * started and drawn the app: a broken download opens on the previous code
 * at the next launch. Installing a new .ipa always starts on its own code.
 */
import { CapacitorHttp, WebView } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import JSZip from 'jszip';
import { isProcessing } from './keepalive';
import { logInfo, logWarn } from './log';
import { isNativeApp } from './native';

/**
 * Native features this code needs from the installed app. Raised (here AND
 * in the native plugin's changes) whenever the Swift code changes: older
 * installs then keep their code until the .ipa is installed again.
 */
export const NATIVE_LEVEL = 2;

const RELEASE = 'https://github.com/abasse-ali/WebTrad/releases/latest/download';
/**
 * Where downloaded versions are kept, in the app's Library. It must be this
 * folder: at launch the app looks for a kept version there, by its folder
 * name only. A version kept from anywhere else made the app look for a
 * folder that does not exist, and crash at every launch.
 */
const SNAPSHOTS = 'NoCloud/ionic_built_snapshots';
/** Folder of the first downloads (before), removed. */
const LEGACY = 'ota';
const READY_KEY = 'webtrad.update.ready';
const TO_KEEP_KEY = 'webtrad.update.toKeep';
const BINARY_KEY = 'webtrad.update.binaryNative';

interface Ready {
  build: number;
  path: string;
}

function read<T>(key: string): T | undefined {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: no update kept, nothing breaks */
  }
}

/** Where the running code comes from: the installed app, or a downloaded update. */
async function runningFromUpdate(): Promise<{ path: string; fromUpdate: boolean }> {
  const { path } = await WebView.getServerBasePath();
  return { path, fromUpdate: path.includes('/ionic_built_snapshots/') || path.includes('/ota/') };
}

/** Comparable version numbers: "9" < "10". */
export function newer(remote: number, current: number): boolean {
  return Number.isFinite(remote) && remote > current;
}

export type UpdateStatus = 'none' | 'ready' | 'reinstall';

async function check(): Promise<UpdateStatus> {
  const already = read<Ready>(READY_KEY);
  const current = Math.max(__WEB_BUILD__, already?.build ?? 0);
  const res = await CapacitorHttp.get({ url: `${RELEASE}/web.json`, responseType: 'json', connectTimeout: 20_000, readTimeout: 30_000 });
  if (res.status !== 200) throw new Error(`web.json HTTP ${res.status}`);
  const info = (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) as { build?: number; native?: number };
  const build = Number(info.build);
  if (!newer(build, current)) return already && newer(already.build, __WEB_BUILD__) ? 'ready' : 'none';
  const binary = read<number>(BINARY_KEY) ?? 1;
  if ((info.native ?? 1) > binary) {
    logInfo('app', `Version ${build} disponible : elle demande de réinstaller l’appli (Sideloadly), elle ne peut pas se mettre à jour seule`);
    return 'reinstall';
  }
  const zipRes = await CapacitorHttp.get({ url: `${RELEASE}/web.zip`, responseType: 'arraybuffer', connectTimeout: 20_000, readTimeout: 120_000 });
  if (zipRes.status !== 200 || typeof zipRes.data !== 'string') throw new Error(`web.zip HTTP ${zipRes.status}`);
  const zip = await JSZip.loadAsync(zipRes.data, { base64: true });
  if (!zip.file('index.html')) throw new Error('web.zip sans index.html');
  const dir = `${SNAPSHOTS}/${build}`;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const data = await entry.async('base64');
    await Filesystem.writeFile({ path: `${dir}/${entry.name}`, data, directory: Directory.Library, recursive: true });
  }
  const { uri } = await Filesystem.getUri({ path: dir, directory: Directory.Library });
  const path = decodeURIComponent(uri.replace(/^file:\/\//, ''));
  write(READY_KEY, { build, path } satisfies Ready);
  logInfo('app', `Nouvelle version ${build} téléchargée : elle s’installera au prochain démarrage`);
  return 'ready';
}

/** For the settings page: looks for a new version now (iPhone app only). */
export function checkNow(): Promise<UpdateStatus> {
  return check();
}

/** For the settings page: switches to the downloaded version now. False while a chapter is being translated. */
export async function installNow(): Promise<boolean> {
  if (isProcessing()) return false;
  await applyIfIdle();
  return true;
}

/** Starts the downloaded version, unless a chapter is being translated. */
async function applyIfIdle(): Promise<void> {
  const ready = read<Ready>(READY_KEY);
  if (!ready || isProcessing() || !newer(ready.build, __WEB_BUILD__)) return;
  write(TO_KEEP_KEY, ready.path);
  write(READY_KEY, undefined);
  logInfo('app', `Passage à la version ${ready.build}`);
  await WebView.setServerBasePath({ path: ready.path });
}

/** Removes the downloaded versions other than the running one (and a download waiting to start). */
async function cleanOld(keep: string): Promise<void> {
  const folder = (p?: string) => p?.match(/\/(?:ionic_built_snapshots|ota)\/([^/]+)\/?$/)?.[1];
  const kept = [folder(keep), folder(read<Ready>(READY_KEY)?.path)];
  try {
    const { files } = await Filesystem.readdir({ path: SNAPSHOTS, directory: Directory.Library });
    for (const f of files) {
      if (!kept.includes(f.name)) await Filesystem.rmdir({ path: `${SNAPSHOTS}/${f.name}`, directory: Directory.Library, recursive: true });
    }
  } catch {
    /* no folder yet */
  }
  // The old folder, unless the code running now comes from it.
  if (!keep.includes(`/${LEGACY}/`)) await Filesystem.rmdir({ path: LEGACY, directory: Directory.Library, recursive: true }).catch(() => undefined);
}

/** Called once the app has started and drawn its first screen. */
export function startUpdates(): void {
  if (!isNativeApp()) return;
  void (async () => {
    try {
      const { path, fromUpdate } = await runningFromUpdate();
      if (!fromUpdate) {
        // The installed app's own code: it tells what the app can run.
        write(BINARY_KEY, NATIVE_LEVEL);
      } else if (!path.includes('/ionic_built_snapshots/')) {
        // Code downloaded by an earlier version, in a folder the app cannot
        // start from: never kept (the next launch would crash); the next
        // download goes to the right place.
        write(TO_KEEP_KEY, undefined);
      } else {
        // Downloaded code that started and drew the app: kept for the next
        // launches. (The path given back by the web view is not always
        // written like the one it was given, "/private/var/…" for
        // "/var/…": comparing them kept the new code from ever being kept,
        // and a restart fell back to the app's own old code.)
        await WebView.persistServerBasePath();
        if (read<string>(TO_KEEP_KEY)) logInfo('app', `Version ${__WEB_BUILD__} installée`);
        write(TO_KEEP_KEY, undefined);
      }
      // Only once the running code is kept: the other downloads go.
      await cleanOld(path);
      // A version downloaded earlier: taken now, at launch, before any reading.
      await applyIfIdle();
    } catch (err) {
      logWarn('app', `Mise à jour : ${(err as Error).message}`);
    }
    const run = () => check().catch((err) => logWarn('app', `Recherche de mise à jour impossible : ${(err as Error).message}`));
    setTimeout(run, 8_000);
    setInterval(run, 6 * 3600_000);
    // Leaving the app with nothing being translated: a good moment to switch.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void applyIfIdle().catch(() => undefined);
    });
  })();
}
