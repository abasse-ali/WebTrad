import { afterEach, describe, expect, it, vi } from 'vitest';
import { fatalReason, knownLimit, learnLimit, listModels, paceRequest, parseJsonAnswer, visionTranslate } from '../src/lib/translate/llm';

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

describe('rate limits and sound effects', () => {
  it('waits until the reset time given by OpenRouter', async () => {
    const { rateLimitWait } = await import('../src/lib/translate/llm');
    const now = 1_794_711_100_000;
    const body = '{"error":{"code":429,"metadata":{"headers":{"X-RateLimit-Limit":"20","X-RateLimit-Remaining":"0","X-RateLimit-Reset":"1794711120000"}}}}';
    expect(rateLimitWait(body, now)).toBe(21_000);
    expect(rateLimitWait('{"error":"slow down"}', now)).toBe(20_000);
    expect(rateLimitWait('"X-RateLimit-Reset":"1794711100"', now)).toBe(2_000);
  });

  it('drops sound effects the model tags', async () => {
    vi.stubGlobal('fetch', answer({ bubbles: [
      { box_2d: [10, 10, 50, 50], kind: 'sfx', text: 'HUFF', translation: 'HAN' },
      { box_2d: [60, 10, 90, 50], kind: 'dialogue', text: 'HI', translation: 'SALUT' },
    ] }));
    const out = await visionTranslate('data:image/jpeg;base64,', 'en', 'fr', undefined, gemini);
    expect(out.bubbles.map((b) => b.translation)).toEqual(['SALUT']);
  });

  it('recognises drawn sound effects', async () => {
    const { isSoundEffect } = await import('../src/lib/text');
    for (const t of ['HUFF', 'HUFF HUFF', 'TWITCH!', 'SPUUURT', 'slap slap', 'SWOOSH', 'GRIP']) expect(isSoundEffect(t)).toBe(true);
    for (const t of ['HI!', 'WEAPON SHOP', 'I WAS LOOKING FOR YOU.', 'FUCK...', 'HNGH!', 'WANTED']) expect(isSoundEffect(t)).toBe(false);
  });
});

describe('parseJsonAnswer on a cut answer', () => {
  it('keeps the complete items', () => {
    const cut = '{"source_language":"en","bubbles":[{"box_2d":[1,2,3,4],"text":"Hi","translation":"Salut"},{"box_2d":[5,6,7,8],"text":"Bye","transl';
    expect(parseJsonAnswer<{ bubbles: unknown[] }>(cut).bubbles).toEqual([{ box_2d: [1, 2, 3, 4], text: 'Hi', translation: 'Salut' }]);
  });
});

describe('fatalReason', () => {
  it('stops on refusals no new try can fix', () => {
    expect(fatalReason(429, '{"error":{"message":"Rate limit exceeded: free-models-per-day-high-balance."}}')).toMatch(/jour/);
    expect(fatalReason(429, '{"error":{"message":"Rate limit exceeded: free-models-per-min."}}')).toBeUndefined();
    expect(fatalReason(401, '{"error":{"message":"No cookie auth credentials found"}}')).toMatch(/Clé API/);
    expect(fatalReason(404, '{"error":{"message":"This model is unavailable for free."}}')).toMatch(/modèle/);
    expect(fatalReason(403, '{"error":{"message":"This model is not available in your region."}}')).toMatch(/région/);
    expect(fatalReason(502, 'Bad Gateway')).toBeUndefined();
  });
});

describe('paceRequest', () => {
  it('spaces requests under a limit learnt from a refusal', async () => {
    vi.useFakeTimers();
    const host = 'pace.test';
    for (let i = 0; i < 10; i++) await paceRequest(host);
    learnLimit(host);
    // 10 requests in the minute: limited to 8 from now on, so the next waits.
    let started = false;
    const next = paceRequest(host).then(() => (started = true));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(31_000);
    await next;
    expect(started).toBe(true);
    vi.useRealTimers();
  });

  it('never learns a limit under 8 per minute, spaces requests evenly, lifts it slowly', async () => {
    vi.useFakeTimers();
    const host = 'pace-grow.test';
    for (let i = 0; i < 3; i++) await paceRequest(host);
    learnLimit(host);
    // 3 seen, but the floor is 8: one every 7.5 s, not five at once.
    let started = false;
    const next = paceRequest(host).then(() => (started = true));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await next;
    // Twenty quiet minutes: one more a minute every two minutes, so 18 a
    // minute, a request every 3.4 s.
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) {
      const p = paceRequest(host);
      await vi.advanceTimersByTimeAsync(4_000);
      await p;
    }
    expect(Date.now() - t0).toBeLessThanOrEqual(12_100);
    vi.useRealTimers();
  });
});

describe('rate limits and damaged answers (Family with Benefits, chapters 1 and 3)', () => {
  it('spaces NVIDIA requests under its limit from the start', () => {
    expect(knownLimit('integrate.api.nvidia.com')).toBe(30);
    expect(knownLimit('openrouter.ai')).toBeUndefined();
  });

  it('falls at once to what the provider answered in the last minute', async () => {
    vi.useFakeTimers();
    const host = 'pace-sink.test';
    for (let i = 0; i < 25; i++) await paceRequest(host);
    learnLimit(host); // 25 seen: 20 a minute
    await vi.advanceTimersByTimeAsync(61_000);
    for (let i = 0; i < 8; i++) {
      const p = paceRequest(host);
      await vi.advanceTimersByTimeAsync(3_000);
      await p;
    }
    learnLimit(host); // refused at 8 in the minute, under 20: now 7 a minute
    // 8 already in the minute: the next waits for the first to leave it.
    let started = false;
    const next = paceRequest(host).then(() => (started = true));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    await next;
    vi.useRealTimers();
  });

  it('goes under 8 a minute when refused though spaced, never under 5', async () => {
    vi.useFakeTimers();
    const host = 'pace-floor.test';
    for (let i = 0; i < 3; i++) await paceRequest(host);
    learnLimit(host); // 8 a minute
    for (let k = 0; k < 5; k++) learnLimit(host); // refused again and again under it
    // 5 a minute: a request every 12 s.
    await vi.advanceTimersByTimeAsync(60_000);
    await paceRequest(host);
    let started = false;
    const next = paceRequest(host).then(() => (started = true));
    await vi.advanceTimersByTimeAsync(11_000);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    await next;
    vi.useRealTimers();
  });

  it('reads a translation answer with bare quotes inside a text', () => {
    const answer = '{"translations":[{"id":1,"text":"Dis "salut" !"},{"id":2,"text":"Ok."}]}';
    const parsed = parseJsonAnswer<{ translations: { id: number; text: string }[] }>(answer);
    expect(parsed.translations.map((t) => t.text)).toEqual(['Dis "salut" !', 'Ok.']);
  });

  it('salvages the complete translations of a cut answer', () => {
    const answer = '{"translations":[{"id":1,"text":"Bonjour."},{"id":2,"text":"Je suis ren';
    const parsed = parseJsonAnswer<{ translations: { id: number; text: string }[] }>(answer);
    expect(parsed.translations).toEqual([{ id: 1, text: 'Bonjour.' }]);
  });
});
