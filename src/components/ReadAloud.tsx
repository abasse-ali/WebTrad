import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { MessageKey } from '../i18n';
import { useT } from '../i18n';
import { castOf, isNarrator, resetVoices, updateMember } from '../lib/cast';
import { logInfo } from '../lib/log';
import { isRunning } from '../lib/pipeline';
import { getSettings, updateSettings, useSettings } from '../lib/settings';
import { ensureSpeakers, needsSpeakers, readable } from '../lib/speakers';
import type { Bubble, Chapter, Page } from '../lib/types';
import {
  loadVoices,
  prosody,
  speak,
  speakerOfBubble,
  speechAvailable,
  spokenText,
  stopSpeaking,
  unlockSpeech,
  voiceForSpeaker,
  voicesFor,
  type VoiceInfo,
} from '../lib/voices';
import { Icon } from './Icon';

/** Rates of the voices offered by the − and + buttons. */
const RATES = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];
/** Silence between two bubbles (ms). */
const GAP_MS = 280;
/** How long a page without text stays at the reading place before the next one. */
const PICTURE_MS = 1500;

type Position = { page: number; item: number };

/** A colour of its own for each character (the chip in the bar, the frame on the page). */
function hueOf(key: string): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/**
 * Reading aloud: the bubbles are said in reading order, each with the voice
 * of its character, the page following the voice and the bubble said
 * outlined. Pages read before voices existed have their characters found
 * by the AI first (once).
 */
