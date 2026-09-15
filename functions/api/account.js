export async function onRequestGet(context) {
  const apiKey = context.env?.SERPAPI_API_KEY;
  if (!apiKey) return json({ ok: false, error: 'SERPAPI_API_KEY non configurata.' }, 500);
  try {
    const url = new URL('https://serpapi.com/account.json');
    url.searchParams.set('api_key', apiKey);
    const r = await fetch(url.toString(), { headers: { 'User-Agent': 'Travel-Finder-Italia/2.0' } });
    const data = await r.json();
    if (!r.ok || data?.error) return json({ ok: false, error: data?.error || `HTTP ${r.status}` }, r.status || 502);
    return json({
      ok: true,
      searchesPerMonth: Number(data.searches_per_month || 0),
      searchesLeft: Number(data.total_searches_left ?? data.plan_searches_left ?? 0),
      usage: Number(data.this_month_usage || 0),
      hourlyLimit: Number(data.account_rate_limit_per_hour || 0),
      hourUsage: Number(data.this_hour_searches || 0),
      hourRemaining: Math.max(0, Number(data.account_rate_limit_per_hour || 0) - Number(data.this_hour_searches || 0))
    });
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err || 'Errore di rete.') }, 502);
  }
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
