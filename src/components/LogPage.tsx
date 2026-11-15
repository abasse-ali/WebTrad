import { useMemo, useState } from 'react';
import { useT, type MessageKey } from '../i18n';
import { downloadBlob } from '../lib/exporter';
import { clearLog, formatData, formatTime, logAsText, useLog, type LogCategory, type LogLevel } from '../lib/log';
import { Icon } from './Icon';

const CATEGORIES: (LogCategory | 'all')[] = ['all', 'job', 'import', 'ocr', 'ia', 'translate', 'export', 'app'];

/** Settings → Activity log: everything the app did, newest first. */
export function LogPage() {
  const t = useT();
  const entries = useLog();
  const [cat, setCat] = useState<LogCategory | 'all'>('all');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries
      .filter((e) => (cat === 'all' || e.cat === cat) && (!errorsOnly || e.level !== 'info'))
      .filter((e) => !q || `${e.msg} ${formatData(e.data)}`.toLowerCase().includes(q))
      .slice()
      .reverse();
  }, [entries, cat, errorsOnly, query]);

  const text = () => logAsText([...shown].reverse());
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard refused: the file download still works */
    }
  };
  const save = () => {
    const stamp = formatTime(Date.now()).slice(0, 16).replace(/[: ]/g, '-');
    downloadBlob(new Blob([text()], { type: 'text/plain' }), `webtrad-journal-${stamp}.txt`);
  };
  const clear = () => {
    if (window.confirm(t('log.clearConfirm'))) clearLog();
  };
  const levelClass: Record<LogLevel, string> = { info: '', warn: 'warn', error: 'error' };

  return (
    <div className="settings log-page">
      <a className="link small" href="#/settings">
        ← {t('nav.settings')}
      </a>
      <h1>{t('log.title')}</h1>
      <p className="muted small">{t('log.intro')}</p>
      <div className="log-tools">
        <select value={cat} onChange={(e) => setCat(e.target.value as LogCategory | 'all')} aria-label={t('log.category')}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`log.cat.${c}` as MessageKey)}
            </option>
          ))}
        </select>
        <input type="search" value={query} placeholder={t('log.search')} onChange={(e) => setQuery(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
          <span>{t('log.errorsOnly')}</span>
        </label>
      </div>
      <div className="row gap">
        <button className="btn small" onClick={() => void copy()} disabled={shown.length === 0}>
          <Icon name={copied ? 'check' : 'link'} size={14} /> {copied ? t('bookmark.copied') : t('log.copy')}
        </button>
        <button className="btn small" onClick={save} disabled={shown.length === 0}>
          <Icon name="download" size={14} /> {t('log.save')}
        </button>
        <button className="btn small ghost danger" onClick={clear} disabled={entries.length === 0}>
          <Icon name="trash" size={14} /> {t('log.clear')}
        </button>
      </div>
      <p className="muted small">{t('log.count', { n: shown.length, total: entries.length })}</p>
      <ol className="log-list">
        {shown.slice(0, 500).map((e, i) => (
          <li key={`${e.t}-${i}`} className={levelClass[e.level]}>
            <div className="log-head">
              <time>{formatTime(e.t).slice(5)}</time>
              <span className="log-cat">{t(`log.cat.${e.cat}` as MessageKey)}</span>
            </div>
            <div className="log-msg">{e.msg}</div>
            {e.data && Object.keys(e.data).length > 0 && (
              <dl className="log-data">
                {Object.entries(e.data).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{String(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        ))}
      </ol>
      {shown.length === 0 && <p className="muted center">{t('log.empty')}</p>}
    </div>
  );
}