export function ReadAloud({ chapter, pages, onClose }: { chapter: Chapter; pages: Page[]; onClose: () => void }) {
  const t = useT();
  const settings = useSettings();
  const [state, setState] = useState<'play' | 'pause'>('play');
  const [now, setNow] = useState<{ page: Page; bubble: Bubble; key: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [castOpen, setCastOpen] = useState(false);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  // The chapter and texts change while reading (pages saved, characters
  // found): reading goes on, it is not started again for that.
  const chapterRef = useRef(chapter);
  chapterRef.current = chapter;
  const tRef = useRef(t);
  tRef.current = t;
  const pos = useRef<Position | null>(null);
  const run = useRef<AbortController | null>(null);
  const voices = useRef<VoiceInfo[]>([]);
  const mark = useRef<HTMLDivElement>(null);

  /** The first bubble on screen (or below it), where reading starts. */
  const fromScreen = useCallback((): Position => {
    const list = pagesRef.current;
    for (const [i, p] of list.entries()) {
      const r = document.getElementById(`page-${p.index}`)?.getBoundingClientRect();
      if (!r || r.bottom <= 0) continue;
      const k = r.height / p.height;
      const items = readable(p.bubbles, chapter.layout);
      const item = items.findIndex((b) => r.top + (b.y + b.h) * k > 40);
      if (item >= 0) return { page: i, item };
      if (r.top >= 0) return { page: i, item: 0 };
    }
    return { page: 0, item: 0 };
  }, []);

  const onScreen = (p: Page, b: Bubble) => {
    const r = document.getElementById(`page-${p.index}`)?.getBoundingClientRect();
    if (!r) return false;
    const k = r.height / p.height;
    const top = r.top + b.y * k;
    return top + b.h * k > 0 && top < window.innerHeight;
  };

  /** A page without a bubble to read: its middle at the reading place. */
  const showPage = (p: Page) => {
    const r = document.getElementById(`page-${p.index}`)?.getBoundingClientRect();
    if (!r) return;
    setNow(null);
    window.scrollTo({ top: window.scrollY + r.top + r.height / 2 - window.innerHeight * 0.42, behavior: 'smooth' });
  };

  const scrollTo = (p: Page, b: Bubble) => {
    const r = document.getElementById(`page-${p.index}`)?.getBoundingClientRect();
    if (!r) return;
    const k = r.height / p.height;
    const cy = r.top + (b.y + b.h / 2) * k;
    window.scrollTo({ top: window.scrollY + cy - window.innerHeight * 0.42, behavior: 'smooth' });
  };

  const play = useCallback(async () => {
    run.current?.abort();
    const ctrl = new AbortController();
    run.current = ctrl;
    const { signal } = ctrl;
    const chapter = chapterRef.current;
    const t = tRef.current;
    if (voices.current.length === 0) {
      voices.current = voicesFor(await loadVoices(), chapter.targetLang);
      logInfo('voix', `Lecture à voix haute : ${voices.current.length} voix pour « ${chapter.targetLang} »`, {
        voix: voices.current.map((v) => `${v.voice.name}${v.gender ? ` (${v.gender === 'female' ? 'F' : 'H'})` : ''}`).join(', ').slice(0, 300),
      });
    }
    if (signal.aborted) return;
    let { page, item } = pos.current ?? fromScreen();
    while (page < pagesRef.current.length) {
      let p = pagesRef.current[page];
      // A page still being translated: its turn comes once it is done. Not
      // when nothing translates it (the chapter stopped): reading went no
      // further, waiting for it forever.
      let shown = false;
      while (p.status !== 'done' && p.status !== 'error' && isRunning(chapter.id)) {
        setStatus(t('reader.voice.waiting', { page: p.index + 1 }));
        // The page waited for is on screen.
        if (!shown) {
          shown = true;
          showPage(p);
        }
        await new Promise((r) => setTimeout(r, 1000));
        if (signal.aborted) return;
        p = pagesRef.current[page];
      }
      if (needsSpeakers(p)) {
        setStatus(t('reader.voice.cast'));
        try {
          p = await ensureSpeakers(p, chapter, signal);
        } catch {
          if (signal.aborted) return;
        }
      }
      setStatus(null);
      if (signal.aborted) return;
      // The characters of the next page are found while this one is read.
      const next = pagesRef.current[page + 1];
      if (next && next.status === 'done' && needsSpeakers(next)) void ensureSpeakers(next, chapter).catch(() => undefined);
      const items = readable(p.bubbles, chapter.layout);
      // A page without text: shown for a moment as the reading goes on to
      // the next one (it stayed on the last bubble read, as if stuck).
      if (items.length === 0 && p.status === 'done') {
        pos.current = { page, item: 0 };
        showPage(p);
        await new Promise((r) => setTimeout(r, PICTURE_MS));
        if (signal.aborted) return;
      }
      for (; item < items.length; item++) {
        pos.current = { page, item };
        const b = items[item];
        const key = speakerOfBubble(b);
        setNow({ page: p, bubble: b, key });
        scrollTo(p, b);
        const text = spokenText(b.translation);
        const pick = voiceForSpeaker(chapter.title, key, b.gender, voices.current, b.speaker);
        await speak(text, chapter.targetLang, prosody(text, b.kind, pick), getSettings().voiceRate, signal);
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, GAP_MS));
        if (signal.aborted) return;
      }
      page++;
      item = 0;
    }
    // The end of the chapter.
    pos.current = null;
    setNow(null);
    setState('pause');
    setStatus(t('reader.voice.end'));
  }, [fromScreen]);

  // Starts on mount (the tap that opened it unlocked the speech), stops on unmount.
  useEffect(() => {
    if (state === 'play') void play();
    else {
      run.current?.abort();
      stopSpeaking();
    }
  }, [state, play]);
  useEffect(
    () => () => {
      run.current?.abort();
      stopSpeaking();
    },
    [],
  );

  // The frame around the bubble said, kept on it while the page moves.
  useEffect(() => {
    if (!now) return;
    let frame = 0;
    const place = () => {
      frame = requestAnimationFrame(place);
      const el = mark.current;
      const r = document.getElementById(`page-${now.page.index}`)?.getBoundingClientRect();
      if (!el || !r) return;
      const k = r.width / now.page.width;
      const box = now.bubble.area ?? now.bubble;
      const pad = 8;
      el.style.transform = `translate(${r.left + box.x * k - pad}px, ${r.top + box.y * k - pad}px)`;
      el.style.width = `${box.w * k + pad * 2}px`;
      el.style.height = `${box.h * k + pad * 2}px`;
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [now]);

  const toggle = () => {
    if (state === 'play') return setState('pause');
    unlockSpeech();
    setStatus(null);
    // Scrolled away while paused: reading goes on from what is on screen.
    const p = pos.current ? pagesRef.current[pos.current.page] : undefined;
    const b = p && pos.current ? readable(p.bubbles, chapter.layout)[pos.current.item] : undefined;
    if (!p || !b || !onScreen(p, b)) pos.current = fromScreen();
    setState('play');
  };

  const step = (by: number) => {
    unlockSpeech();
    const cur = pos.current ?? fromScreen();
    let { page, item } = { page: cur.page, item: cur.item + by };
    const list = pagesRef.current;
    while (page >= 0 && page < list.length) {
      const n = readable(list[page].bubbles, chapter.layout).length;
      if (item < 0) {
        page--;
        if (page >= 0) item = readable(list[page].bubbles, chapter.layout).length - 1;
        continue;
      }
      if (item >= n) {
        page++;
        item = 0;
        continue;
      }
      break;
    }
    if (page < 0) pos.current = { page: 0, item: 0 };
    else if (page >= list.length) return;
    else pos.current = { page, item };
    if (state === 'play') void play();
    else setState('play');
  };

  const rate = settings.voiceRate;
  const rateIndex = RATES.reduce((best, r, i) => (Math.abs(r - rate) < Math.abs(RATES[best] - rate) ? i : best), 3);
  const changeRate = (by: number) => updateSettings({ voiceRate: RATES[Math.min(RATES.length - 1, Math.max(0, rateIndex + by))] });

  const who = now
    ? now.key && !now.key.startsWith('?')
      ? now.bubble.speaker!
      : now.key === '?female'
        ? t('reader.voice.woman')
        : now.key === '?male'
          ? t('reader.voice.man')
          : t('reader.voice.narrator')
    : null;
  const hue = now ? hueOf(now.key) : 0;

  if (!speechAvailable()) {
    return (
      <div className="auto-bar voice-bar" role="group">
        <span className="voice-who">{t('reader.voice.none')}</span>
        <button className="icon-btn" onClick={onClose} aria-label={t('reader.voice.close')}>
          <Icon name="close" size={18} />
        </button>
      </div>
    );
  }

  return (
    <>
      {now && state === 'play' && <div ref={mark} className="voice-mark" style={{ '--hue': hue } as CSSProperties} aria-hidden="true" />}
      <div className="voice-panel">
        {(status || who) && (
          <button className="voice-who" style={{ '--hue': hue } as CSSProperties} onClick={() => setCastOpen(true)} title={t('reader.voice.cast.title')}>
            {status ?? (
              <>
                <span className="voice-dot" /> {who}
              </>
            )}
          </button>
        )}
        <div className={`auto-bar voice-bar ${state === 'play' ? 'playing' : ''}`} role="group" aria-label={t('reader.voice.on')}>
          <button className="icon-btn" onClick={() => changeRate(-1)} disabled={rateIndex <= 0} aria-label={t('reader.auto.slower')} title={t('reader.auto.slower')}>
            <Icon name="minus" size={18} />
          </button>
          <span className="auto-speed" aria-label={t('reader.voice.speed', { rate: RATES[rateIndex] })}>
            ×{RATES[rateIndex]}
          </span>
          <button className="icon-btn" onClick={() => changeRate(1)} disabled={rateIndex >= RATES.length - 1} aria-label={t('reader.auto.faster')} title={t('reader.auto.faster')}>
            <Icon name="plus" size={18} />
          </button>
          <button className="icon-btn" onClick={() => step(-1)} aria-label={t('reader.voice.prev')} title={t('reader.voice.prev')}>
            <Icon name="back" size={18} />
          </button>
          <button className="icon-btn main" onClick={toggle} aria-label={state === 'play' ? t('reader.auto.pause') : t('reader.voice.play')} title={state === 'play' ? t('reader.auto.pause') : t('reader.voice.play')}>
            <Icon name={state === 'play' ? 'pause' : 'play'} size={18} />
          </button>
          <button className="icon-btn" onClick={() => step(1)} aria-label={t('reader.voice.next')} title={t('reader.voice.next')}>
            <Icon name="forward" size={18} />
          </button>
          <button className="icon-btn" onClick={() => setCastOpen(true)} aria-label={t('reader.voice.cast.title')} title={t('reader.voice.cast.title')}>
            <Icon name="users" size={18} />
          </button>
          <button className="icon-btn" onClick={onClose} aria-label={t('reader.voice.close')} title={t('reader.voice.close')}>
            <Icon name="close" size={18} />
          </button>
        </div>
      </div>
      {castOpen && (
        <CastDialog
          chapter={chapter}
          voices={voices.current}
          onClose={() => setCastOpen(false)}
          onPause={() => setState('pause')}
          t={t}
        />
      )}
    </>
  );
}

/**
 * The characters of the series and their voices: each can be given another
 * voice, a higher or lower pitch, or another gender, and heard at once.
 */
function CastDialog({
  chapter,
  voices: initial,
  onClose,
  onPause,
  t,
}: {
  chapter: Chapter;
  voices: VoiceInfo[];
  onClose: () => void;
  onPause: () => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  const [voices, setVoices] = useState(initial);
  const [cast, setCast] = useState(() => castOf(chapter.title));
  const refresh = () => setCast(castOf(chapter.title));
  useEffect(() => {
    onPause();
    if (initial.length === 0) void loadVoices().then((all) => setVoices(voicesFor(all, chapter.targetLang)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const hear = (key: string, gender: 'male' | 'female' | undefined, label: string) => {
    unlockSpeech();
    stopSpeaking();
    const pick = voiceForSpeaker(chapter.title, key, gender, voices);
    refresh();
    const sample = t('reader.voice.sample', { name: label });
    void speak(sample, chapter.targetLang, pick, getSettings().voiceRate, new AbortController().signal);
  };
  const genderLabel = (g?: string) => (g === 'female' ? 'F' : g === 'male' ? 'H' : '?');
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal cast-dialog" role="dialog" aria-modal="true" aria-label={t('reader.voice.cast.title')} onClick={(e) => e.stopPropagation()}>
        <h2>{t('reader.voice.cast.title')}</h2>
        {cast.length === 0 ? (
          <p className="muted">{t('reader.voice.cast.empty')}</p>
        ) : (
          <ul className="cast-list">
            {cast
              .filter((m) => !isNarrator(m.label))
              .map((m) => (
                <li key={m.key} style={{ '--hue': hueOf(m.key) } as CSSProperties}>
                  <span className="voice-dot" />
                  <span className="cast-name" title={m.label}>
                    {m.label}
                  </span>
                  <button
                    className="chip"
                    title={t('reader.voice.cast.gender')}
                    onClick={() => {
                      const next = m.gender === 'female' ? 'male' : m.gender === 'male' ? undefined : 'female';
                      updateMember(chapter.title, m.key, { gender: next, voice: undefined, pitch: undefined });
                      refresh();
                    }}
                  >
                    {genderLabel(m.gender)}
                  </button>
                  <select
                    value={m.voice ?? ''}
                    aria-label={t('reader.voice.cast.voice')}
                    onChange={(e) => {
                      updateMember(chapter.title, m.key, { voice: e.target.value || undefined, pitch: m.pitch ?? 1 });
                      refresh();
                    }}
                  >
                    <option value="">{t('reader.voice.cast.auto')}</option>
                    {voices.map((v) => (
                      <option key={v.voice.name} value={v.voice.name}>
                        {v.voice.name.replace(/\s*\(.*\)\s*$/, '')}
                        {v.gender ? ` (${genderLabel(v.gender)})` : ''}
                      </option>
                    ))}
                  </select>
                  <input
                    type="range"
                    min={0.6}
                    max={1.5}
                    step={0.05}
                    value={m.pitch ?? 1}
                    aria-label={t('reader.voice.cast.pitch')}
                    onChange={(e) => {
                      updateMember(chapter.title, m.key, { pitch: Number(e.target.value), voice: m.voice ?? voiceForSpeaker(chapter.title, m.key, m.gender, voices).voice?.name });
                      refresh();
                    }}
                  />
                  <button className="icon-btn" onClick={() => hear(m.key, m.gender, m.label)} aria-label={t('reader.voice.cast.hear')} title={t('reader.voice.cast.hear')}>
                    <Icon name="voice" size={16} />
                  </button>
                </li>
              ))}
          </ul>
        )}
        <p className="muted small">{t('reader.voice.cast.hint')}</p>
        <div className="sheet-actions">
          <button
            className="btn ghost"
            onClick={() => {
              resetVoices(chapter.title);
              refresh();
            }}
          >
            <Icon name="refresh" size={16} /> {t('reader.voice.cast.reset')}
          </button>
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

