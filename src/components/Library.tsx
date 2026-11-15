import { useMemo, useState } from 'react';
import { formatBytes, pageCount, useT } from '../i18n';
import { useChapters, useStorageEstimate } from '../hooks';
import { deleteChapter } from '../lib/db';
import { displayName } from '../lib/languages';
import { cancelChapter, useJobs } from '../lib/pipeline';
import { clearPosition, getLastRead, loadPosition } from '../lib/progress';
import { groupBySeries, seriesOf } from '../lib/series';
import { useSettings } from '../lib/settings';
import type { Chapter } from '../lib/types';
import { Icon } from './Icon';
import { QuickLink } from './QuickImport';

type Sort = 'recent' | 'title';
const SORT_KEY = 'webtrad.librarySort';
/** Below this the whole library fits on a screen: no need for search and sort. */
const TOOLS_FROM = 6;

function storedSort(): Sort {
  try {
    return localStorage.getItem(SORT_KEY) === 'title' ? 'title' : 'recent';
  } catch {
    return 'recent';
  }
}

export function Library({ onNew }: { onNew: () => void }) {
  const t = useT();
  const chapters = useChapters();
  const jobs = useJobs();
  const { uiLang } = useSettings();
  const storage = useStorageEstimate([chapters?.length]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>(storedSort);
  const [openSeries, setOpenSeries] = useState<string | null>(null);
  const hasChapters = (chapters?.length ?? 0) > 0;
  const showTools = (chapters?.length ?? 0) >= TOOLS_FROM;

  // Reading positions live in localStorage (see lib/progress): read once per list.
  const positions = useMemo(() => new Map((chapters ?? []).map((c) => [c.id, loadPosition(c.id)])), [chapters]);

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const list = (chapters ?? []).filter((c) => !q || c.title.toLocaleLowerCase().includes(q));
    if (sort === 'title') {
      // Natural order keeps the chapters of a series together and in sequence.
      const collator = new Intl.Collator(uiLang, { numeric: true, sensitivity: 'base' });
      list.sort((a, b) => collator.compare(a.title, b.title));
    }
    return list;
  }, [chapters, query, sort, uiLang]);

  // Chapters of the same manga share one card, opened to list them.
  const groups = useMemo(() => groupBySeries(shown), [shown]);

  // The chapter being read, unless it was finished.
  const resume = useMemo(() => {
    const last = getLastRead();
    const chapter = chapters?.find((c) => c.id === last);
    const pos = chapter && positions.get(chapter.id);
    return chapter && pos && !pos.finished && (pos.page > 0 || pos.offset > 0) ? chapter : undefined;
  }, [chapters, positions]);

  const changeSort = (next: Sort) => {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      /* ignore */
    }
  };

  const remove = async (c: Chapter) => {
    if (!window.confirm(t('library.confirmDelete', { title: c.title }))) return;
    cancelChapter(c.id);
    await deleteChapter(c.id);
    clearPosition(c.id);
  };

  const chapterCard = (c: Chapter, inSeries: boolean) => {
    const job = jobs.get(c.id);
    const total = c.stats?.total ?? c.pageIds.length;
    const done = c.stats?.done ?? 0;
    const pos = positions.get(c.id);
    const translated = done === total && total > 0;
    let status: string;
    let tone = '';
    if (job?.running) {
      status = t('library.processing', { done: job.done, total: job.total || total });
      tone = 'busy';
    } else if (translated && pos?.finished) {
      status = t('library.read');
      tone = 'read';
    } else if (translated) {
      status = t('library.status.done');
      tone = 'ok';
    } else if (c.stats?.errors) status = t('library.status.error');
    else if (done > 0) status = t('library.status.partial', { done, total });
    else status = t('library.status.new');
    const number = inSeries ? seriesOf(c.title).number : null;
    return (
      <li key={c.id} className="card">
        <a href={`#/read/${encodeURIComponent(c.id)}`} className="card-link">
          <div className="cover">
            {c.cover ? <img src={c.cover} alt="" loading="lazy" /> : <Icon name="image" size={40} />}
            <span className={`badge ${tone}`}>{status}</span>
            {pos && !pos.finished && pos.ratio > 0.01 && (
              <span className="read-bar" aria-hidden="true">
                <span style={{ transform: `scaleX(${pos.ratio})` }} />
              </span>
            )}
          </div>
          <div className="card-body">
            <h3 title={c.title}>{number !== null ? t('library.series.chapter', { number }) : c.title}</h3>
            <p className="muted small">
              {c.sourceLang === 'auto' ? t('lang.detecting') : displayName(c.sourceLang, uiLang)}
              {c.autoSource ? ` (${t('lang.autoShort')})` : ''} → {displayName(c.targetLang, uiLang)} · {pageCount(t, total)}
            </p>
          </div>
        </a>
        <button
          className="icon-btn card-delete"
          title={t('common.delete')}
          aria-label={`${t('common.delete')} – ${c.title}`}
          onClick={() => remove(c)}
        >
          <Icon name="trash" size={16} />
        </button>
      </li>
    );
  };

  return (
    <div className="library">
      <section className={`hero ${hasChapters ? 'compact' : ''}`}>
        <div className="hero-text">
          <h1>{t('hero.title')}</h1>
          {!hasChapters && <p>{t('hero.text')}</p>}
          <div className="hero-actions">
            <QuickLink />
            <button className="btn ghost" onClick={onNew}>
              <Icon name="image" size={18} /> {t('quick.files')}
            </button>
            {resume && (
              <a className="btn big resume" href={`#/read/${encodeURIComponent(resume.id)}`}>
                <Icon name="play" size={18} />
                <span className="stack">
                  <span>{t('library.resume')}</span>
                  <small>{resume.title}</small>
                </span>
              </a>
            )}
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
          {showTools && (
            <div className="shelf-tools">
              <label className="search">
                <Icon name="search" size={16} />
                <input
                  type="search"
                  value={query}
                  placeholder={t('library.search')}
                  aria-label={t('library.search')}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <div className="segmented" role="group" aria-label={t('library.sort')}>
                {(['recent', 'title'] as const).map((s) => (
                  <button key={s} className={sort === s ? 'active' : ''} aria-pressed={sort === s} onClick={() => changeSort(s)}>
                    {t(`library.sort.${s}`)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {shown.length === 0 && <p className="muted center">{t('library.noMatch', { query: query.trim() })}</p>}
          <ul className="grid">
            {groups.map((g) => {
              if (g.items.length === 1) return chapterCard(g.items[0], false);
              const open = openSeries === g.key || query.trim() !== '';
              // The chapter to go on with: the one being read, else the first not finished.
              const current =
                g.items.find((c) => c.id === resume?.id) ??
                g.items.find((c) => !positions.get(c.id)?.finished) ??
                g.items[g.items.length - 1];
              const read = g.items.filter((c) => positions.get(c.id)?.finished).length;
              const busy = g.items.some((c) => jobs.get(c.id)?.running);
              const first = seriesOf(g.items[0].title).number;
              const last = seriesOf(g.items[g.items.length - 1].title).number;
              const cover = current.cover ?? g.items.find((c) => c.cover)?.cover;
              return [
                <li key={g.key} className={`card series-card ${open ? 'open' : ''}`}>
                  <button
                    type="button"
                    className="card-link"
                    aria-expanded={open}
                    onClick={() => setOpenSeries(open ? null : g.key)}
                  >
                    <div className="cover">
                      {cover ? <img src={cover} alt="" loading="lazy" /> : <Icon name="image" size={40} />}
                      <span className={`badge ${busy ? 'busy' : ''}`}>{t('library.series.count', { count: g.items.length })}</span>
                    </div>
                    <div className="card-body">
                      <h3 title={g.name}>{g.name}</h3>
                      <p className="muted small">
                        {first !== null && last !== null ? t('library.series.range', { first, last }) : ''}
                        {read > 0 ? ` · ${t('library.series.read', { read })}` : ''}
                      </p>
                    </div>
                  </button>
                </li>,
                open && (
                  <li key={`${g.key}:open`} className="series-open">
                    <div className="series-head">
                      <h3>{g.name}</h3>
                      <a className="btn small" href={`#/read/${encodeURIComponent(current.id)}`}>
                        <Icon name="play" size={16} /> {t('library.series.continue', { number: seriesOf(current.title).number ?? '' })}
                      </a>
                    </div>
                    <ul className="grid">{g.items.map((c) => chapterCard(c, true))}</ul>
                  </li>
                ),
              ];
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
