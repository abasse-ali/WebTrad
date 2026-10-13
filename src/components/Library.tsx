import { formatBytes, useT } from '../i18n';
import { useChapters, useStorageEstimate } from '../hooks';
import { deleteChapter } from '../lib/db';
import { displayName } from '../lib/languages';
import { cancelChapter, useJobs } from '../lib/pipeline';
import { useSettings } from '../lib/settings';
import type { Chapter } from '../lib/types';
import { Icon } from './Icon';

export function Library({ onNew }: { onNew: () => void }) {
  const t = useT();
  const chapters = useChapters();
  const jobs = useJobs();
  const { uiLang } = useSettings();
  const storage = useStorageEstimate([chapters?.length]);
  const hasChapters = (chapters?.length ?? 0) > 0;

  const remove = async (c: Chapter) => {
    if (!window.confirm(t('library.confirmDelete', { title: c.title }))) return;
    cancelChapter(c.id);
    await deleteChapter(c.id);
  };

  return (
    <div className="library">
      <section className={`hero ${hasChapters ? 'compact' : ''}`}>
        <div className="hero-text">
          <h1>{t('hero.title')}</h1>
          {!hasChapters && <p>{t('hero.text')}</p>}
          <div className="hero-actions">
            <button className="btn primary big" onClick={onNew}>
              <Icon name="plus" /> {t('hero.cta')}
            </button>
            {!hasChapters && <span className="pill">{t('common.free')}</span>}
          </div>
        </div>
      </section>

      {hasChapters && (
        <section className="shelf">
          <div className="section-head">
            <h2>{t('library.title')}</h2>
            {storage && <span className="muted small">{t('library.storage', { used: formatBytes(storage.usage) })}</span>}
          </div>
          <ul className="grid">
            {chapters!.map((c) => {
              const job = jobs.get(c.id);
              const total = c.stats?.total ?? c.pageIds.length;
              const done = c.stats?.done ?? 0;
              let status: string;
              if (job?.running) status = t('library.processing', { done: job.done, total: job.total || total });
              else if (done === total && total > 0) status = t('library.status.done');
              else if (c.stats?.errors) status = t('library.status.error');
              else if (done > 0) status = t('library.status.partial', { done, total });
              else status = t('library.status.new');
              return (
                <li key={c.id} className="card">
                  <a href={`#/read/${encodeURIComponent(c.id)}`} className="card-link">
                    <div className="cover">
                      {c.cover ? <img src={c.cover} alt="" loading="lazy" /> : <Icon name="image" size={40} />}
                      <span className={`badge ${job?.running ? 'busy' : done === total ? 'ok' : ''}`}>{status}</span>
                    </div>
                    <div className="card-body">
                      <h3 title={c.title}>{c.title}</h3>
                      <p className="muted small">
                        {displayName(c.sourceLang, uiLang)} → {displayName(c.targetLang, uiLang)} ·{' '}
                        {t('common.pages', { n: total })}
                      </p>
                    </div>
                  </a>
                  <button className="icon-btn card-delete" title={t('common.delete')} onClick={() => remove(c)}>
                    <Icon name="trash" size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="how" id="how">
        <h2>{t('how.title')}</h2>
        <ol className="steps">
          {([1, 2, 3, 4] as const).map((n) => (
            <li key={n}>
              <span className="step-num">{n}</span>
              <h3>{t(`how.${n}.title`)}</h3>
              <p>{t(`how.${n}.text`)}</p>
            </li>
          ))}
        </ol>
        <ul className="features">
          <li>
            <Icon name="shield" /> {t('features.private')}
          </li>
          <li>
            <Icon name="wifiOff" /> {t('features.offline')}
          </li>
          <li>
            <Icon name="sparkles" /> {t('features.engines')}
          </li>
        </ul>
      </section>
      {chapters === undefined && <p className="muted center">{t('common.loading')}</p>}
      {chapters?.length === 0 && <p className="muted center small">{t('library.empty')}</p>}
    </div>
  );
}
