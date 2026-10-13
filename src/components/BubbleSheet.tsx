import { useEffect } from 'react';
import type { Translate } from '../i18n';
import type { Bubble } from '../lib/types';
import { Icon } from './Icon';

interface Props {
  draft: Bubble;
  busy: boolean;
  t: Translate;
  onChange: (b: Bubble) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onRetranslate: () => void;
  onReocr: () => void;
}

export function BubbleSheet({ draft, busy, t, onChange, onSave, onCancel, onDelete, onRetranslate, onReocr }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSave();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onSave]);

  const scale = draft.fontScale ?? 1;

  return (
    <div className="sheet" role="dialog" aria-modal="false" aria-label={t('bubble.title')}>
      <div className="sheet-head">
        <strong>{t('bubble.title')}</strong>
        {draft.confidence !== undefined && (
          <span className="muted small">{t('bubble.confidence', { n: draft.confidence })}</span>
        )}
        <button className="icon-btn" onClick={onCancel} aria-label={t('common.close')}>
          <Icon name="close" size={18} />
        </button>
      </div>

      <label className="field">
        <span>{t('bubble.original')}</span>
        <textarea
          rows={2}
          value={draft.original}
          lang="und"
          onChange={(e) => onChange({ ...draft, original: e.target.value })}
        />
      </label>
      <div className="row gap">
        <button className="btn small" disabled={busy || !draft.original.trim()} onClick={onRetranslate}>
          <Icon name="refresh" size={14} /> {t('bubble.retranslate')}
        </button>
        <button className="btn small ghost" disabled={busy} onClick={onReocr}>
          <Icon name="square" size={14} /> {t('bubble.reocr')}
        </button>
      </div>

      <label className="field">
        <span>{t('bubble.translation')}</span>
        <textarea
          rows={3}
          value={draft.translation}
          autoFocus={!draft.translation}
          placeholder={draft.original ? '' : t('bubble.empty')}
          onChange={(e) => onChange({ ...draft, translation: e.target.value, edited: true })}
        />
      </label>

      <div className="sheet-grid">
        <label className="field">
          <span>
            {t('bubble.fontSize')} · {Math.round(scale * 100)} %
          </span>
          <input
            type="range"
            min={0.4}
            max={2.5}
            step={0.05}
            value={scale}
            onChange={(e) => onChange({ ...draft, fontScale: Number(e.target.value) })}
          />
        </label>
        <div className="colors">
          <label className="color">
            <input type="color" value={draft.fill ?? '#ffffff'} onChange={(e) => onChange({ ...draft, fill: e.target.value })} />
            <span>{t('bubble.fill')}</span>
          </label>
          <label className="color">
            <input
              type="color"
              value={draft.color ?? '#111111'}
              onChange={(e) => onChange({ ...draft, color: e.target.value })}
            />
            <span>{t('bubble.textColor')}</span>
          </label>
          {draft.color && (
            <button className="btn small ghost" onClick={() => onChange({ ...draft, color: undefined })}>
              {t('bubble.auto')}
            </button>
          )}
        </div>
      </div>

      <label className="check">
        <input type="checkbox" checked={Boolean(draft.hidden)} onChange={(e) => onChange({ ...draft, hidden: e.target.checked })} />
        <span>{t('bubble.keepOriginal')}</span>
      </label>

      <div className="sheet-actions">
        <button className="btn danger ghost" onClick={onDelete}>
          <Icon name="trash" size={16} /> {t('bubble.delete')}
        </button>
        <span className="spacer" />
        <button className="btn ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button className="btn primary" onClick={onSave} disabled={busy}>
          <Icon name="check" size={16} /> {t('common.save')}
        </button>
      </div>
    </div>
  );
}
