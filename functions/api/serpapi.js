export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const startRaw = Number.parseInt(url.searchParams.get('start') || '0', 10);
  const start = Number.isFinite(startRaw) && startRaw >= 0 ? Math.min(startRaw, 100) : 0;

  if (!q) {
    return json({ ok: false, error: 'Parametro q mancante.' }, 400);
  }

  const apiKey = context.env?.SERPAPI_API_KEY;
  if (!apiKey) {
    return json({ ok: false, error: 'SERPAPI_API_KEY non configurata su Cloudflare.' }, 500);
  }

  const cacheKeyUrl = new URL(context.request.url);
  cacheKeyUrl.searchParams.delete('cache_bust');
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: 'GET' });

  try {
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.json();
      return json({ ...body, cached: true });
    }
  } catch (_) {
    // Cache API non disponibile/temporaneamente non disponibile: continuiamo.
  }

  const serpUrl = new URL('https://serpapi.com/search.json');
  serpUrl.searchParams.set('engine', 'google_maps');
  serpUrl.searchParams.set('q', q);
  serpUrl.searchParams.set('type', 'search');
  serpUrl.searchParams.set('hl', 'it');
  serpUrl.searchParams.set('gl', 'it');
  serpUrl.searchParams.set('start', String(start));
  // no_cache=false lascia utilizzare la cache SerpAPI: le ricerche cached sono gratuite e non consumano la quota.
  serpUrl.searchParams.set('no_cache', 'false');
  serpUrl.searchParams.set('api_key', apiKey);

  const t0 = Date.now();
  try {
    const response = await fetch(serpUrl.toString(), {
      headers: { 'User-Agent': 'Travel-Finder-Italia/2.0' },
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) {}

    if (!response.ok || data?.error) {
      const msg = data?.error || `SerpAPI HTTP ${response.status}`;
      return json({ ok: false, error: msg, status: response.status }, response.status >= 400 && response.status < 600 ? response.status : 502);
    }

    const payload = {
      ok: true,
      cached: false,
      ms: Date.now() - t0,
      start,
      local_results: data.local_results || [],
      serpapi_pagination: data.serpapi_pagination || null,
      search_metadata: {
        id: data.search_metadata?.id || '',
        status: data.search_metadata?.status || ''
      }
    };

    try {
      const responseToCache = new Response(JSON.stringify(payload), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=3600, s-maxage=3600'
        }
      });
      context.waitUntil(caches.default.put(cacheKey, responseToCache.clone()));
    } catch (_) {}

    return json(payload, 200, {
      'cache-control': 'public, max-age=3600, s-maxage=3600'
    });
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err || 'Errore di rete.') }, 502);
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders
    }
  });
}
