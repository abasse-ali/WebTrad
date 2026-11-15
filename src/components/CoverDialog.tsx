import { useState } from 'react';
import { useT } from '../i18n';
import { setSeriesCover } from '../lib/cover';
import { makeCover } from '../lib/image';
import { coverFromHtml, downloadCover, fetchAny } from '../lib/importers';
import { logInfo, logWarn } from '../lib/log';
import { coverWithBrowser, isNativeApp } from '../lib/native';
import { browserLabels } from '../lib/quick';
import { getSettings } from '../lib/settings';
import type { Chapter } from '../lib/types';
import { Icon } from './Icon';
import { Modal } from './Reader';

/** Finds the artwork named by the chapter page the series was imported from. */
async function coverFromSite(pageUrl: string, t: ReturnType<typeof useT>): Promise<Blob | undefined> {
  const proxy = getSettings().corsProxy;
  try {
    const { res } = await fetchAny(pageUrl, 'page', proxy);
    const url = coverFromHtml(await res.text(), pageUrl);
    const blob = url ? await downloadCover(url, proxy, pageUrl) : undefined;
    if (blob) return blob;
  } catch (err) {
    logWarn('import', `Couverture introuvable par lien : ${(err as Error).message}`, { page: pageUrl });
  }
  // Sites behind Cloudflare: the app's own browser gets in.
  return isNativeApp() ? coverWithBrowser(pageUrl, browserLabels(t)) : undefined;
}

/** Changes the image of a manga (all its chapters) in the library. */
export function CoverDialog({ chapters, name, onClose }: { chapters: Chapter[]; name: string; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = chapters.find((c) => c.coverChosen)?.seriesCover ?? chapters.find((c) => c.seriesCover)?.seriesCover ?? chapters[0]?.cover;
  const origin = chapters.find((c) => c.origin)?.origin;

  const apply = async (blob: Blob | undefined, how: string) => {
    if (!blob) {
      setError(t('cover.notFound'));
      return;
    }
    await setSeriesCover(chapters, await makeCover(blob));
    logInfo('app', `Image de « ${name} » changée (${how})`);
    onClose();
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(t('error.generic', { message: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('cover.title', { name })} onClose={onClose}>
      <div className="cover-dialog">
        {current ? <img className="cover-preview" src={current} alt="" /> : <div className="cover-preview" />}
        <div className="cover-actions">
          <label className={`btn primary ${busy ? 'disabled' : ''}`}>
            <Icon name="image" size={16} /> {t('cover.pick')}
            <input
              type="file"
              accept="image/*"
              hidden
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void run(() => apply(file, 'photo'));
              }}
            />
          </label>
          {origin && (
            <button className="btn" disabled={busy} onClick={() => run(async () => apply(await coverFromSite(origin, t), 'site'))}>
              <Icon name="globe" size={16} /> {busy ? t('cover.searching') : t('cover.site')}
            </button>
          )}
          <button
            className="btn ghost"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await setSeriesCover(chapters, undefined);
                onClose();
              })
            }
          >
            <Icon name="refresh" size={16} /> {t('cover.reset')}
          </button>
        </div>
      </div>
      {error && <p className="error small">{error}</p>}
      <div className="sheet-actions">
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Modal>
  );
}
