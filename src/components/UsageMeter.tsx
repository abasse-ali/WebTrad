import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { providerLimits, type ProviderLimits } from '../lib/translate/llm';
import { useSettings } from '../lib/settings';
import { hostOf, useUsage } from '../lib/usage';

/** "OpenRouter : 23/1000 aujourd'hui · 7/20 cette minute": requests sent to the AI provider. */
export function UsageMeter({ detailed = false }: { detailed?: boolean }) {
  const t = useT();
  const { llm } = useSettings();
  const host = hostOf(llm.baseUrl);
  const usage = useUsage(host);
  const [limits, setLimits] = useState<ProviderLimits | undefined>();
  useEffect(() => {
    let live = true;
    void providerLimits(llm).then((l) => live && setLimits(l));
    return () => {
      live = false;
    };
  }, [llm]);
  if (!llm.baseUrl.trim()) return null;
  const name = /openrouter/i.test(host) ? 'OpenRouter' : host.replace(/^(api|www|integrate\.api)\./, '');
  const nearDay = limits && usage.today >= limits.daily * 0.9;
  const nearMinute = limits && usage.minute >= limits.perMinute;
  const reset = usage.resetsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <span className={`usage ${nearDay ? 'warn' : ''}`} title={t('usage.resets', { time: reset })}>
      <strong>{name}</strong>{' '}
      {limits ? t('usage.todayOf', { n: usage.today, max: limits.daily }) : t('usage.today', { n: usage.today })}
      {' · '}
      <span className={nearMinute ? 'warn' : ''}>
        {limits ? t('usage.minuteOf', { n: usage.minute, max: limits.perMinute }) : t('usage.minute', { n: usage.minute })}
      </span>
      {detailed && usage.limited > 0 && ` · ${t('usage.limited', { n: usage.limited })}`}
      {detailed && ` · ${t('usage.resets', { time: reset })}`}
      {detailed && limits?.freeTier && <small className="block muted">{t('usage.freeTier')}</small>}
    </span>
  );
}
