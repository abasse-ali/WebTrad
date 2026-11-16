import { useEffect, useRef, useState } from 'react';
import type { Translate } from '../i18n';
import { decodeImage } from '../lib/image';
import { drawLayouts, layoutBubble, type LayoutOptions } from '../lib/layout';
import type { Bubble, Page } from '../lib/types';
import { Icon } from './Icon';

interface Props {
  draft: Bubble;
  page?: Page;
  layoutOptions: LayoutOptions;
  busy: boolean;
  t: Translate;
  onChange: (b: Bubble) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onRetranslate: () => void;
  onReocr: () => void;
}

type View = 'translation' | 'clean' | 'original';

/**
 * The bubble cut out of its page: as translated, with the original letters
 * taken off, or as drawn. Follows the draft while it is edited.
 */
function BlockPreview({ page, bubble, view, options }: { page: Page; bubble: Bubble; view: View; options: LayoutOptions }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [bitmap, setBitmap] = useState<Awaited<ReturnType<typeof decodeImage>> | null>(null);

  useEffect(() => {
    let live = true;
    let decoded: Awaited<ReturnType<typeof decodeImage>> | null = null;
    void decodeImage(page.blob).then((b) => {
      decoded = b;
      if (live) setBitmap(b);
      else b.close();
    });
    return () => {
      live = false;
      decoded?.close();
    };
  }, [page.blob]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !bitmap) return;
    let live = true;
    const layout = layoutBubble({ ...bubble, hidden: false }, page, options);
    // Everything the bubble covers, with some drawing around.
    const boxes = [bubble, layout?.erase, layout?.area].filter(Boolean) as { x: number; y: number; w: number; h: number }[];
    const x0 = Math.min(...boxes.map((b) => b.x));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w));
    const y1 = Math.max(...boxes.map((b) => b.y + b.h));
    const pad = Math.max(16, (x1 - x0) * 0.12);
    const crop = {
      x: Math.max(0, x0 - pad),
      y: Math.max(0, y0 - pad),
      w: Math.min(page.width, x1 + pad) - Math.max(0, x0 - pad),
      h: Math.min(page.height, y1 + pad) - Math.max(0, y0 - pad),
    };
    const width = Math.min(1000, Math.round(c.clientWidth * (window.devicePixelRatio || 1))) || 600;
    const k = width / crop.w;
    c.width = width;
    c.height = Math.round(crop.h * k);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const draw = (patches?: Map<string, CanvasImageSource>) => {
      if (!live) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.setTransform(k, 0, 0, k, -crop.x * k, -crop.y * k);
      ctx.drawImage(bitmap.source, 0, 0);
      if (view !== 'original' && layout) drawLayouts(ctx, [view === 'clean' ? { ...layout, lines: [] } : layout], patches);
    };
    if (layout?.patch && view !== 'original') {
      const img = new Image();
      img.src = layout.patch;
      img.decode().then(
        () => draw(new Map([[layout.patch!, img]])),
        () => draw(),
      );
    } else draw();
    return () => {
      live = false;
    };
  }, [bitmap, bubble, view, options, page]);

  return <canvas ref={canvas} className="block-preview" aria-hidden="true" />;
}

