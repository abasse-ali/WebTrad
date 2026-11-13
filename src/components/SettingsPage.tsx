import { useEffect, useState } from 'react';
import { formatBytes, useT, type MessageKey } from '../i18n';
import { useStorageEstimate } from '../hooks';
import { clearAll } from '../lib/db';
import { displayName } from '../lib/languages';
import { clearAllPositions } from '../lib/progress';
import { LLM_PRESETS, updateSettings, useSettings } from '../lib/settings';
import { builtinAvailability, hasBuiltinTranslator } from '../lib/translate/chrome';
import { testLlm } from '../lib/translate/llm';
import { clearLayoutCache } from '../lib/layout';
import type { FontId, LetterCase, OcrEngine, ProviderId, ThemeId } from '../lib/types';
import { Icon } from './Icon';
import { LangSelect } from './LangSelect';

const PROVIDERS: ProviderId[] = ['auto', 'chrome', 'google', 'mymemory', 'llm'];

export function SettingsPage() {
  const t = useT();
  const s = useSettings();
  const [cleared, setCleared] = useState(0);
  const storage = useStorageEstimate([cleared]);
  const [builtin, setBuiltin] = useState<string>('…');
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const preset = LLM_PRESETS.find((p) => p.id === s.llm.preset) ?? LLM_PRESETS[LLM_PRESETS.length - 1];

  const [persisted, setPersisted] = useState<boolean | null>(null);

  useEffect(() => {
    if (!hasBuiltinTranslator()) {
      setBuiltin(t('settings.builtinMissing'));
      return;
    }
    let alive = true;
    setBuiltin('…');
    // With auto-detection the pair is only known per chapter: probe a common one.
    const source = s.sourceLang === 'auto' ? (s.targetLang === 'en' ? 'ko' : 'en') : s.sourceLang;
    void builtinAvailability(source, s.targetLang).then((a) => {
      if (!alive) return;
      setBuiltin(
        a === 'unavailable'
          ? t('settings.builtinPair', { source: displayName(source, s.uiLang), target: displayName(s.targetLang, s.uiLang) })
          : t(`settings.builtin.${a}` as MessageKey),
      );
    });
    return () => {
      alive = false;
    };
  }, [s.sourceLang, s.targetLang, s.uiLang, t]);

  useEffect(() => {
    void navigator.storage
      ?.persisted?.()
      .then(setPersisted)
      .catch(() => undefined);
  }, [cleared]);

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const out = await testLlm(s.llm);
      setTest({ ok: true, text: t('settings.llm.testOk', { text: out }) });
    } catch (err) {
      setTest({ ok: false, text: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const wipe = async () => {
    if (!window.confirm(t('settings.storage.confirm'))) return;
    await clearAll();
    clearAllPositions();
    setCleared((n) => n + 1);
  };

  return (
    <div className="settings">
      <h1>{t('settings.title')}</h1>

      <section className="panel">
        <h2>{t('settings.general')}</h2>
        <label className="field">
          <span>{t('settings.uiLang')}</span>
          <select value={s.uiLang} onChange={(e) => updateSettings({ uiLang: e.target.value as 'fr' | 'en' })}>
            <option value="fr">Français</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="field">
          <span>{t('settings.theme')}</span>
          <select value={s.theme} onChange={(e) => updateSettings({ theme: e.target.value as ThemeId })}>
            {(['auto', 'light', 'dark'] as ThemeId[]).map((id) => (
              <option key={id} value={id}>
                {t(`settings.theme.${id}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <div className="two">
          <label className="field">
            <span>{t('settings.defaultSource')}</span>
            <LangSelect kind="source" value={s.sourceLang} onChange={(v) => updateSettings({ sourceLang: v })} />
          </label>
          <label className="field">
            <span>{t('settings.defaultTarget')}</span>
            <LangSelect kind="target" value={s.targetLang} onChange={(v) => updateSettings({ targetLang: v })} />
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>{t('settings.translation')}</h2>
        <fieldset className="choices">
          <legend>{t('settings.provider')}</legend>
          {PROVIDERS.map((p) => (
            <label key={p} className={`choice ${s.provider === p ? 'active' : ''}`}>
              <input type="radio" name="provider" checked={s.provider === p} onChange={() => updateSettings({ provider: p })} />
              <span>
                <strong>{t(`settings.provider.${p}` as MessageKey)}</strong>
                <small>{t(`settings.provider.${p}.desc` as MessageKey)}</small>
                {p === 'chrome' && <small className="status">{builtin}</small>}
              </span>
            </label>
          ))}
        </fieldset>
        {(s.provider === 'mymemory' || s.provider === 'google' || s.provider === 'auto') && (
          <label className="field">
            <span>{t('settings.email')}</span>
            <input
              type="email"
              value={s.myMemoryEmail}
              placeholder="vous@example.com"
              onChange={(e) => updateSettings({ myMemoryEmail: e.target.value })}
            />
          </label>
        )}
      </section>

      <section className="panel">
        <h2>{t('settings.ocr')}</h2>
        <fieldset className="choices">
          <legend>{t('settings.ocrEngine')}</legend>
          {(['tesseract', 'vision'] as OcrEngine[]).map((o) => (
            <label key={o} className={`choice ${s.ocrEngine === o ? 'active' : ''}`}>
              <input type="radio" name="ocr" checked={s.ocrEngine === o} onChange={() => updateSettings({ ocrEngine: o })} />
              <span>
                <strong>{t(`settings.ocrEngine.${o}` as MessageKey)}</strong>
                <small>{t(`settings.ocrEngine.${o}.desc` as MessageKey)}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {s.ocrEngine === 'tesseract' && (
          <label className="field">
            <span>{t('settings.minConfidence', { n: s.minConfidence })}</span>
            <input
              type="range"
              min={10}
              max={90}
              step={5}
              value={s.minConfidence}
              onChange={(e) => updateSettings({ minConfidence: Number(e.target.value) })}
            />
          </label>
        )}
      </section>

      {(s.provider === 'llm' || s.ocrEngine === 'vision') && (
        <section className="panel">
          <h2>{t('settings.llm')}</h2>
          <label className="field">
            <span>{t('settings.llm.preset')}</span>
            <select
              value={preset.id}
              onChange={(e) => {
                const p = LLM_PRESETS.find((x) => x.id === e.target.value)!;
                updateSettings({
                  llm: { ...s.llm, preset: p.id, baseUrl: p.baseUrl || s.llm.baseUrl, model: p.model || s.llm.model },
                });
                setTest(null);
              }}
            >
              {LLM_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {preset.note && <p className="muted small">{preset.note[s.uiLang]}</p>}
          <label className="field">
            <span>{t('settings.llm.baseUrl')}</span>
            <input
              value={s.llm.baseUrl}
              spellCheck={false}
              placeholder="https://…/v1"
              onChange={(e) => updateSettings({ llm: { ...s.llm, baseUrl: e.target.value } })}
            />
          </label>
          <div className="two">
            <label className="field">
              <span>{t('settings.llm.model')}</span>
              <input value={s.llm.model} spellCheck={false} onChange={(e) => updateSettings({ llm: { ...s.llm, model: e.target.value } })} />
            </label>
            <label className="field">
              <span>
                {t('settings.llm.apiKey')}
                {preset.keyUrl && (
                  <>
                    {' · '}
                    <a href={preset.keyUrl} target="_blank" rel="noreferrer">
                      {t('settings.llm.getKey')}
                    </a>
                  </>
                )}
              </span>
              <input
                type="password"
                autoComplete="off"
                value={s.llm.apiKey}
                onChange={(e) => updateSettings({ llm: { ...s.llm, apiKey: e.target.value } })}
              />
            </label>
          </div>
          <p className="muted small">{t('settings.llm.keyNote')}</p>
          <div className="row gap">
            <button className="btn" onClick={runTest} disabled={testing || !s.llm.baseUrl}>
              <Icon name="check" size={16} /> {t('common.test')}
            </button>
            {testing && <span className="muted small">{t('common.loading')}</span>}
            {test && <span className={`small ${test.ok ? 'ok' : 'error'}`}>{test.text}</span>}
          </div>
        </section>
      )}

      <section className="panel">
        <h2>{t('settings.render')}</h2>
        <label className="field">
          <span>{t('settings.font')}</span>
          <select
            value={s.font}
            onChange={(e) => {
              clearLayoutCache();
              updateSettings({ font: e.target.value as FontId });
            }}
          >
            {(['comic', 'sans', 'serif'] as FontId[]).map((f) => (
              <option key={f} value={f}>
                {t(`settings.font.${f}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('settings.letterCase')}</span>
          <select value={s.letterCase} onChange={(e) => updateSettings({ letterCase: e.target.value as LetterCase })}>
            {(['original', 'upper', 'normal'] as LetterCase[]).map((c) => (
              <option key={c} value={c}>
                {t(`settings.letterCase.${c}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('settings.exportMax', { n: s.exportMaxMB > 0 ? formatBytes(s.exportMaxMB * 1_000_000) : t('settings.exportMax.none') })}</span>
          <input
            type="range"
            min={0}
            max={200}
            step={5}
            value={s.exportMaxMB}
            onChange={(e) => updateSettings({ exportMaxMB: Number(e.target.value) })}
          />
        </label>
        <p className="muted small">{t('settings.exportMax.desc')}</p>
      </section>

      <section className="panel">
        <h2>{t('settings.import')}</h2>
        <label className="field">
          <span>{t('settings.corsProxy')}</span>
          <input
            value={s.corsProxy}
            spellCheck={false}
            placeholder="https://mon-proxy.workers.dev/?url={url}&referer={referer}"
            onChange={(e) => updateSettings({ corsProxy: e.target.value })}
          />
        </label>
        <p className="muted small">{t('settings.corsProxy.desc')}</p>
      </section>

      <section className="panel">
        <h2>{t('settings.storage')}</h2>
        {storage && (
          <p className="muted">
            {t('settings.storage.used', { used: formatBytes(storage.usage), quota: formatBytes(storage.quota) })}
          </p>
        )}
        {persisted !== null && (
          <p className="muted small">{t(persisted ? 'settings.storage.persisted' : 'settings.storage.volatile')}</p>
        )}
        <button className="btn danger ghost" onClick={wipe}>
          <Icon name="trash" size={16} /> {t('settings.storage.clear')}
        </button>
      </section>

      <section className="panel">
        <h2>{t('settings.about')}</h2>
        <p className="muted">{t('settings.about.text')}</p>
      </section>
    </div>
  );
}
