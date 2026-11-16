import { useMemo, useState } from 'react';
import { useT, type MessageKey } from '../i18n';
import { useChapters } from '../hooks';
import { deleteChapter } from '../lib/db';
import { cancelChapter, useJobs, type JobState } from '../lib/pipeline';
import { clearPosition, getLastRead, loadPosition, type ReadingPosition } from '../lib/progress';
import { groupBySeries, seriesOf, type SeriesGroup } from '../lib/series';
import { updateSettings, useSettings } from '../lib/settings';
import type { Chapter } from '../lib/types';
import { navigate } from '../router';
import { CoverDialog } from './CoverDialog';
import { Icon } from './Icon';
import { AddSheet, HelpSheet, type AddTab } from './AddSheet';

type Sort = 'recent' | 'title';
const SORT_KEY = 'webtrad.librarySort';

function storedSort(): Sort {
  try {
    return localStorage.getItem(SORT_KEY) === 'title' ? 'title' : 'recent';
  } catch {
    return 'recent';
  }
}

/** The image of a manga: the one chosen or found on the site, else the top of a first page. */
export function seriesCover(items: Chapter[], current?: Chapter): string | undefined {
  return (
    (items.find((c) => c.coverChosen) ?? items.find((c) => c.seriesCover))?.seriesCover ??
    current?.cover ??
    items.find((c) => c.cover)?.cover
  );
}

/** Where a manga opens: its page when it has several chapters, else the reader. */
export function seriesHref(g: SeriesGroup<Chapter>): string {
  return g.items.length > 1 ? `#/series/${encodeURIComponent(g.key)}` : `#/read/${encodeURIComponent(g.items[0].id)}`;
}

/** Deletes chapters after one confirmation. */
export async function removeChapters(list: Chapter[], question: string): Promise<boolean> {
  if (!window.confirm(question)) return false;
  for (const c of list) {
    cancelChapter(c.id);
    await deleteChapter(c.id);
    clearPosition(c.id);
  }
  return true;
}

/** Small status shown on a cover: working, errors, finished… */
export function chapterState(
  c: Chapter,
  job: JobState | undefined,
  pos: ReadingPosition | null | undefined,
): { tone: string; key: MessageKey; vars: Record<string, number> } {
  const total = c.stats?.total ?? c.pageIds.length;
  const done = c.stats?.done ?? 0;
  if (job?.running && job.queued) return { tone: 'queued', key: 'library.queued' as const, vars: {} };
  if (job?.running) return { tone: 'busy', key: 'library.processing' as const, vars: { done: job.done, total: job.total || total } };
  if (c.stats?.errors) return { tone: 'error', key: 'library.status.error' as const, vars: {} };
  if (done === total && total > 0) return pos?.finished ? { tone: 'read', key: 'library.read' as const, vars: {} } : { tone: 'ok', key: 'library.status.done' as const, vars: {} };
  if (done > 0) return { tone: '', key: 'library.status.partial' as const, vars: { done, total } };
  return { tone: '', key: 'library.status.new' as const, vars: {} };
}

