import { afterEach, describe, expect, it, vi } from 'vitest';
import { listModels, visionTranslate } from '../src/lib/translate/llm';

const nvidia = { preset: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1', apiKey: 'nvapi-test', model: 'qwen/qwen3.5-397b-a17b' };
const gemini = { preset: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'k', model: 'gemini-flash-latest' };

function answer(content: unknown) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    void init;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('AI vision boxes', () => {
  it('reads Qwen-style [xmin, ymin, xmax, ymax] boxes from NVIDIA', async () => {
    const fetchMock = answer({ source_language: 'en', bubbles: [{ bbox_2d: [100, 200, 300, 260], text: 'HI', translation: 'SALUT' }] });
    vi.stubGlobal('fetch', fetchMock);
    const out = await visionTranslate('data:image/jpeg;base64,', 'auto', 'fr', undefined, nvidia);
    expect(out.bubbles[0].box).toEqual([200, 100, 260, 300]);
    expect(out.sourceLanguage).toBe('en');
    // The request goes to NVIDIA with the key, and asks for that order.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer nvapi-test');
    expect(String(init?.body)).toContain('[xmin, ymin, xmax, ymax]');
  });

  it('keeps Gemini’s [ymin, xmin, ymax, xmax] order', async () => {
    vi.stubGlobal('fetch', answer({ bubbles: [{ box_2d: [200, 100, 260, 300], text: 'HI', translation: 'SALUT' }] }));
    const out = await visionTranslate('data:image/jpeg;base64,', 'en', 'fr', undefined, gemini);
    expect(out.bubbles[0].box).toEqual([200, 100, 260, 300]);
  });

  it('brings pixel coordinates back to 0-1000', async () => {
    vi.stubGlobal('fetch', answer({ bubbles: [{ bbox_2d: [100, 400, 300, 600], text: 'HI', translation: 'SALUT' }] }));
    const out = await visionTranslate('data:image/jpeg;base64,', 'en', 'fr', undefined, nvidia, { width: 1000, height: 2000 });
    expect(out.bubbles[0].box).toEqual([400, 100, 600, 300]);
    vi.stubGlobal('fetch', answer({ bubbles: [{ bbox_2d: [100, 1200, 300, 1400], text: 'HI', translation: 'SALUT' }] }));
    const px = await visionTranslate('data:image/jpeg;base64,', 'en', 'fr', undefined, nvidia, { width: 1000, height: 2000 });
    expect(px.bubbles[0].box).toEqual([600, 100, 700, 300]);
  });
});

describe('listModels', () => {
  it('lists the models of the key, sorted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'z/model' }, { id: 'a/vl-model' }] }), { status: 200 })));
    expect(await listModels(nvidia)).toEqual(['a/vl-model', 'z/model']);
  });
  it('explains a refused call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(listModels(nvidia)).rejects.toThrow(/iPhone app/);
  });
});
