export async function onRequestGet(context) {
  const apiKey = context.env?.SERPAPI_API_KEY;
  if (!apiKey) return json({ ok: false, error: 'SERPAPI_API_KEY non configurata su Cloudflare Pages. Vai in Settings → Variables and Secrets e aggiungi la secret con questo nome esatto.' }, 500);
  try {
    const u = new URL('https://serpapi.com/account.json');
    u.searchParams.set('api_key', apiKey);
    const r = await fetch(u.toString(), { headers: { 'User-Agent': 'Travel-Finder-Italia/2.1' } });
    const data = await r.json().catch(() => null);
    if (!r.ok || data?.error) return json({ ok: false, error: data?.error || `SerpAPI account HTTP ${r.status}` }, 502);
    return json({ ok: true, service: 'serpapi', plan: data.plan_name || '', searchesPerMonth: Number(data.searches_per_month || 0), searchesLeft: Number(data.total_searches_left ?? data.plan_searches_left ?? 0), hourlyLimit: Number(data.account_rate_limit_per_hour || 0) });
  } catch (e) {
    return json({ ok: false, error: `Connessione a SerpAPI fallita: ${e?.message || e}` }, 502);
  }
}
function json(data, status=200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
}
