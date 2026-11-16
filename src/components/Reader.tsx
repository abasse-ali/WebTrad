import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatBytes, useT, type MessageKey } from '../i18n';
import { useChapter, useDismiss } from '../hooks';
import { deleteChapter, getPage, listChapters, patchChapter, patchPage, uid } from '../lib/db';
import { downloadBlob, exportChapter, fontsReady, renderPage, safeName, type ExportFormat, type ExportMode } from '../lib/exporter';
import { isNativeApp } from '../lib/native';
import { clearLayoutCache, type LayoutOptions } from '../lib/layout';
import { decodeImage } from '../lib/image';
import { isImageUrl } from '../lib/importers';
import { ocrRegion } from '../lib/ocr';
import { cancelChapter, startChapter, stopChapter, translateBubbles, useJob } from '../lib/pipeline';
import { clearPosition, loadPosition, savePosition, setLastRead, type ReadingPosition } from '../lib/progress';
import { guessNextUrl, neighbours, seriesOf } from '../lib/series';
import { quickImport } from '../lib/quick';
import { getSettings, updateSettings, useSettings } from '../lib/settings';
import type { Box } from '../lib/text';
import type { Bubble, Chapter, Page, ReaderMode } from '../lib/types';
import { navigate } from '../router';
import { SPEED_LEVELS, clampSpeed, useAutoScroll } from '../lib/autoscroll';
import { BubbleSheet } from './BubbleSheet';
import { UsageMeter } from './UsageMeter';
import { Icon } from './Icon';
import { LangSelect } from './LangSelect';
import { PageView } from './PageView';
import { ReadAloud } from './ReadAloud';
import { unlockSpeech } from '../lib/voices';

const NO_BUSY: string[] = [];
/** Scroll distance in one direction that hides or brings back the top bar. */
const BAR_TRAVEL = 24;

