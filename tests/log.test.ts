import { describe, expect, it } from 'vitest';
import { clearLog, logAsText, logError, logInfo, redact } from '../src/lib/log';

describe('activity log', () => {
  it('never keeps API keys', () => {
    expect(redact('Authorization: Bearer nvapi-ABCDEFGHIJKLMNOP')).not.toContain('ABCDEFGHIJKLMNOP');
    expect(redact('key sk-or-v1-1234567890abcdef used')).toBe('key sk-or-… used');
  });
  it('writes time-stamped lines with their details', async () => {
    clearLog();
    logInfo('ia', 'POST /chat/completions OK', { modèle: 'qwen/qwen3.5', ms: 5120, apiKey: 'nvapi-secret-value-1234' });
    logError('job', 'Page 2 en erreur : timeout');
    const { useLog } = await import('../src/lib/log');
    expect(typeof useLog).toBe('function');
    const text = logAsText([
      { t: new Date(2026, 10, 15, 1, 22, 7, 431).getTime(), level: 'info', cat: 'ia', msg: 'POST /chat/completions OK', data: { modèle: 'qwen/qwen3.5', ms: 5120 } },
    ]);
    expect(text).toBe('2026-11-15 01:22:07.431 INFO  [ia] POST /chat/completions OK · modèle=qwen/qwen3.5 ms=5120');
  });
});
