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
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'z/model' }, { id: 'a/vl-model' }, { id: 'nvidia/nv-embedqa-e5-v5' }] }), { status: 200 })));
    expect(await listModels(nvidia)).toEqual([
      { id: 'a/vl-model', vision: true, free: undefined },
      { id: 'z/model', vision: false, free: undefined },
    ]);
  });
  it('uses OpenRouter’s modalities and prices', async () => {
    const data = [
      { id: 'google/gemma-3-27b-it:free', architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0', completion: '0' } },
      { id: 'openai/gpt-5', architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.00001', completion: '0.00003' } },
      { id: 'meta-llama/llama-3.3-70b-instruct:free', architecture: { input_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 })));
    expect(await listModels({ ...nvidia, preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' })).toEqual([
      { id: 'google/gemma-3-27b-it:free', vision: true, free: true },
      { id: 'meta-llama/llama-3.3-70b-instruct:free', vision: false, free: true },
      { id: 'openai/gpt-5', vision: true, free: false },
    ]);
  });
  it('explains a refused call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(listModels(nvidia)).rejects.toThrow(/iPhone app/);
  });
});

describe('streamed answers', () => {
  it('puts the pieces of a streamed answer back together', async () => {
    const { parseStream } = await import('../src/lib/translate/llm');
    const sse = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"delta":{"content":"{\\"bubbles\\":"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"[]}"}}]}',
      'data: [DONE]',
    ].join('\n');
    expect(parseStream(sse).choices[0].message.content).toBe('{"bubbles":[]}');
    expect(() => parseStream('data: {"error":{"message":"rate limited"}}')).toThrow(/rate limited/);
  });

  it('reads a streamed vision answer end to end', async () => {
    const body = ['{"bubbles":[{"bbox_2d":[100,', '200,300,260],"text":"HI","translation":"SALUT"}]}']
      .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}`)
      .concat('data: [DONE]')
      .join('\n\n');
    const fetchMock = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await visionTranslate('data:image/jpeg;base64,', 'en', 'fr', undefined, nvidia);
    expect(out.bubbles[0]).toMatchObject({ box: [200, 100, 260, 300], translation: 'SALUT' });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).stream).toBe(true);
  });
});

describe('checkVisionModel', () => {
  it('says whether a model reads the test image', async () => {
    const { checkVisionModel } = await import('../src/lib/translate/llm');
    vi.stubGlobal('fetch', answerText('HELLO'));
    expect(await checkVisionModel(nvidia, 'good/vl')).toMatchObject({ model: 'good/vl', ok: true });
    vi.stubGlobal('fetch', answerText('I cannot see images'));
    expect(await checkVisionModel(nvidia, 'blind/model')).toMatchObject({ ok: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    expect((await checkVisionModel(nvidia, 'gone/model')).error).toMatch(/404/);
  });
});

function answerText(text: string) {
  return vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 }));
}