export function Reader({ id }: { id: string }) {
  const t = useT();
  const settings = useSettings();
  // The AI reads (or translates) the pages: its request count is shown while it works.
  const usesAi = settings.ocrEngine === 'vision' || settings.provider === 'llm';
  const { chapter, pages } = useChapter(id);
  const job = useJob(id);
  const [mode, setModeState] = useState<ReaderMode>('translated');
  const [editing, setEditing] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [selection, setSelection] = useState<{ pageId: string; bubbleId: string } | null>(null);
  const [draft, setDraft] = useState<Bubble | null>(null);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [barHidden, setBarHidden] = useState(false);
  const [current, setCurrent] = useState(0);
  /** Automatic scrolling: off, moving, or paused with its controls still shown. */
  const [auto, setAuto] = useState<'off' | 'play' | 'pause'>('off');
  const autoRef = useRef(auto);
  autoRef.current = auto;
  /** Reading aloud, with a voice per character. */
  const [voiceOn, setVoiceOn] = useState(false);
  const startVoice = () => {
    unlockSpeech();
    setAuto('off');
    setVoiceOn(true);
  };
  const [siblings, setSiblings] = useState<{ previous?: Chapter; next?: Chapter }>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [fontsOk, setFontsOk] = useState(false);
  const urls = useRef(new Map<string, string>());

  useEffect(() => {
    void fontsReady().then(() => {
      clearLayoutCache();
      setFontsOk(true);
    });
    const cache = urls.current;
    return () => {
      cache.forEach((u) => URL.revokeObjectURL(u));
      cache.clear();
    };
  }, []);

  const urlFor = (p: Page) => {
    let u = urls.current.get(p.id);
    if (!u) {
      u = URL.createObjectURL(p.blob);
      urls.current.set(p.id, u);
    }
    return u;
  };

  // Keep the latest values reachable from stable callbacks (PageView is memoised).
  const latest = useRef({ pages, chapter, draft, selection });
  latest.current = { pages, chapter, draft, selection };

  const opts: LayoutOptions = useMemo(
    () => ({ font: settings.font, letterCase: settings.letterCase, target: chapter?.targetLang ?? settings.targetLang }),
    [settings.font, settings.letterCase, chapter?.targetLang, settings.targetLang],
  );

  // --- reading position ------------------------------------------------------
  /** Where the top of the screen is in the chapter, and how much of it was read. */
  const measure = useCallback((): ReadingPosition | null => {
    const list = latest.current.pages ?? [];
    if (list.length === 0) return null;
    const rectOf = (p: Page) => document.getElementById(`page-${p.index}`)?.getBoundingClientRect();
    const first = rectOf(list[0]);
    const last = rectOf(list[list.length - 1]);
    if (!first || !last) return null;
    let page = list[list.length - 1].index;
    let offset = 1;
    for (const p of list) {
      const r = rectOf(p);
      if (r && r.bottom > 1) {
        page = p.index;
        offset = r.height > 0 ? Math.min(1, Math.max(0, -r.top / r.height)) : 0;
        break;
      }
    }
    const scrollable = last.bottom - first.top - window.innerHeight;
    const ratio = scrollable > 0 ? Math.min(1, Math.max(0, -first.top / scrollable)) : 1;
    return { page, offset, ratio, finished: last.bottom <= window.innerHeight + 48 };
  }, []);

  const scrollToPosition = useCallback((pos: { page: number; offset: number }) => {
    const r = document.getElementById(`page-${pos.page}`)?.getBoundingClientRect();
    if (r) window.scrollTo(0, window.scrollY + r.top + pos.offset * r.height);
  }, []);

  const restored = useRef(false);
  const finished = useRef(false);
  useEffect(() => {
    if (restored.current || !pages || pages.length === 0) return;
    const saved = loadPosition(id);
    finished.current = saved?.finished ?? false;
    const frame = requestAnimationFrame(() => {
      // A chapter that was read to the end opens at its beginning again, and
      // one that was barely started stays at the very top, bar in view.
      const started = saved !== null && (saved.page > 0 || saved.offset > 0.002);
      if (saved && started && !(saved.finished && saved.ratio > 0.97)) scrollToPosition(saved);
      restored.current = true;
      setLastRead(id);
    });
    return () => cancelAnimationFrame(frame);
  }, [pages, id, scrollToPosition]);

  useEffect(() => {
    let lastY = window.scrollY;
    let travelled = 0;
    let timer = 0;
    let frame = 0;
    const track = () => {
      frame = 0;
      const pos = measure();
      if (pos) setCurrent(pos.page);
    };
    const onScroll = () => {
      const y = window.scrollY;
      const dy = y - lastY;
      lastY = y;
      // Immersive reading: the bar leaves when scrolling down, returns when scrolling up.
      if (y < 48) {
        travelled = 0;
        setBarHidden(false);
      } else if (dy !== 0) {
        travelled = Math.sign(travelled) === Math.sign(dy) ? travelled + dy : dy;
        if (travelled > BAR_TRAVEL) setBarHidden(true);
        else if (travelled < -BAR_TRAVEL) setBarHidden(false);
      }
      if (!frame) frame = requestAnimationFrame(track);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!restored.current) return;
        const pos = measure();
        if (!pos) return;
        finished.current ||= pos.finished;
        savePosition(id, { ...pos, finished: finished.current });
      }, 250);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [id, measure]);

  // Changing the layout (compare mode halves every page) must not lose the place.
  const keepPlace = useRef<ReadingPosition | null>(null);
  const setMode = useCallback(
    (next: ReaderMode | ((m: ReaderMode) => ReaderMode)) => {
      keepPlace.current = measure();
      setModeState(next);
    },
    [measure],
  );
  useLayoutEffect(() => {
    if (keepPlace.current) scrollToPosition(keepPlace.current);
    keepPlace.current = null;
  }, [mode, scrollToPosition]);

  // Neighbouring chapters of the same series, for the end-of-chapter panel.
  const title = chapter?.title;
  useEffect(() => {
    if (title === undefined) return;
    let alive = true;
    void listChapters().then((all) => alive && setSiblings(neighbours(all, { id, title })));
    return () => {
      alive = false;
    };
  }, [id, title]);

  const changeSpeed = useCallback((by: number) => {
    updateSettings({ scrollSpeed: clampSpeed(clampSpeed(getSettings().scrollSpeed) + by) });
  }, []);

  // Keyboard: O toggles original, E toggles edit mode, A the automatic
  // scrolling (then Space pauses it, + and - change its speed).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'o') setMode((m) => (m === 'original' ? 'translated' : 'original'));
      if (e.key === 'e') setEditing((v) => !v);
      if (e.key === 'a') setAuto((a) => (a === 'off' ? 'play' : 'off'));
      if (e.key === 'v') setVoiceOn((v) => !v);
      if (autoRef.current === 'off') return;
      if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        setAuto((a) => (a === 'play' ? 'pause' : 'play'));
      }
      if (e.key === '+' || e.key === '=') changeSpeed(1);
      if (e.key === '-') changeSpeed(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setMode, changeSpeed]);

  // A new message brings the bar back for a moment; it must not pin it for good.
  const [attention, setAttention] = useState(false);
  useEffect(() => {
    if (!notice) return;
    setAttention(true);
    const timer = window.setTimeout(() => setAttention(false), 8000);
    return () => {
      window.clearTimeout(timer);
      setAttention(false);
    };
  }, [notice]);

  const lastDismiss = useRef(0);
  const menuRef = useDismiss<HTMLDivElement>(menuOpen, () => {
    lastDismiss.current = Date.now();
    setMenuOpen(false);
  });
  /** A tap on the artwork shows or hides the bar (not the tap that closes the menu). */
  const onTap = useCallback(() => {
    if (Date.now() - lastDismiss.current <= 400) return;
    // While the page scrolls on its own, a tap on the artwork pauses and resumes it.
    if (autoRef.current !== 'off') setAuto((a) => (a === 'play' ? 'pause' : 'play'));
    else setBarHidden((v) => !v);
  }, []);

  // --- bubble editing -------------------------------------------------------
  const savePageBubbles = async (pageId: string, update: (bubbles: Bubble[]) => Bubble[]) => {
    const page = await getPage(pageId);
    if (page) await patchPage(pageId, { bubbles: update(page.bubbles) });
  };

  const onSelect = useCallback((pageId: string, bubbleId: string) => {
    const page = latest.current.pages?.find((p) => p.id === pageId);
    const bubble = page?.bubbles.find((b) => b.id === bubbleId);
    if (!bubble) return;
    setSelection({ pageId, bubbleId });
    setDraft({ ...bubble });
  }, []);

  const onGeometry = useCallback((pageId: string, bubbleId: string, box: Box, resized: boolean) => {
    void savePageBubbles(pageId, (bubbles) =>
      bubbles.map((b) => {
        if (b.id !== bubbleId) return b;
        const dx = box.x - b.x;
        const dy = box.y - b.y;
        const area = resized || !b.area ? undefined : { ...b.area, x: b.area.x + dx, y: b.area.y + dy };
        // The repaired artwork belongs to the old place.
        return { ...b, ...box, area, patch: undefined, patchBox: undefined };
      }),
    );
  }, []);

  const readBox = async (pageId: string, box: Box) => {
    const page = await getPage(pageId);
    const chapter = latest.current.chapter;
    if (!page || !chapter) return null;
    const bitmap = await decodeImage(page.blob);
    try {
      return await ocrRegion(bitmap, box, chapter.sourceLang, settings.minConfidence);
    } finally {
      bitmap.close();
    }
  };

  const onCreate = useCallback(
    async (pageId: string, box: Box) => {
      const chapter = latest.current.chapter;
      if (!chapter) return;
      setDrawing(false);
      const bubble: Bubble = { id: uid(), ...box, original: '', translation: '' };
      await savePageBubbles(pageId, (bubbles) => [...bubbles, bubble]);
      setBusyIds((ids) => [...ids, bubble.id]);
      setNotice(t('reader.reading'));
      let next: Bubble = { ...bubble };
      try {
        const res = await readBox(pageId, box);
        if (res) {
          next = { ...next, original: res.text, confidence: Math.round(res.confidence), vertical: res.vertical, fill: res.fill, fontSize: res.fontSize, color: res.color, rotation: res.rotation };
          const translated = await translateBubbles([next], chapter);
          next = translated.bubbles[0];
        } else {
          next = { ...next, fill: next.fill ?? '#ffffff', fontSize: Math.min(box.h * 0.4, 28) };
        }
        await savePageBubbles(pageId, (bubbles) => bubbles.map((b) => (b.id === next.id ? next : b)));
      } catch (err) {
        setNotice(t('error.generic', { message: (err as Error).message }));
      } finally {
        setBusyIds((ids) => ids.filter((x) => x !== bubble.id));
        setNotice((n) => (n === t('reader.reading') ? null : n));
      }
      setSelection({ pageId, bubbleId: next.id });
      setDraft(next);
    },
    [t, settings.minConfidence],
  );

  const onRetry = useCallback(
    (pageId: string) => {
      void startChapter(id, { pageIds: [pageId] });
    },
    [id],
  );

  const closeSheet = useCallback(() => {
    setDraft(null);
    setSelection(null);
  }, []);

  const saveDraft = useCallback(async () => {
    const { draft: d, selection: sel } = latest.current;
    if (!d || !sel) return;
    await savePageBubbles(sel.pageId, (bubbles) => bubbles.map((b) => (b.id === d.id ? d : b)));
    closeSheet();
  }, [closeSheet]);

  const deleteDraft = async () => {
    const sel = latest.current.selection;
    if (!sel) return;
    await savePageBubbles(sel.pageId, (bubbles) => bubbles.filter((b) => b.id !== sel.bubbleId));
    closeSheet();
  };

  const retranslateDraft = async () => {
    const { draft: d, chapter: c } = latest.current;
    if (!d || !c) return;
    setBusyIds((ids) => [...ids, d.id]);
    try {
      const res = await translateBubbles([{ ...d, edited: false }], c);
      setDraft((cur) => (cur && cur.id === d.id ? { ...cur, translation: res.bubbles[0].translation, edited: false } : cur));
    } catch (err) {
      setNotice(t('error.generic', { message: (err as Error).message }));
    } finally {
      setBusyIds((ids) => ids.filter((x) => x !== d.id));
    }
  };

  const reocrDraft = async () => {
    const { draft: d, selection: sel, chapter: c } = latest.current;
    if (!d || !sel || !c) return;
    setBusyIds((ids) => [...ids, d.id]);
    try {
      const res = await readBox(sel.pageId, d);
      if (res) {
        const updated = { ...d, original: res.text, confidence: Math.round(res.confidence), edited: false };
        const translated = await translateBubbles([updated], c);
        setDraft((cur) => (cur && cur.id === d.id ? translated.bubbles[0] : cur));
      }
    } catch (err) {
      setNotice(t('error.generic', { message: (err as Error).message }));
    } finally {
      setBusyIds((ids) => ids.filter((x) => x !== d.id));
    }
  };

  // --- chapter actions --------------------------------------------------------
  const [exporting, setExporting] = useState<string | null>(null);

  const [exportOpen, setExportOpen] = useState(false);

  const doExport = async (mode: ExportMode, format: ExportFormat) => {
    if (!chapter || !pages) return;
    setExportOpen(false);
    setExporting(t('reader.exporting', { done: 0, total: pages.length }));
    try {
      const result = await exportChapter(chapter, pages, {
        mode,
        format,
        onProgress: (done, total) => setExporting(t('reader.exporting', { done, total })),
      });
      setNotice(
        t('reader.exported', { size: formatBytes(result.size) }) +
          (result.untranslated > 0 ? ' ' + t('reader.exportPartial', { n: result.untranslated }) : ''),
      );
    } catch (err) {
      setNotice(t('error.generic', { message: (err as Error).message }));
    } finally {
      setExporting(null);
    }
  };

  const downloadCurrentPage = async () => {
    if (!chapter || !pages) return;
    setMenuOpen(false);
    const page = pages.find((p) => p.index === current) ?? pages[0];
    // In the Compare view the page is saved side by side too.
    const compare = mode === 'compare';
    const blob = await renderPage(page, chapter.targetLang, compare ? 'compare' : 'translated');
    downloadBlob(blob, `${safeName(chapter.title)}${compare ? ' (comparer)' : ''} - ${String(page.index + 1).padStart(3, '0')}.jpg`);
  };

  const retranslateAll = () => {
    setMenuOpen(false);
    if (!pages) return;
    void startChapter(id, { pageIds: pages.filter((p) => p.bubbles.length > 0).map((p) => p.id), translateOnly: true });
  };

  const proofreadAll = () => {
    setMenuOpen(false);
    if (!pages) return;
    void startChapter(id, { pageIds: pages.filter((p) => p.status === 'done' && p.bubbles.length > 0).map((p) => p.id), proofreadOnly: true });
  };

  const reanalyseAll = async () => {
    setMenuOpen(false);
    if (!pages || !window.confirm(t('reader.reanalyseConfirm'))) return;
    await stopChapter(id);
    for (const p of pages) await patchPage(p.id, { bubbles: [], status: 'pending', error: undefined });
    void startChapter(id, { pageIds: pages.map((p) => p.id) });
  };

  const removeChapter = async () => {
    setMenuOpen(false);
    if (!chapter || !window.confirm(t('library.confirmDelete', { title: chapter.title }))) return;
    cancelChapter(id);
    await deleteChapter(id);
    clearPosition(id);
    navigate('/');
  };

  const rename = async (next: string) => {
    setRenameOpen(false);
    const clean = next.trim();
    if (clean && clean !== chapter?.title) await patchChapter(id, { title: clean });
  };

  const applyLanguages = async (source: string, target: string) => {
    if (!chapter || !pages) return;
    setLangOpen(false);
    const sourceChanged = source !== chapter.sourceLang;
    await stopChapter(id);
    await patchChapter(id, { sourceLang: source, targetLang: target, autoSource: false });
    if (sourceChanged) {
      for (const p of pages) await patchPage(p.id, { bubbles: [], status: 'pending', error: undefined });
      void startChapter(id, { pageIds: pages.map((p) => p.id) });
    } else {
      void startChapter(id, { pageIds: pages.filter((p) => p.bubbles.length > 0).map((p) => p.id), translateOnly: true });
    }
  };

  if (chapter === null) {
    return (
      <div className="reader-missing">
        <p>{t('reader.notFound')}</p>
        <a className="btn" href="#/">
          {t('reader.back')}
        </a>
      </div>
    );
  }

  const pending = pages?.filter((p) => p.status !== 'done').length ?? 0;
  const running = job?.running ?? false;
  const phaseKey: Record<string, MessageKey> = {
    detect: 'reader.phase.detect',
    ocr: 'reader.phase.ocr',
    translate: 'reader.phase.translate',
    download: 'reader.phase.download',
  };
  const progress = running && job && job.total > 0 ? (job.done + job.failed) / job.total : 0;
  const hasStatus = running || (pending > 0 && Boolean(pages)) || exporting !== null || notice !== null || editing;
  // Anything the reader must see or is interacting with keeps the bar in place.
  const pinned = editing || menuOpen || langOpen || renameOpen || exportOpen || draft !== null || exporting !== null || attention;
  const hidden = barHidden && !pinned;
  // The page does not move under an open menu, dialog or bubble editor.
  const busy = editing || menuOpen || langOpen || renameOpen || exportOpen || draft !== null;
  useAutoScroll(auto === 'play' && !busy && Boolean(pages?.length), settings.scrollSpeed, () => setAuto('off'));
  const speed = clampSpeed(settings.scrollSpeed);

  // Next chapter: already in the library, or to import from the source website.
  const nextImport =
    chapter && !siblings.next
      ? (chapter.nextUrl ?? (chapter.origin && !isImageUrl(chapter.origin) ? guessNextUrl(chapter.origin) : null))
      : null;

  const renderPages = (showTranslation: boolean, interactive: boolean) =>
    pages?.map((p) => (
      <PageView
        key={p.id}
        page={p}
        url={urlFor(p)}
        showTranslation={showTranslation}
        interactive={interactive}
        editing={editing}
        drawing={drawing}
        opts={opts}
        fontsOk={fontsOk}
        draft={draft && selection?.pageId === p.id ? draft : null}
        selectedId={selection?.pageId === p.id ? selection.bubbleId : undefined}
        busyIds={busyIds.length && p.bubbles.some((b) => busyIds.includes(b.id)) ? busyIds : NO_BUSY}
        t={t}
        onSelect={onSelect}
        onGeometry={onGeometry}
        onCreate={onCreate}
        onRetry={onRetry}
        onTap={onTap}
      />
    ));

  return (
    <div className={`reader mode-${mode} ${editing ? 'editing' : ''}`}>
      <div className={`reader-top ${hidden ? 'hidden' : ''} ${running ? 'running' : ''}`}>
        <header className="reader-bar">
          <button className="icon-btn" onClick={() => navigate('/')} title={t('reader.back')} aria-label={t('reader.back')}>
            <Icon name="back" />
          </button>
          <div className="reader-title">
            {(() => {
              const ref = chapter ? seriesOf(chapter.title) : null;
              return ref && ref.key && ref.number !== null ? (
                <>
                  <small title={chapter?.title}>{ref.name}</small>
                  <strong>{t('library.series.chapter', { number: ref.number })}</strong>
                </>
              ) : (
                <strong title={chapter?.title}>{chapter?.title ?? '…'}</strong>
              );
            })()}
          </div>
          {!editing && (
            <button
              className={`icon-btn ${voiceOn ? 'on' : ''}`}
              aria-label={voiceOn ? t('reader.voice.close') : t('reader.voice.on')}
              aria-pressed={voiceOn}
              title={voiceOn ? t('reader.voice.close') : t('reader.voice.on')}
              onClick={() => (voiceOn ? setVoiceOn(false) : startVoice())}
              disabled={!pages?.length}
            >
              <Icon name="voice" size={20} />
            </button>
          )}
          <button
            className={`icon-btn ${editing ? 'on' : ''}`}
            aria-label={editing ? t('reader.editDone') : t('reader.edit')}
            aria-pressed={editing}
            title={editing ? t('reader.editDone') : t('reader.edit')}
            onClick={() => {
              setEditing((v) => !v);
              setDrawing(false);
              if (mode === 'original') setMode('translated');
            }}
          >
            <Icon name={editing ? 'check' : 'edit'} size={20} />
          </button>
          <div className="menu-wrap" ref={menuRef}>
            <button
              className="icon-btn"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={t('reader.menu')}
              aria-expanded={menuOpen}
              title={t('reader.menu')}
            >
              <Icon name="more" />
            </button>
            {menuOpen && (
              <div className="menu" role="menu">
                <button role="menuitem" onClick={() => (setMenuOpen(false), setExportOpen(true))} disabled={!pages?.length}>
                  <Icon name="download" size={16} /> {t('reader.export')}
                </button>
                <button role="menuitem" onClick={downloadCurrentPage} disabled={!pages?.length}>
                  <Icon name="image" size={16} /> {t('reader.downloadPage')}
                </button>
                <button role="menuitem" onClick={retranslateAll} disabled={running}>
                  <Icon name="refresh" size={16} /> {t('reader.retranslate')}
                </button>
                <button role="menuitem" onClick={proofreadAll} disabled={running}>
                  <Icon name="check" size={16} /> {t('reader.proofread')}
                </button>
                <button role="menuitem" onClick={reanalyseAll}>
                  <Icon name="sparkles" size={16} /> {t('reader.reanalyse')}
                </button>
                <button role="menuitem" onClick={() => (setMenuOpen(false), voiceOn ? setVoiceOn(false) : startVoice())} disabled={!pages?.length}>
                  <Icon name="voice" size={16} /> {voiceOn ? t('reader.voice.close') : t('reader.voice.on')}
                </button>
                <button role="menuitem" onClick={() => (setMenuOpen(false), setVoiceOn(false), setAuto(auto === 'off' ? 'play' : 'off'))} disabled={!pages?.length}>
                  <Icon name="scroll" size={16} /> {auto === 'off' ? t('reader.auto.on') : t('reader.auto.off')}
                </button>
                <button role="menuitem" onClick={() => (setMenuOpen(false), setLangOpen(true))}>
                  <Icon name="globe" size={16} /> {t('reader.languages')}
                </button>
                <button role="menuitem" onClick={() => (setMenuOpen(false), setRenameOpen(true))}>
                  <Icon name="edit" size={16} /> {t('reader.rename')}
                </button>
                <button role="menuitem" className="danger" onClick={removeChapter}>
                  <Icon name="trash" size={16} /> {t('reader.delete')}
                </button>
              </div>
            )}
          </div>
        </header>
        <div className="reader-modes">
          <div className="segmented" role="group">
            {(['translated', 'original', 'compare'] as const).map((m) => (
              <button key={m} className={mode === m ? 'active' : ''} aria-pressed={mode === m} onClick={() => setMode(m)}>
                {t(`reader.mode.${m}`)}
              </button>
            ))}
          </div>
          {chapter && (
            <button className="chip" onClick={() => setLangOpen(true)} title={t('reader.languages')}>
              <Icon name="globe" size={14} />
              {chapter.sourceLang === 'auto' ? '…' : chapter.sourceLang.toUpperCase().slice(0, 2)} → {chapter.targetLang.toUpperCase().slice(0, 2)}
            </button>
          )}
        </div>

        {hasStatus && (
          <div className="reader-status" role="status">
            {running && job && (
              <span>
                {job.total === 0
                  ? t('reader.queued')
                  : job.phase === 'detect'
                    ? t('reader.phase.detect')
                    : job.phase === 'download'
                      ? // Raw OCR engine messages ("loading tesseract core") mean nothing to a reader.
                        `${t('reader.phase.download')}${job.message?.match(/\d+%/) ? ` · ${job.message.match(/\d+%/)![0]}` : '…'}`
                      : t('reader.progress', {
                          page: (job.pageIndex ?? 0) + 1,
                          phase: t(phaseKey[job.phase] ?? 'reader.phase.ocr'),
                          done: job.done + job.failed,
                          total: job.total,
                        })}
              </span>
            )}
            {running && job?.phase !== 'download' && usesAi && <UsageMeter />}
            {running && (
              <button className="btn small ghost" onClick={() => cancelChapter(id)}>
                <Icon name="stop" size={14} /> {t('reader.cancel')}
              </button>
            )}
            {!running && pending > 0 && (
              <button className="btn small primary" onClick={() => void startChapter(id)}>
                <Icon name="refresh" size={14} /> {t('reader.resume')} ({pending})
              </button>
            )}
            {editing && (
              <button className={`btn small ${drawing ? 'primary' : ''}`} onClick={() => setDrawing((v) => !v)}>
                <Icon name="plus" size={14} /> {drawing ? t('reader.addHint') : t('reader.addBox')}
              </button>
            )}
            {exporting && <span>{exporting}</span>}
            {notice && (
              <span className="notice-inline">
                {notice}
                <button className="icon-btn" onClick={() => setNotice(null)} aria-label={t('common.close')}>
                  <Icon name="close" size={14} />
                </button>
              </span>
            )}
          </div>
        )}
        {running && <div className="progress" style={{ transform: `scaleX(${Math.max(0.02, progress)})` }} />}
      </div>

      <main className="pages">
        {!pages && <p className="muted center">{t('common.loading')}</p>}
        {mode === 'compare' ? (
          <div className="compare">
            <div className="col">{renderPages(false, false)}</div>
            <div className="col">{renderPages(true, true)}</div>
          </div>
        ) : (
          <div className="col">{renderPages(mode === 'translated', true)}</div>
        )}
        {chapter && pages && pages.length > 0 && !editing && (
          <footer className="chapter-end">
            <p className="chapter-end-label">{t('reader.end.title')}</p>
            <h2>{chapter.title}</h2>
            <div className="chapter-end-actions">
              {siblings.next && (
                <a className="btn primary big" href={`#/read/${encodeURIComponent(siblings.next.id)}`}>
                  <span className="stack">
                    <span>{t('reader.end.next')}</span>
                    <small>{siblings.next.title}</small>
                  </span>
                  <Icon name="forward" />
                </a>
              )}
              {nextImport && (
                <a
                  className="btn primary big"
                  href={`#/new?url=${encodeURIComponent(nextImport)}`}
                  onClick={(e) => {
                    // Like a reading app: straight to the next chapter, translated as it opens.
                    e.preventDefault();
                    void quickImport(nextImport);
                  }}
                >
                  <Icon name="download" />
                  <span className="stack">
                    <span>{t('reader.end.import')}</span>
                    <small>{shortUrl(nextImport)}</small>
                  </span>
                </a>
              )}
              {siblings.previous && (
                <a className="btn ghost" href={`#/read/${encodeURIComponent(siblings.previous.id)}`}>
                  <Icon name="back" size={16} />
                  <span className="stack">
                    <span>{t('reader.end.previous')}</span>
                    <small>{siblings.previous.title}</small>
                  </span>
                </a>
              )}
              <a className="btn ghost" href="#/">
                <Icon name="library" size={16} /> {t('reader.back')}
              </a>
            </div>
            <p className="muted small">{t('reader.tapHint')}</p>
          </footer>
        )}
      </main>

      {pages && pages.length > 1 && !editing && !draft && (
        <div className={`reader-pos ${hidden ? 'hidden' : ''}`} aria-hidden="true">
          {Math.min(current, pages.length - 1) + 1} / {pages.length}
        </div>
      )}

      {pages && pages.length > 0 && !editing && !draft && !voiceOn && auto === 'off' && (
        <div className={`reader-jump ${hidden ? 'hidden' : ''}`} role="group">
          <button
            className="icon-btn"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            aria-label={t('reader.toTop')}
            title={t('reader.toTop')}
            tabIndex={hidden ? -1 : 0}
          >
            <Icon name="toTop" size={20} />
          </button>
          <button
            className="icon-btn"
            onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })}
            aria-label={t('reader.toBottom')}
            title={t('reader.toBottom')}
            tabIndex={hidden ? -1 : 0}
          >
            <Icon name="toBottom" size={20} />
          </button>
        </div>
      )}

      {auto !== 'off' && !editing && !draft && (
        <div className={`auto-bar ${auto === 'play' ? 'playing' : ''}`} role="group" aria-label={t('reader.auto.on')}>
          <button className="icon-btn" onClick={() => changeSpeed(-1)} disabled={speed <= 1} aria-label={t('reader.auto.slower')} title={t('reader.auto.slower')}>
            <Icon name="minus" size={18} />
          </button>
          <span className="auto-speed" aria-live="polite" aria-label={t('reader.auto.speed', { level: speed })}>
            {speed}
          </span>
          <button className="icon-btn" onClick={() => changeSpeed(1)} disabled={speed >= SPEED_LEVELS} aria-label={t('reader.auto.faster')} title={t('reader.auto.faster')}>
            <Icon name="plus" size={18} />
          </button>
          <button
            className="icon-btn main"
            onClick={() => setAuto(auto === 'play' ? 'pause' : 'play')}
            aria-label={auto === 'play' ? t('reader.auto.pause') : t('reader.auto.play')}
            title={auto === 'play' ? t('reader.auto.pause') : t('reader.auto.play')}
          >
            <Icon name={auto === 'play' ? 'pause' : 'play'} size={18} />
          </button>
          <button className="icon-btn" onClick={() => setAuto('off')} aria-label={t('reader.auto.close')} title={t('reader.auto.close')}>
            <Icon name="close" size={18} />
          </button>
        </div>
      )}

      {voiceOn && chapter && pages && !editing && !draft && <ReadAloud chapter={chapter} pages={pages} onClose={() => setVoiceOn(false)} />}

      {draft && selection && (
        <BubbleSheet
          draft={draft}
          busy={busyIds.includes(draft.id)}
          t={t}
          onChange={setDraft}
          onSave={saveDraft}
          onCancel={closeSheet}
          onDelete={deleteDraft}
          onRetranslate={retranslateDraft}
          onReocr={reocrDraft}
        />
      )}

      {langOpen && chapter && <LanguageDialog source={chapter.sourceLang} target={chapter.targetLang} onApply={applyLanguages} onClose={() => setLangOpen(false)} />}
      {exportOpen && (
        <ExportDialog
          pageCount={pages?.length ?? 0}
          initialMode={mode === 'compare' ? 'compare' : 'translated'}
          onExport={(m, f) => void doExport(m, f)}
          onClose={() => setExportOpen(false)}
        />
      )}
      {renameOpen && chapter && <RenameDialog title={chapter.title} onSave={rename} onClose={() => setRenameOpen(false)} />}
    </div>
  );
}

