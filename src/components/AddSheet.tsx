import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { createChapter, filesToImages, guessTitle, type ImportedImage } from '../lib/importers';
import { isNativeApp, readClipboard } from '../lib/native';
import { startChapter } from '../lib/pipeline';
import { quickImport } from '../lib/quick';
import { getSettings, updateSettings } from '../lib/settings';
import { warmUpTranslator } from '../lib/translate';
import type { ComicLayout } from '../lib/types';
import { navigate } from '../router';
import { Icon } from './Icon';
import { LangSelect } from './LangSelect';

export type AddTab = 'url' | 'images' | 'file';

const LAYOUT_KEY = 'webtrad.lastLayout';

function lastLayout(): ComicLayout | null {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v === 'webtoon' || v === 'manga' || v === 'comic' ? v : null;
  } catch {
    return null;
  }
}

/** A dimmed screen with a card on it: closed by its cross or by a tap outside. */
export function Modal({ label, onClose, children, className = '' }: { label: string; onClose: () => void; children: React.ReactNode; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    // The page behind does not scroll under the finger.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal-card ${className}`} role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function ModalHead({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose: () => void }) {
  const t = useT();
  return (
    <div className="modal-head">
      <div>
        <h2>{title}</h2>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      <button className="round-btn" onClick={onClose} aria-label={t('common.close')}>
        <Icon name="close" size={20} />
      </button>
    </div>
  );
}

/** Where to find a chapter to translate, and how to bring it here. */
export function HelpSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Modal label={t('add.help.title')} onClose={onClose}>
      <ModalHead title={t('add.help.title')} onClose={onClose} />
      <ol className="help-steps">
        {(['add.help.1', 'add.help.2', 'add.help.3'] as const).map((k, i) => (
          <li key={k}>
            <span className="step-num">{i + 1}</span>
            <span>{t(k)}</span>
          </li>
        ))}
      </ol>
      <p className="muted small">{t('add.help.note')}</p>
      <button className="btn primary big wide" onClick={onClose}>
        {t('common.close')}
      </button>
    </Modal>
  );
}

/** Small drawings of the three layouts. */
function LayoutArt({ layout }: { layout: ComicLayout }) {
  if (layout === 'webtoon')
    return (
      <svg viewBox="0 0 48 64" aria-hidden="true">
        <rect x="10" y="2" width="28" height="60" rx="3" className="art-page" />
        <rect x="13" y="6" width="22" height="16" rx="2" className="art-panel" />
        <ellipse cx="24" cy="30" rx="9" ry="5" className="art-bubble" />
        <rect x="13" y="38" width="22" height="20" rx="2" className="art-panel" />
      </svg>
    );
  const arrow = layout === 'manga' ? 'M34 58 L14 58 M18 54 L14 58 L18 62' : 'M14 58 L34 58 M30 54 L34 58 L30 62';
  return (
    <svg viewBox="0 0 48 64" aria-hidden="true">
      <rect x="4" y="2" width="40" height="50" rx="3" className="art-page" />
      <rect x="7" y="5" width="16" height="20" rx="1.5" className="art-panel" />
      <rect x="25" y="5" width="16" height="20" rx="1.5" className="art-panel" />
      <rect x="7" y="27" width="34" height="22" rx="1.5" className="art-panel" />
      <ellipse cx={layout === 'manga' ? 33 : 15} cy="13" rx="6" ry="4" className="art-bubble" />
      <path d={arrow} className="art-arrow" />
    </svg>
  );
}

/**
 * "Add a comic": a link, images or a CBZ/ZIP file, its title and the
 * language to translate into; then its layout. The chapter opens at once,
 * translated as it is read.
 */
