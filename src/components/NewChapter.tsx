import { useEffect, useMemo, useRef, useState } from 'react';
import { useT, type MessageKey } from '../i18n';
import {
  ImportError,
  createChapter,
  filesToImages,
  guessTitle,
  isImageUrl,
  urlsToImages,
  type ImportedImage,
} from '../lib/importers';
import { startChapter } from '../lib/pipeline';
import { getSettings, updateSettings, useSettings } from '../lib/settings';
import { warmUpTranslator } from '../lib/translate';
import { navigate } from '../router';
import { Icon } from './Icon';
import { LangSelect } from './LangSelect';

function Thumb({ image, onRemove, label }: { image: ImportedImage; onRemove: () => void; label: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const u = URL.createObjectURL(image.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [image.blob]);
  return (
    <li className="thumb" title={image.name}>
      {url && <img src={url} alt="" loading="lazy" />}
      <button className="thumb-remove" onClick={onRemove} aria-label={label} title={label}>
        <Icon name="close" size={14} />
      </button>
    </li>
  );
}

export function NewChapter({ initialUrl }: { initialUrl?: string }) {
  const t = useT();
  const settings = useSettings();
  const [tab, setTab] = useState<'files' | 'urls'>(initialUrl ? 'urls' : 'files');
  const [images, setImages] = useState<ImportedImage[]>([]);
  const [title, setTitle] = useState('');
  const [source, setSource] = useState(settings.sourceLang);
  const [target, setTarget] = useState(settings.targetLang);
  const [urls, setUrls] = useState(initialUrl ?? '');
  /** Chapter page the images came from, and the chapter it links to as "next". */
  const [link, setLink] = useState<{ origin?: string; next?: string }>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const startButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    setBusy(t('common.loading'));
    try {
      const found = await filesToImages(files);
      if (found.length === 0) setError(t('new.noImages'));
      setImages((prev) => [...prev, ...found]);
      if (!title && found.length > 0) {
        // Folder or archive names make good titles; loose image names don't.
        const first = files[0];
        if (first.webkitRelativePath) setTitle(guessTitle(first.webkitRelativePath));
        else if (/\.(zip|cbz)$/i.test(first.name)) setTitle(guessTitle(first.name));
      }
    } catch (err) {
      setError(t('error.generic', { message: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  // Paste images from the clipboard (Ctrl+V / ⌘V).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  const abort = useRef<AbortController | null>(null);

  const fetchUrls = async (text = urls) => {
    const lines = text.split(/\s+/).filter((l) => /^https?:\/\//i.test(l));
    if (lines.length === 0) return;
    setError(null);
    setBusy(t('new.readingPage'));
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    try {
      const found = await urlsToImages(
        lines,
        getSettings().corsProxy,
        (done, total) => setBusy(t('new.fetching', { done, total })),
        controller.signal,
        () => setBusy(t('new.readingPage')),
      );
      if (controller.signal.aborted) return;
      if (found.images.length === 0) setError(t('new.noImages'));
      setImages((prev) => [...prev, ...found.images]);
      setTitle((prev) => prev || found.title || guessTitle(lines[0]));
      const page = lines.find((l) => !isImageUrl(l));
      if (found.images.length > 0 && page) setLink((prev) => ({ origin: prev.origin ?? page, next: found.nextUrl ?? prev.next }));
      // Opened on a link: everything is ready, show the button that starts the translation.
      if (found.images.length > 0 && text === initialUrl) {
        requestAnimationFrame(() => startButton.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof ImportError) {
        setError(t(err.code === 'PAGE_UNREACHABLE' ? 'new.pageUnreachable' : 'new.imageUnreachable', { url: err.url }));
      } else {
        setError(t('error.generic', { message: (err as Error).message }));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  };

  // Opened on a chapter link ("import the next chapter"): fetch it right away.
  // Downloads still running when the screen is left are dropped.
  useEffect(() => {
    if (initialUrl) void fetchUrls(initialUrl);
    return () => abort.current?.abort();
  }, []);

  const start = async () => {
    if (images.length === 0) return;
    // Must run inside the click: lets the browser download its translation model.
    warmUpTranslator(source, target);
    setBusy(t('common.loading'));
    setError(null);
    try {
      updateSettings({ sourceLang: source, targetLang: target });
      const chapter = await createChapter({
        title: title || guessTitle(images[0].name),
        images,
        sourceLang: source,
        targetLang: target,
        origin: link.origin,
        nextUrl: link.next,
      });
      void startChapter(chapter.id);
      navigate(`/read/${encodeURIComponent(chapter.id)}`);
    } catch (err) {
      const message = (err as Error).message;
      setError(message === 'NO_IMAGES' ? t('new.noImages') : t('error.generic', { message }));
      setBusy(null);
    }
  };

  const engineLabel = useMemo(() => {
    const key = `settings.provider.${settings.provider}` as MessageKey;
    return settings.ocrEngine === 'vision' ? `${t('settings.ocrEngine.vision')} · ${settings.llm.model}` : t(key);
  }, [settings.provider, settings.ocrEngine, settings.llm.model, t]);

  return (
    <div className="new-chapter">
      <h1>{t('new.title')}</h1>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
          <Icon name="image" size={18} /> {t('new.tab.files')}
        </button>
        <button role="tab" aria-selected={tab === 'urls'} className={tab === 'urls' ? 'active' : ''} onClick={() => setTab('urls')}>
          <Icon name="link" size={18} /> {t('new.tab.urls')}
        </button>
      </div>

      {tab === 'files' ? (
        <div
          className={`dropzone ${dragging ? 'dragging' : ''}`}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.current?.click()}
          role="button"
          tabIndex={0}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void addFiles([...e.dataTransfer.files]);
          }}
        >
          <Icon name="upload" size={36} />
          <strong>{t('new.drop')}</strong>
          <span className="muted small">{t('new.dropHint')}</span>
          <button
            className="btn ghost small"
            onClick={(e) => {
              e.stopPropagation();
              folderInput.current?.click();
            }}
          >
            <Icon name="folder" size={16} /> {t('new.folder')}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*,.zip,.cbz"
            multiple
            hidden
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <input
            ref={folderInput}
            type="file"
            multiple
            hidden
            {...({ webkitdirectory: '' } as Record<string, string>)}
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </div>
      ) : (
        <div className="urls">
          <label htmlFor="urls">{t('new.urlsLabel')}</label>
          <textarea
            id="urls"
            rows={5}
            placeholder="https://…"
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            spellCheck={false}
          />
          <p className="muted small">{t('new.urlsHint')}</p>
          <button className="btn" onClick={() => void fetchUrls()} disabled={!urls.trim() || busy !== null}>
            <Icon name="download" size={18} /> {t('new.fetch')}
          </button>
        </div>
      )}

      {busy && (
        <p className="notice" role="status">
          {busy}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {images.length > 0 && (
        <section className="selection">
          <div className="section-head">
            <h2>{images.length === 1 ? t('new.image') : t('new.images', { n: images.length })}</h2>
            <button
              className="btn ghost small"
              onClick={() => {
                setImages([]);
                setLink({});
              }}
            >
              {t('new.clear')}
            </button>
          </div>
          <ul className="thumbs">
            {images.map((img, i) => (
              <Thumb
                key={`${img.name}-${i}`}
                image={img}
                label={t('new.remove')}
                onRemove={() => setImages((prev) => prev.filter((_, k) => k !== i))}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="options">
        <label className="field">
          <span>{t('new.chapterTitle')}</span>
          <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder={t('new.titlePlaceholder')} />
        </label>
        <div className="lang-row">
          <label className="field">
            <span>{t('common.from')}</span>
            <LangSelect kind="source" value={source} onChange={setSource} />
          </label>
          <Icon name="back" className="lang-arrow" />
          <label className="field">
            <span>{t('common.to')}</span>
            <LangSelect kind="target" value={target} onChange={setTarget} />
          </label>
        </div>
        <p className="muted small">
          {t('new.engine', { engine: engineLabel })} · <a href="#/settings">{t('nav.settings')}</a>
        </p>
        <button ref={startButton} className="btn primary big" disabled={images.length === 0 || busy !== null} onClick={start}>
          <Icon name="sparkles" /> {t('new.start')}
        </button>
      </section>
    </div>
  );
}