export function Library() {
  const t = useT();
  const chapters = useChapters();
  const jobs = useJobs();
  const { uiLang } = useSettings();
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [sort, setSort] = useState<Sort>(storedSort);
  const [coverFor, setCoverFor] = useState<{ chapters: Chapter[]; name: string } | null>(null);
  const [actionsFor, setActionsFor] = useState<SeriesGroup<Chapter> | null>(null);
  const [adding, setAdding] = useState<AddTab | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const hasChapters = (chapters?.length ?? 0) > 0;
  const sheets = (
    <>
      {adding && <AddSheet initialTab={adding} onClose={() => setAdding(null)} />}
      {helpOpen && <HelpSheet onClose={() => setHelpOpen(false)} />}
    </>
  );

  // Reading positions live in localStorage (see lib/progress): read once per list.
  const positions = useMemo(() => new Map((chapters ?? []).map((c) => [c.id, loadPosition(c.id)])), [chapters]);

  const groups = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const list = (chapters ?? []).filter((c) => !q || c.title.toLocaleLowerCase().includes(q));
    const all = groupBySeries(list);
    if (sort === 'title') {
      const collator = new Intl.Collator(uiLang, { numeric: true, sensitivity: 'base' });
      all.sort((a, b) => collator.compare(a.name, b.name));
    }
    return all;
  }, [chapters, query, sort, uiLang]);

  // The chapter being read, unless it was finished.
  const resume = useMemo(() => {
    const last = getLastRead();
    const chapter = chapters?.find((c) => c.id === last);
    const pos = chapter && positions.get(chapter.id);
    return chapter && pos && !pos.finished && (pos.page > 0 || pos.offset > 0) ? { chapter, pos } : undefined;
  }, [chapters, positions]);

  const changeSort = () => {
    const next: Sort = sort === 'recent' ? 'title' : 'recent';
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      /* ignore */
    }
  };

  if (chapters === undefined) return <p className="muted center">{t('common.loading')}</p>;

  if (!hasChapters) {
    return (
      <div className="library">
        <BrandBar />
        <h1 className="screen-title">{t('library.title')}</h1>
        <section className="start">
          <StartArt />
          <h2>{t('start.title')}</h2>
          <p className="muted">{t('start.text')}</p>
          <div className="start-options">
            <button className="start-option main" onClick={() => setAdding('url')}>
              <span className="start-icon">
                <Icon name="link" size={26} />
              </span>
              <span className="start-text">
                <strong>
                  {t('start.link')} <span className="badge">{t('start.link.badge')}</span>
                </strong>
                <span className="muted">{t('start.link.text')}</span>
              </span>
              <Icon name="forward" size={20} />
            </button>
            <button className="start-option" onClick={() => setAdding('images')}>
              <span className="start-icon">
                <Icon name="image" size={26} />
              </span>
              <span className="start-text">
                <strong>{t('start.images')}</strong>
                <span className="muted">{t('start.images.text')}</span>
              </span>
              <Icon name="forward" size={20} />
            </button>
            <button className="start-option" onClick={() => setAdding('file')}>
              <span className="start-icon">
                <Icon name="folder" size={26} />
              </span>
              <span className="start-text">
                <strong>{t('start.file')}</strong>
                <span className="muted">{t('start.file.text')}</span>
              </span>
              <Icon name="forward" size={20} />
            </button>
          </div>
          <button className="link-btn where" onClick={() => setHelpOpen(true)}>
            <Icon name="help" size={18} /> {t('start.where')}
          </button>
          <p className="muted small center">
            {t('features.private')} {t('common.free')}.
          </p>
        </section>
        {sheets}
      </div>
    );
  }

  return (
    <div className="library">
      <BrandBar />
      <header className="page-head">
        <h1 className="screen-title">{t('library.title')}</h1>
        <div className="head-actions">
          <button
            className={`icon-btn ${searching ? 'on' : ''}`}
            onClick={() => (setSearching((v) => !v), setQuery(''))}
            aria-label={t('library.search')}
            aria-pressed={searching}
            title={t('library.search')}
          >
            <Icon name="search" />
          </button>
          <button className="chip" onClick={changeSort} title={t('library.sort')}>
            <Icon name="swap" size={14} /> {t(`library.sort.${sort}`)}
          </button>
        </div>
      </header>

      {searching && (
        <label className="search">
          <Icon name="search" size={16} />
          <input
            type="search"
            autoFocus
            value={query}
            placeholder={t('library.search')}
            aria-label={t('library.search')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}

      {resume && !searching && (
        <a className="continue" href={`#/read/${encodeURIComponent(resume.chapter.id)}`}>
          <img src={seriesCover([resume.chapter], resume.chapter) ?? ''} alt="" />
          <span className="continue-text">
            <small>{t('library.resume')}</small>
            <strong>{seriesOf(resume.chapter.title).name}</strong>
            <span className="muted small">
              {seriesOf(resume.chapter.title).number !== null
                ? t('library.series.chapter', { number: seriesOf(resume.chapter.title).number! })
                : resume.chapter.title}
            </span>
            <span className="bar" aria-hidden="true">
              <span style={{ transform: `scaleX(${Math.max(0.03, resume.pos.ratio)})` }} />
            </span>
          </span>
          <span className="continue-play" aria-hidden="true">
            <Icon name="play" size={20} />
          </span>
        </a>
      )}

      {groups.length === 0 && <p className="muted center">{t('library.noMatch', { query: query.trim() })}</p>}
      <ul className="cards">
        {groups.map((g) => {
          const latest = g.items[g.items.length - 1];
          const busy = g.items.find((c) => jobs.get(c.id)?.running && !jobs.get(c.id)?.queued);
          const single = g.items.length === 1;
          const state = single ? chapterState(latest, jobs.get(latest.id), positions.get(latest.id)) : null;
          const read = g.items.filter((c) => positions.get(c.id)?.finished).length;
          const unread = g.items.length - read;
          const pos = single ? positions.get(latest.id) : null;
          const ratio = single ? (pos?.finished ? 1 : (pos?.ratio ?? 0)) : read / g.items.length;
          const number = seriesOf(latest.title).number;
          const job = busy ? jobs.get(busy.id) : undefined;
          return (
            <li key={g.key} className="card-item">
              <a href={seriesHref(g)} className="card-link">
                <span className="card-cover">
                  {seriesCover(g.items) ? <img src={seriesCover(g.items)} alt="" loading="lazy" /> : <Icon name="image" size={28} />}
                  {ratio > 0.01 && (
                    <span className="bar" aria-hidden="true">
                      <span style={{ transform: `scaleX(${ratio})` }} />
                    </span>
                  )}
                </span>
                <span className="card-text">
                  <strong className="card-title" title={g.name}>
                    {g.name}
                  </strong>
                  <span className="card-badges">
                    <span className="badge-pill">
                      <Icon name={latest.layout === 'manga' || latest.layout === 'comic' ? 'library' : 'phone'} size={13} />{' '}
                      {t(`add.layout.badge.${latest.layout ?? 'webtoon'}`)}
                    </span>
                    <span className="badge-pill">
                      <Icon name="globe" size={13} /> {latest.targetLang.toUpperCase().slice(0, 2)}
                    </span>
                    {!single && unread > 0 && <span className="badge-pill accent">{unread}</span>}
                  </span>
                  <span className="card-meta">
                    {busy && job ? (
                      <>
                        <span className="dot" /> {t('reader.translating', { done: job.done, total: job.total || busy.pageIds.length })}
                      </>
                    ) : single ? (
                      state && state.tone !== 'ok' && state.tone !== '' ? (
                        <span className={`tone-${state.tone}`}>{t(state.key, state.vars)}</span>
                      ) : number !== null ? (
                        t('library.series.chapter', { number })
                      ) : (
                        t('library.series.count', { count: 1 })
                      )
                    ) : (
                      t('library.series.count', { count: g.items.length })
                    )}
                  </span>
                </span>
              </a>
              <button className="card-more" onClick={() => setActionsFor(g)} aria-label={`${t('reader.menu')} – ${g.name}`}>
                <Icon name="more" size={18} />
              </button>
            </li>
          );
        })}
      </ul>

      <button className="fab" onClick={() => setAdding('url')}>
        <Icon name="plus" size={22} /> {t('library.add')}
      </button>
      {sheets}

      {actionsFor && (
        <ActionSheet title={actionsFor.name} onClose={() => setActionsFor(null)}>
          <a className="sheet-item" href={seriesHref(actionsFor)}>
            <Icon name="library" size={18} /> {actionsFor.items.length > 1 ? t('library.openSeries') : t('library.open')}
          </a>
          <button
            className="sheet-item"
            onClick={() => {
              setCoverFor({ chapters: actionsFor.items, name: actionsFor.name });
              setActionsFor(null);
            }}
          >
            <Icon name="image" size={18} /> {t('library.changeCover')}
          </button>
          <button
            className="sheet-item danger"
            onClick={async () => {
              const list = actionsFor.items;
              const ok = await removeChapters(
                list,
                list.length > 1 ? t('library.confirmDeleteSeries', { title: actionsFor.name, count: list.length }) : t('library.confirmDelete', { title: list[0].title }),
              );
              if (ok) setActionsFor(null);
            }}
          >
            <Icon name="trash" size={18} /> {actionsFor.items.length > 1 ? t('library.deleteSeries') : t('common.delete')}
          </button>
        </ActionSheet>
      )}
      {coverFor && <CoverDialog chapters={coverFor.chapters} name={coverFor.name} onClose={() => setCoverFor(null)} />}
    </div>
  );
}

/** The app's name and the switch between dark and light. */
function BrandBar() {
  const t = useT();
  const { theme } = useSettings();
  const dark =
    theme === 'dark' || (theme === 'auto' && typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  return (
    <div className="brand-bar">
      <span className="brand">
        <img src="./icon.svg" alt="" width={34} height={34} />
        <span>WebTrad</span>
      </span>
      <button
        className="round-btn"
        onClick={() => updateSettings({ theme: dark ? 'light' : 'dark' })}
        aria-label={dark ? t('theme.toLight') : t('theme.toDark')}
        title={dark ? t('theme.toLight') : t('theme.toDark')}
      >
        <Icon name={dark ? 'moon' : 'sun'} size={22} />
      </button>
    </div>
  );
}

/** Three pages fanned out, each saying hello in another language. */
function StartArt() {
  return (
    <div className="start-art" aria-hidden="true">
      <span className="art-card left">
        <span className="art-bubble">안녕!</span>
      </span>
      <span className="art-card right">
        <span className="art-bubble">こんにちは</span>
      </span>
      <span className="art-card middle">
        <span className="art-bubble">Bonjour !</span>
        <span className="art-lines" />
      </span>
    </div>
  );
}

/** A list of actions sliding up from the bottom of the screen (iOS style). */
export function ActionSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const t = useT();
  return (
    <div className="action-backdrop" onClick={onClose}>
      <div className="action-sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="action-title">{title}</div>
        <div className="action-list">{children}</div>
        <button className="sheet-item cancel" onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

/** Opens the library (used by screens that delete what they show). */
export const toLibrary = () => navigate('/');