/** "https://site.example/series/chapter-13/" → "site.example/…/chapter-13". */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = decodeURIComponent(parts.at(-1) ?? '');
    return `${u.hostname.replace(/^www\./, '')}${parts.length > 1 ? '/…/' : '/'}${last}${u.search}`.slice(0, 60);
  } catch {
    return url.slice(0, 60);
  }
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useDismiss<HTMLDivElement>(true, onClose);
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function ExportDialog({
  pageCount,
  initialMode,
  onExport,
  onClose,
}: {
  pageCount: number;
  initialMode: ExportMode;
  onExport: (mode: ExportMode, format: ExportFormat) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [exportMode, setExportMode] = useState<ExportMode>(initialMode);
  const [format, setFormat] = useState<ExportFormat>('images');
  return (
    <Modal title={t('export.title')} onClose={onClose}>
      <fieldset className="choices">
        <legend>{t('export.content')}</legend>
        {(['translated', 'compare'] as const).map((m) => (
          <label key={m} className={`choice ${exportMode === m ? 'active' : ''}`}>
            <input type="radio" name="export-mode" checked={exportMode === m} onChange={() => setExportMode(m)} />
            <span>
              <strong>{t(`export.mode.${m}`)}</strong>
              <small>{t(`export.mode.${m}.desc`)}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="choices">
        <legend>{t('export.format')}</legend>
        {(['images', 'cbz'] as const).map((f) => (
          <label key={f} className={`choice ${format === f ? 'active' : ''}`}>
            <input type="radio" name="export-format" checked={format === f} onChange={() => setFormat(f)} />
            <span>
              <strong>{t(`export.format.${f}`, { n: pageCount })}</strong>
              <small>{t(isNativeApp() ? `export.format.${f}.app` : `export.format.${f}.desc`)}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="sheet-actions">
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className="btn primary" onClick={() => onExport(exportMode, format)}>
          <Icon name="download" size={16} /> {t('export.go')}
        </button>
      </div>
    </Modal>
  );
}

function RenameDialog({ title, onSave, onClose }: { title: string; onSave: (title: string) => void; onClose: () => void }) {
  const t = useT();
  const [value, setValue] = useState(title);
  return (
    <Modal title={t('reader.rename')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(value);
        }}
      >
        <label className="field">
          <span>{t('new.chapterTitle')}</span>
          <input value={value} autoFocus maxLength={120} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
        </label>
        <div className="sheet-actions">
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!value.trim()}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function LanguageDialog({
  source,
  target,
  onApply,
  onClose,
}: {
  source: string;
  target: string;
  onApply: (source: string, target: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [s, setS] = useState(source);
  const [tg, setTg] = useState(target);
  return (
    <Modal title={t('reader.languages')} onClose={onClose}>
      <label className="field">
        <span>{t('common.from')}</span>
        <LangSelect kind="source" value={s} onChange={setS} />
      </label>
      <label className="field">
        <span>{t('common.to')}</span>
        <LangSelect kind="target" value={tg} onChange={setTg} />
      </label>
      <div className="sheet-actions">
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className="btn primary" onClick={() => onApply(s, tg)} disabled={s === source && tg === target}>
          {t('reader.applyLanguages')}
        </button>
      </div>
    </Modal>
  );
}
