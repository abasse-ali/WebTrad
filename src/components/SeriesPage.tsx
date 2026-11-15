import { useMemo, useState } from 'react';
import { pageCount, useT } from '../i18n';
import { useChapters } from '../hooks';
import { useJobs } from '../lib/pipeline';
import { loadPosition } from '../lib/progress';
import { quickImport } from '../lib/quick';
import { groupBySeries, seriesOf } from '../lib/series';
import type { Chapter } from '../lib/types';
import { navigate } from '../router';
import { CoverDialog } from './CoverDialog';
import { Icon } from './Icon';
import { ActionSheet, chapterState, removeChapters, seriesCover } from './Library';

/** One manga: its image, "continue", and the list of its chapters. */
export function SeriesPage({ seriesKey }: { seriesKey: string }) {
  const t = useT();
  const chapters = useChapters();
  const jobs = useJobs();
  const [newestFirst, setNewestFirst] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const [actionsFor, setActionsFor] = useState<Chapter | null>(null);

  const group = useMemo(() => groupBySeries(chapters ?? []).find((g) => g.key === seriesKey), [chapters, seriesKey]);
  const positions = useMemo(() => new Map((group?.items ?? []).map((c) => [c.id, loadPosition(c.id)])), [group]);

  if (chapters === undefined) return <p className="muted center">{t('common.loading')}</p>;
  if (!group) {
    return (
      <div className="series-page">
        <p className="muted center">{t('reader.notFound')}</p>
        <a className="btn" href="#/">
          {t('nav.library')}
        </a>
      </div>
    );
  }

  const items = newestFirst ? group.items.slice().reverse() : group.items;
  // The chapter to go on with: the one started, else the first not finished.
  const current =
    group.items.find((c) => {
      const p = positions.get(c.id);
      return p && !p.finished && (p.page > 0 || p.offset > 0);
    }) ??
    group.items.find((c) => !positions.get(c.id)?.finished) ??
    group.items[group.items.length - 1];
  const started = group.items.some((c) => positions.get(c.id));
  const read = group.items.filter((c) => positions.get(c.id)?.finished).length;
  const cover = seriesCover(group.items);
  const last = group.items[group.items.length - 1];
  const numberOf = (c: Chapter) => seriesOf(c.title).number;

  return (
    <div className="series-page">
      <header className="series-hero" style={cover ? { ['--cover' as string]: `url("${cover}")` } : undefined}>
        <a className="icon-btn back" href="#/" aria-label={t('reader.back')}>
          <Icon name="back" />
        </a>
        <button className="series-cover" onClick={() => setCoverOpen(true)} aria-label={t('library.changeCover')}>
          {cover ? <img src={cover} alt="" /> : <Icon name="image" size={36} />}
          <span className="cover-edit">
            <Icon name="edit" size={14} />
          </span>
        </button>
        <div className="series-info">
          <h1>{group.name}</h1>
          <p className="muted">
            {t('library.series.count', { count: group.items.length })}
            {read > 0 && ` · ${t('library.series.read', { read })}`}
          </p>
          <a className="btn primary" href={`#/read/${encodeURIComponent(current.id)}`}>
            <Icon name="play" size={18} />
            {started
              ? t('library.series.continue', { number: numberOf(current) ?? '' })
              : t('library.series.start', { number: numberOf(current) ?? '' })}
          </a>
        </div>
      </header>

      <section className="group">
        <div className="group-head">
          <h2 className="group-title">{t('library.chapters')}</h2>
          <button className="chip" onClick={() => setNewestFirst((v) => !v)}>
            <Icon name="swap" size={14} /> {newestFirst ? t('library.order.newest') : t('library.order.oldest')}
          </button>
        </div>
        <ul className="list">
          {items.map((c) => {
            const pos = positions.get(c.id);
            const state = chapterState(c, jobs.get(c.id), pos);
            const n = numberOf(c);
            return (
              <li key={c.id} className={`list-row chapter-row ${pos?.finished ? 'done' : ''}`}>
                <a className="list-link" href={`#/read/${encodeURIComponent(c.id)}`}>
                  {c.cover ? <img className="row-thumb" src={c.cover} alt="" loading="lazy" /> : <span className="row-thumb" />}
                  <span className="list-text">
                    <strong>{n !== null ? t('library.series.chapter', { number: n }) : c.title}</strong>
                    <small>
                      <span className={`state ${state.tone}`}>{t(state.key, state.vars)}</span> · {pageCount(t, c.stats?.total ?? c.pageIds.length)}
                    </small>
                    {pos && !pos.finished && pos.ratio > 0.01 && (
                      <span className="bar" aria-hidden="true">
                        <span style={{ transform: `scaleX(${pos.ratio})` }} />
                      </span>
                    )}
                  </span>
                  {pos?.finished && <Icon name="check" size={18} className="row-check" />}
                </a>
                <button className="icon-btn" onClick={() => setActionsFor(c)} aria-label={`${t('reader.menu')} – ${c.title}`}>
                  <Icon name="more" size={18} />
                </button>
              </li>
            );
          })}
        </ul>
        {last.nextUrl && !group.items.some((c) => c.origin === last.nextUrl) && (
          <button className="btn wide" onClick={() => void quickImport(last.nextUrl!)}>
            <Icon name="download" size={18} /> {t('library.importNext', { number: (numberOf(last) ?? 0) + 1 })}
          </button>
        )}
      </section>

      {actionsFor && (
        <ActionSheet title={actionsFor.title} onClose={() => setActionsFor(null)}>
          <a className="sheet-item" href={`#/read/${encodeURIComponent(actionsFor.id)}`}>
            <Icon name="play" size={18} /> {t('library.open')}
          </a>
          <button
            className="sheet-item danger"
            onClick={async () => {
              const alone = group.items.length === 1;
              if (await removeChapters([actionsFor], t('library.confirmDelete', { title: actionsFor.title }))) {
                setActionsFor(null);
                if (alone) navigate('/');
              }
            }}
          >
            <Icon name="trash" size={18} /> {t('common.delete')}
          </button>
        </ActionSheet>
      )}
      {coverOpen && <CoverDialog chapters={group.items} name={group.name} onClose={() => setCoverOpen(false)} />}
    </div>
  );
}
