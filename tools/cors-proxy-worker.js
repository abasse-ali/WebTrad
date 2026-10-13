/**
 * Minimal CORS proxy for WebTrad's "import from links" feature.
 * Free to host on Cloudflare Workers (100 000 requests/day on the free plan):
 *
 *   1. https://dash.cloudflare.com → Workers & Pages → Create → "Hello World" worker
 *   2. Replace the code with this file, deploy.
 *   3. In WebTrad → Settings → CORS proxy, enter:
 *        https://<your-worker>.workers.dev/?url={url}&referer={referer}
 *
 * Optional: set the ALLOWED_ORIGINS variable (comma separated, e.g.
 * "https://you.github.io") so only your copy of WebTrad can use the proxy.
 *
 * Some image hosts refuse requests without the right Referer header
 * (e.g. Naver Webtoon): WebTrad sends the chapter page as `referer`.
 */
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(origin)) {
      return new Response('Origin not allowed', { status: 403 });
    }
    const cors = {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

    const params = new URL(request.url).searchParams;
    const target = params.get('url');
    if (!target || !/^https?:\/\//i.test(target)) {
      return new Response('Usage: ?url=<encoded url>&referer=<encoded url>', { status: 400, headers: cors });
    }
    const referer = params.get('referer') || target;
    const upstream = await fetch(target, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: request.headers.get('Accept') || '*/*',
        'Accept-Language': request.headers.get('Accept-Language') || 'en',
        Referer: referer,
      },
      redirect: 'follow',
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    const headers = new Headers(cors);
    for (const h of ['Content-Type', 'Content-Length', 'Cache-Control', 'Last-Modified', 'ETag']) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