export function BubbleSheet({ draft, page, layoutOptions, busy, t, onChange, onSave, onCancel, onDelete, onRetranslate, onReocr }: Props) {
  const [view, setView] = useState<View>('translation');
  const [editing, setEditing] = useState(!draft.translation);
  const [more, setMore] = useState(false);
  const [copied, setCopied] = useState(false);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSave();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onSave]);

  const change = (b: Bubble) => {
    setChanged(true);
    onChange(b);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft.original);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard refused */
    }
  };

  const scale = draft.fontScale ?? 1;

  return (
    <div className="sheet block-sheet" role="dialog" aria-modal="false" aria-label={t('block.title')}>
      <div className="sheet-head">
        <strong className="block-title">{t('block.title')}</strong>
        <button className="round-btn" onClick={onCancel} aria-label={t('common.close')}>
          <Icon name="close" size={20} />
        </button>
      </div>

      {page && <BlockPreview page={page} bubble={draft} view={view} options={layoutOptions} />}

      <p className="field-label">{t('reader.settings.view')}</p>
      <div className="segmented wide pill-tabs" role="group">
        {(['translation', 'clean', 'original'] as const).map((v) => (
          <button key={v} className={view === v ? 'active' : ''} aria-pressed={view === v} onClick={() => setView(v)}>
            {t(`block.view.${v}`)}
          </button>
        ))}
      </div>

      <p className="field-label">{t('block.original')}</p>
      <div className="block-row">
        <p className="block-text" lang="und">
          {draft.original || '—'}
        </p>
        <button className="btn small outline" onClick={() => void copy()} disabled={!draft.original}>
          <Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? t('block.copied') : t('block.copy')}
        </button>
      </div>

      <p className="field-label">{t('block.translation')}</p>
      {editing ? (
        <textarea
          className="block-edit"
          rows={3}
          value={draft.translation}
          autoFocus
          placeholder={draft.original ? '' : t('bubble.empty')}
          onChange={(e) => change({ ...draft, translation: e.target.value, edited: true })}
        />
      ) : (
        <div className="block-row">
          <p className="block-text">{draft.translation || '—'}</p>
          <button className="btn small outline" onClick={() => setEditing(true)}>
            <Icon name="edit" size={16} /> {t('block.edit')}
          </button>
        </div>
      )}

      <button className="link-btn more-toggle" onClick={() => setMore((v) => !v)} aria-expanded={more}>
        {t('block.more')} <Icon name={more ? 'toTop' : 'toBottom'} size={16} />
      </button>

      {more && (
        <div className="block-more">
          <label className="field">
            <span>{t('bubble.original')}</span>
            <textarea rows={2} value={draft.original} lang="und" onChange={(e) => change({ ...draft, original: e.target.value })} />
          </label>
          <div className="row gap">
            <button className="btn small" disabled={busy || !draft.original.trim()} onClick={onRetranslate}>
              <Icon name="refresh" size={14} /> {t('bubble.retranslate')}
            </button>
            <button className="btn small ghost" disabled={busy} onClick={onReocr}>
              <Icon name="square" size={14} /> {t('bubble.reocr')}
            </button>
          </div>
          <div className="sheet-grid">
            <label className="field">
              <span>
                {t('bubble.fontSize')} · {Math.round(scale * 100)} %
              </span>
              <input type="range" min={0.4} max={2.5} step={0.05} value={scale} onChange={(e) => change({ ...draft, fontScale: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>
                {t('bubble.rotation')} · {Math.round(draft.rotation ?? 0)}°
              </span>
              <input
                type="range"
                min={-45}
                max={45}
                step={1}
                value={draft.rotation ?? 0}
                onChange={(e) => change({ ...draft, rotation: Number(e.target.value) || undefined })}
              />
            </label>
            <div className="colors">
              <label className="color">
                <input type="color" value={draft.fill ?? '#ffffff'} onChange={(e) => change({ ...draft, fill: e.target.value })} />
                <span>{t('bubble.fill')}</span>
              </label>
              <label className="color">
                <input type="color" value={draft.color ?? '#111111'} onChange={(e) => change({ ...draft, color: e.target.value })} />
                <span>{t('bubble.textColor')}</span>
              </label>
              {draft.color && (
                <button className="btn small ghost" onClick={() => change({ ...draft, color: undefined })}>
                  {t('bubble.auto')}
                </button>
              )}
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={Boolean(draft.hidden)} onChange={(e) => change({ ...draft, hidden: e.target.checked })} />
            <span>{t('bubble.keepOriginal')}</span>
          </label>
          <button className="btn danger ghost small" onClick={onDelete}>
            <Icon name="trash" size={16} /> {t('bubble.delete')}
          </button>
        </div>
      )}

      {(changed || editing || more) && (
        <div className="sheet-actions">
          <span className="spacer" />
          <button className="btn ghost" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" onClick={onSave} disabled={busy}>
            <Icon name="check" size={16} /> {t('common.save')}
          </button>
        </div>
      )}
    </div>
  );
}
