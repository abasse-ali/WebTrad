import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT, type MessageKey } from '../i18n';
import { useChapter } from '../hooks';
import { deleteChapter, getPage, patchChapter, patchPage, uid } from '../lib/db';
import { downloadBlob, exportChapter, fontsReady, renderPage, safeName } from '../lib/exporter';
import { clearLayoutCache, type LayoutOptions } from '../lib/layout';
import { ocrRegion } from '../lib/ocr';
import { cancelChapter, startChapter, stopChapter, translateBubbles, useJob } from '../lib/pipeline';
import { useSettings } from '../lib/settings';
import type { Box } from '../lib/text';
import type { Bubble, Page, ReaderMode } from '../lib/types';
import { displayName } from '../lib/languages';
import { navigate } from '../router';
import { BubbleSheet } from './BubbleSheet';
import { Icon } from './Icon';
import { LangSelect } from './LangSelect';
import { PageView } from './PageView';

const NO_BUSY: string[] = [];
const POS_KEY = (id: string) => `webtrad.pos.${id}`;

export function Reader({ id }: { id: string }) {
  const t = useT();
  const settings = useSettings();
  const { chapter, pages } = useChapter(id);
  const job = useJob(id);
  const [mode, setMode] = useState<ReaderMode>('translated');
  const [editing, setEditing] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [selection, setSelection] = useState<{ pageId: string; bubbleId: string } | null>(null);
  const [draft, setDraft] = useState<Bubble | null>(null);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
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
    () => ({ font: settings.font, uppercase: settings.uppercase, target: chapter?.targetLang ?? settings.targetLang }),
    [settings.font, settings.uppercase, chapter?.targetLang, settings.targetLang],
  );

  // --- reading position ------------------------------------------------------
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !pages || pages.length === 0) return;
    restored.current = true;
    const saved = Number(localStorage.getItem(POS_KEY(id)) ?? 0);
    if (saved > 0) requestAnimationFrame(() => document.getElementById(`page-${saved}`)?.scrollIntoView());
  }, [pages, id]);
  useEffect(() => {
    let timer = 0;
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const list = latest.current.pages ?? [];
        const current = list.find((p) => {
          const el = document.getElementById(`page-${p.index}`);
          return el && el.getBoundingClientRect().bottom > 120;
        });
        try {
          if (current) localStorage.setItem(POS_KEY(id), String(current.index));
        } catch {
          /* ignore */
        }
      }, 300);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [id]);

  // Keyboard: O toggles original, E toggles edit mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'o') setMode((m) => (m === 'original' ? 'translated' : 'original'));
      if (e.key === 'e') setEditing((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
        return { ...b, ...box, area };
      }),
    );
  }, []);

  const readBox = async (pageId: string, box: Box) => {
    const page = await getPage(pageId);
    const chapter = latest.current.chapter;
    if (!page || !chapter) return null;
    const bitmap = await createImageBitmap(page.blob);
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
          next = { ...next, original: res.text, confidence: Math.round(res.confidence), vertical: res.vertical, fill: res.fill, fontSize: res.fontSize };
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

  const doExport = async () => {
    if (!chapter || !pages) return;
    setMenuOpen(false);
    setExporting(t('reader.exporting', { done: 0, total: pages.length }));
    try {
      await exportChapter(chapter, pages, (done, total) => setExporting(t('reader.exporting', { done, total })));
    } catch (err) {
      setNotice(t('error.generic', { message: (err as Error).message }));
    } finally {
      setExporting(null);
    }
  };

  const downloadCurrentPage = async () => {
    if (!chapter || !pages) return;
    setMenuOpen(false);
    const index = Number(localStorage.getItem(POS_KEY(id)) ?? 0);
    const page = pages.find((p) => p.index === index) ?? pages[0];
    const blob = await renderPage(page, chapter.targetLang);
    downloadBlob(blob, `${safeName(chapter.title)} - ${String(page.index + 1).padStart(3, '0')}.jpg`);
  };

  const retranslateAll = () => {
    setMenuOpen(false);
    if (!pages) return;
    void startChapter(id, { pageIds: pages.filter((p) => p.bubbles.length > 0).map((p) => p.id), translateOnly: true });
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
    navigate('/');
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
      />
    ));

  return (
    <div className={`reader mode-${mode} ${editing ? 'editing' : ''}`}>
      <header className="reader-bar">
        <button className="icon-btn" onClick={() => navigate('/')} title={t('reader.back')} aria-label={t('reader.back')}>
          <Icon name="back" />
        </button>
        <div className="reader-title">
          <strong title={chapter?.title}>{chapter?.title ?? '…'}</strong>
          {chapter && (
            <button className="link small" onClick={() => setLangOpen(true)}>
              {chapter.sourceLang === 'auto' ? t('lang.detecting') : displayName(chapter.sourceLang, settings.uiLang)}
              {chapter.autoSource ? ` (${t('lang.autoShort')})` : ''} → {displayName(chapter.targetLang, settings.uiLang)}
            </button>
          )}
        </div>
        <div className="segmented" role="group">
          {(['translated', 'original', 'compare'] as const).map((m) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
              {t(`reader.mode.${m}`)}
            </button>
          ))}
        </div>
        <button
          className={`btn small ${editing ? 'primary' : 'ghost'}`}
          onClick={() => {
            setEditing((v) => !v);
            setDrawing(false);
            if (mode === 'original') setMode('translated');
          }}
        >
          <Icon name={editing ? 'check' : 'edit'} size={16} />
          <span className="hide-sm">{editing ? t('reader.editDone') : t('reader.edit')}</span>
        </button>
        <div className="menu-wrap">
          <button className="icon-btn" onClick={() => setMenuOpen((v) => !v)} aria-label={t('reader.menu')} title={t('reader.menu')}>
            <Icon name="more" />
          </button>
          {menuOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="menu" role="menu">
                <button role="menuitem" onClick={doExport} disabled={!pages?.length}>
                  <Icon name="download" size={16} /> {t('reader.export')}
                </button>
                <button role="menuitem" onClick={downloadCurrentPage} disabled={!pages?.length}>
                  <Icon name="image" size={16} /> {t('reader.downloadPage')}
                </button>
                <button role="menuitem" onClick={retranslateAll} disabled={running}>
                  <Icon name="refresh" size={16} /> {t('reader.retranslate')}
                </button>
                <button role="menuitem" onClick={reanalyseAll}>
                  <Icon name="sparkles" size={16} /> {t('reader.reanalyse')}
                </button>
                <button role="menuitem" onClick={() => (setMenuOpen(false), setLangOpen(true))}>
                  <Icon name="globe" size={16} /> {t('reader.languages')}
                </button>
                <button role="menuitem" className="danger" onClick={removeChapter}>
                  <Icon name="trash" size={16} /> {t('reader.delete')}
                </button>
              </div>
            </>
          )}
        </div>
        {running && <div className="progress" style={{ transform: `scaleX(${Math.max(0.02, progress)})` }} />}
      </header>

      {(running || (pending > 0 && pages) || exporting || notice || editing) && (
        <div className="reader-status">
          {running && job && (
            <span>
              {job.total === 0
                ? t('reader.queued')
                : job.phase === 'detect'
                  ? t('reader.phase.detect')
                  : job.phase === 'download' && job.message
                  ? `${t('reader.phase.download')} · ${job.message}`
                  : t('reader.progress', {
                      page: (job.pageIndex ?? 0) + 1,
                      phase: t(phaseKey[job.phase] ?? 'reader.phase.ocr'),
                      done: job.done + job.failed,
                      total: job.total,
                    })}
            </span>
          )}
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
        {pages && pages.length > 0 && !editing && <p className="muted center small hint">{t('reader.tapHint')}</p>}
      </main>

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
    </div>
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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>{t('reader.languages')}</h2>
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
      </div>
    </div>
  );
}
