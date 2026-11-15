/**
 * The artwork shown for a manga in the library. Every chapter keeps a copy
 * (`seriesCover`), so a series card shows it whatever chapter comes first,
 * and a new chapter of a known series gets it at once.
 */
import { listChapters, patchChapter } from './db';
import { seriesOf } from './series';
import type { Chapter } from './types';

function sameSeries(title: string): (c: Chapter) => boolean {
  const key = seriesOf(title).key;
  return (c) => key !== '' && seriesOf(c.title).key === key;
}

/** The cover of the other chapters of this series: the one the reader chose first. */
export async function seriesCoverOf(title: string): Promise<{ cover: string; chosen: boolean } | undefined> {
  const siblings = (await listChapters()).filter(sameSeries(title)).filter((c) => c.seriesCover);
  const pick = siblings.find((c) => c.coverChosen) ?? siblings[0];
  return pick?.seriesCover ? { cover: pick.seriesCover, chosen: Boolean(pick.coverChosen) } : undefined;
}

/** Gives a cover found on the site to the chapters of the series that have none chosen. */
export async function shareSeriesCover(title: string, cover: string): Promise<void> {
  for (const c of (await listChapters()).filter(sameSeries(title))) {
    if (!c.coverChosen && c.seriesCover !== cover) await patchChapter(c.id, { seriesCover: cover }, false);
  }
}

/**
 * The reader's choice for a whole series (or one chapter): `undefined` goes
 * back to the top of the first page.
 */
export async function setSeriesCover(chapters: Chapter[], cover: string | undefined): Promise<void> {
  const ids = new Set(chapters.map((c) => c.id));
  const all = chapters.length > 0 ? (await listChapters()).filter((c) => ids.has(c.id) || sameSeries(chapters[0].title)(c)) : [];
  for (const c of all) await patchChapter(c.id, { seriesCover: cover, coverChosen: cover !== undefined }, false);
}