export function AddSheet({ initialTab = 'url', onClose }: { initialTab?: AddTab; onClose: () => void }) {
  const t = useT();
  const settings = getSettings();
  const [step, setStep] = useState<1 | 2>(1);
  const [tab, setTab] = useState<AddTab>(initialTab);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [target, setTarget] = useState(settings.targetLang);
  const [images, setImages] = useState<ImportedImage[]>([]);
  const [fileName, setFileName] = useState('');
  const [layout, setLayout] = useState<ComicLayout | null>(lastLayout());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const link = url.trim().match(/https?:\/\/\S+/i)?.[0];

  const ready = tab === 'url' ? Boolean(link) : images.length > 0;

  const pick = async (files: File[], archive: boolean) => {
    if (files.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      const found = await filesToImages(files);
      if (found.length === 0) setError(t('new.noImages'));
      if (archive) {
        setImages(found);
        setFileName(files[0].name);
        if (!name) setName(guessTitle(files[0].name));
      } else setImages((prev) => [...prev, ...found]);
    } catch (err) {
      setError(t('error.generic', { message: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    try {
      const text = await readClipboard();
      setUrl(text.match(/https?:\/\/\S+/i)?.[0] ?? text.trim());
    } catch {
      /* clipboard refused: typed by hand */
    }
  };

  const start = async () => {
    if (!layout) return;
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      /* ignore */
    }
    updateSettings({ targetLang: target });
    // Must run inside the tap: lets the browser download its translation model.
    warmUpTranslator(settings.sourceLang, target);
    if (tab === 'url' && link) {
      onClose();
      void quickImport(link, { title: name, targetLang: target, layout });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const chapter = await createChapter({
        title: name.trim() || guessTitle(fileName || images[0].name),
        images,
        sourceLang: settings.sourceLang,
        targetLang: target,
        layout,
      });
      void startChapter(chapter.id);
      onClose();
      navigate(`/read/${encodeURIComponent(chapter.id)}`);
    } catch (err) {
      const message = (err as Error).message;
      setError(message === 'NO_IMAGES' ? t('new.noImages') : t('error.generic', { message }));
      setBusy(false);
    }
  };

  if (help) return <HelpSheet onClose={() => setHelp(false)} />;

  if (step === 2)
    return (
      <Modal label={t('add.layout.title')} onClose={onClose}>
        <ModalHead title={t('add.layout.title')} subtitle={t('add.layout.subtitle')} onClose={onClose} />
        <p className="field-label">{t('add.layout.label')}</p>
        <div className="layout-list" role="radiogroup" aria-label={t('add.layout.label')}>
          {(['webtoon', 'manga', 'comic'] as const).map((l) => (
            <button key={l} role="radio" aria-checked={layout === l} className={`layout-option ${layout === l ? 'active' : ''}`} onClick={() => setLayout(l)}>
              <span className="layout-art">
                <LayoutArt layout={l} />
              </span>
              <span className="layout-text">
                <strong>{t(`add.layout.${l}`)}</strong>
                <span className="muted">{t(`add.layout.${l}.text`)}</span>
              </span>
            </button>
          ))}
        </div>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary big wide" disabled={!layout || busy} onClick={() => void start()}>
          {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="sparkles" size={18} />} {t('add.start')}
        </button>
        <button className="btn big wide" onClick={() => setStep(1)} disabled={busy}>
          {t('add.back')}
        </button>
      </Modal>
    );

  return (
    <Modal label={t('add.title')} onClose={onClose}>
      <ModalHead title={t('add.title')} subtitle={t('add.subtitle')} onClose={onClose} />
      <div className="segmented wide" role="tablist">
        {(['url', 'images', 'file'] as const).map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? 'active' : ''} onClick={() => (setTab(x), setError(null))}>
            {t(`add.tab.${x}`)}
          </button>
        ))}
      </div>

      {tab === 'url' && (
        <div className="field">
          <div className="field-row">
            <span className="field-label">{t('add.url')}</span>
            <button className="link-btn" onClick={() => setHelp(true)}>
              {t('add.where')}
            </button>
          </div>
          <div className="input-with-btn">
            <input
              type="url"
              inputMode="url"
              value={url}
              placeholder="https://…/chapitre-1"
              autoComplete="off"
              spellCheck={false}
              aria-label={t('add.url')}
              onChange={(e) => setUrl(e.target.value)}
            />
            {(isNativeApp() || ('clipboard' in navigator && 'readText' in navigator.clipboard)) && (
              <button type="button" className="btn small" onClick={() => void paste()}>
                {t('add.paste')}
              </button>
            )}
          </div>
        </div>
      )}

      {tab === 'images' && (
        <div className="field">
          <button className="btn primary big wide" onClick={() => imageInput.current?.click()} disabled={busy}>
            <Icon name="image" size={18} /> {t('add.pickImages')}
          </button>
          <span className="muted small">{t('add.imagesCount', { n: images.length })}</span>
          <input
            ref={imageInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void pick([...(e.target.files ?? [])], false);
              e.target.value = '';
            }}
          />
        </div>
      )}

      {tab === 'file' && (
        <div className="field">
          <p className="info-box">
            <Icon name="library" size={18} />
            <span>{t('add.fileNote')}</span>
          </p>
          <button className="btn primary big wide" onClick={() => fileInput.current?.click()} disabled={busy}>
            <Icon name="folder" size={18} /> {fileName || t('add.pickFile')}
          </button>
          {images.length > 0 && <span className="muted small">{t('add.imagesCount', { n: images.length })}</span>}
          <input
            ref={fileInput}
            type="file"
            accept=".zip,.cbz,application/zip"
            hidden
            onChange={(e) => {
              void pick([...(e.target.files ?? [])].slice(0, 1), true);
              e.target.value = '';
            }}
          />
        </div>
      )}

      <label className="field">
        <span className="field-label">{t('add.name')}</span>
        <input value={name} maxLength={120} placeholder={t('add.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">{t('add.target')}</span>
        <LangSelect kind="target" value={target} onChange={setTarget} />
      </label>

      {busy && <p className="muted small" role="status">{t('common.loading')}</p>}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <button className="btn primary big wide" disabled={!ready || busy} onClick={() => setStep(2)}>
        {t('add.continue')}
      </button>
      <a className="link-btn center" href="#/new" onClick={onClose}>
        {t('add.advanced')}
      </a>
    </Modal>
  );
}
