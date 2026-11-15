import { useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { dismissQuickImport, quickImport, useQuickImport } from '../lib/quick';
import { isNativeApp, readClipboard } from '../lib/native';
import { navigate } from '../router';
import { Icon } from './Icon';

/** "Paste a chapter link and read" field of the library. */
export function QuickLink() {
  const t = useT();
  const [value, setValue] = useState('');
  const busy = useQuickImport() !== null;
  const url = value.trim().match(/https?:\/\/\S+/i)?.[0];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url) void quickImport(url);
  };

  const paste = async () => {
    try {
      const text = await readClipboard();
      const found = text.match(/https?:\/\/\S+/i)?.[0];
      if (found) {
        setValue(found);
        void quickImport(found);
      } else setValue(text.trim());
    } catch {
      /* clipboard refused: the reader pastes by hand */
    }
  };

  return (
    <form className="quick-link" onSubmit={submit}>
      <div className="quick-field">
        <Icon name="link" size={18} />
        <input
          type="url"
          inputMode="url"
          value={value}
          placeholder={t('quick.placeholder')}
          aria-label={t('quick.placeholder')}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
        />
        {value ? (
          <button
            type="button"
            className="icon-btn clear"
            onClick={() => setValue('')}
            aria-label={t('quick.clear')}
            title={t('quick.clear')}
          >
            <Icon name="close" size={16} />
          </button>
        ) : (
          (isNativeApp() || ('clipboard' in navigator && 'readText' in navigator.clipboard)) && (
            <button type="button" className="btn small ghost" onClick={() => void paste()}>
              {t('quick.paste')}
            </button>
          )
        )}
      </div>
      <button type="submit" className="btn primary" disabled={!url || busy}>
        <Icon name="play" size={16} /> {t('quick.read')}
      </button>
    </form>
  );
}

/** Progress of a quick import, shown over any screen. */
export function QuickStatus() {
  const t = useT();
  const state = useQuickImport();
  if (!state) return null;
  return (
    <div className={`quick-status ${state.error ? 'error' : ''}`} role={state.error ? 'alert' : 'status'}>
      {!state.error && <span className="spinner" aria-hidden="true" />}
      <span className="quick-message">{state.message}</span>
      {state.error && (
        <button
          className="btn small"
          onClick={() => {
            dismissQuickImport();
            navigate(`/new?url=${encodeURIComponent(state.url)}`);
          }}
        >
          {t('quick.openImport')}
        </button>
      )}
      <button className="icon-btn" onClick={dismissQuickImport} aria-label={t(state.error ? 'common.close' : 'common.cancel')}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
