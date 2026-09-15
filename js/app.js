const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 25000;
const MAX_CONCURRENCY = 4;
const MAX_START = 100;

const state = {
  allResults: [],
  filteredResults: [],
  seen: new Set(),
  markerById: new Map(),
  map: null,
  markers: null,
  runId: 0,
  running: false,
  completed: 0,
  total: 0,
  account: null,
  nextPaging: []
};

const $ = id => document.getElementById(id);
const cleanText = value => String(value || '').trim();
const normalize = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
function escapeHtml(value='') { return String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[ch])); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function initMap() {
  if (typeof L === 'undefined') return;
  state.map = L.map('map', { zoomControl: true }).setView([42.5, 12.5], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(state.map);
  state.markers = typeof L.markerClusterGroup === 'function'
    ? L.markerClusterGroup({ chunkedLoading: true, chunkInterval: 80, maxClusterRadius: 45, spiderfyOnMaxZoom: true })
    : L.layerGroup();
  state.markers.addTo(state.map);
}

function cacheKey(params) {
  return 'tfi-serp:' + btoa(unescape(encodeURIComponent(JSON.stringify(params)))).replace(/[^a-zA-Z0-9]/g,'').slice(0,180);
}
function readCache(params) {
  try {
    const raw = localStorage.getItem(cacheKey(params));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || Date.now() - obj.ts > CACHE_TTL_MS) return null;
    return obj.data || null;
  } catch { return null; }
}
function writeCache(params, data) {
  try {
    const raw = JSON.stringify({ ts: Date.now(), data });
    if (raw.length < 4_500_000) localStorage.setItem(cacheKey(params), raw);
  } catch {}
}

function queryText({ type, region, province, city, keyword }) {
  const parts = [];
  if (type === 'agency') parts.push('agenzie di viaggio');
  else if (type === 'operator') parts.push('tour operator');
  else parts.push('agenzie di viaggio tour operator');
  if (keyword) parts.push(keyword);
  const place = [city, province, region].filter(Boolean);
  if (place.length) parts.push('in ' + place.join(', '));
  else parts.push('in Italia');
  return parts.join(' ') + ' Italia';
}

function buildTasks(type, region, province, city, keyword) {
  if (city || province || region) {
    return [{ label: city || province || region, region, province, city, q: queryText({type, region, province, city, keyword}), start: 0 }];
  }
  return ITALIAN_REGIONS.map(r => ({
    label: r,
    region: r,
    province: '',
    city: '',
    q: queryText({type, region: r, province:'', city:'', keyword}),
    start: 0
  }));
}

async function fetchAccount() {
  try {
    const r = await fetch('/api/account', { cache: 'no-store' });
    const data = await r.json();
    if (data?.ok) {
      state.account = data;
      const remaining = `${data.searchesLeft}/${data.searchesPerMonth}`;
      $('quotaText').textContent = `SerpAPI: ${remaining} ricerche`;
      $('quotaText').title = `Usate questo mese: ${data.usage}. Disponibili: ${data.searchesLeft}. Limite orario: ${data.hourlyLimit}.`;
    }
    return data;
  } catch { return null; }
}

function matchesTarget(place, type) {
  const text = normalize([
    place.title, place.type, ...(place.types || []), place.description, place.category
  ].filter(Boolean).join(' '));
  const exclude = ['hotel', 'albergo', 'ristorante', 'bar ', 'autonoleggio', 'car rental', 'immobiliare', 'ostello', 'bed and breakfast', 'b&b'];
  if (exclude.some(x => text.includes(x))) return false;
  const agency = text.includes('agenzia di viaggi') || text.includes('travel agency') || text.includes('agenzia viaggi');
  const operator = text.includes('tour operator') || text.includes('tour operator');
  if (type === 'agency') return agency;
  if (type === 'operator') return operator;
  return agency || operator;
}

function resultFromPlace(place, fallbackRegion) {
  const gps = place.gps_coordinates || {};
  const lat = Number(gps.latitude), lon = Number(gps.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const nome = cleanText(place.title);
  if (!nome) return null;
  const categoryText = normalize([place.type, ...(place.types || [])].join(' '));
  const categoria = categoryText.includes('tour operator') ? 'Tour operator' : 'Agenzia di viaggio';
  return {
    id: cleanText(place.data_id || place.place_id || `${nome}|${place.address || ''}`),
    nome,
    categoria,
    regione: fallbackRegion || '',
    provincia: '',
    citta: '',
    indirizzo: cleanText(place.address),
    telefono: cleanText(place.phone),
    email: '',
    sito_web: cleanText(place.website),
    rating: place.rating ?? '',
    reviews: place.reviews ?? '',
    latitudine: lat,
    longitudine: lon,
    description: cleanText(place.description),
    googleMaps: place.data_id ? `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${encodeURIComponent(place.data_id)}` : ''
  };
}

function dedupe(rows) {
  const out = [];
  for (const r of rows) {
    const key = `${normalize(r.nome)}|${normalize(r.indirizzo)}|${r.latitudine.toFixed(5)}|${r.longitudine.toFixed(5)}`;
    if (state.seen.has(key)) continue;
    state.seen.add(key); out.push(r);
  }
  return out;
}

function popupHtml(r) {
  return [
    `<div class="popup-title">${escapeHtml(r.nome)}</div>`,
    `<div class="popup-line"><b>${escapeHtml(r.categoria)}</b>${r.rating ? ` · ⭐ ${escapeHtml(r.rating)}${r.reviews ? ` (${escapeHtml(r.reviews)})` : ''}` : ''}</div>`,
    r.indirizzo ? `<div class="popup-line">📍 ${escapeHtml(r.indirizzo)}</div>` : '',
    r.telefono ? `<div class="popup-line">☎ ${escapeHtml(r.telefono)}</div>` : '',
    r.sito_web ? `<div class="popup-line"><a href="${escapeHtml(r.sito_web)}" target="_blank" rel="noopener">🌐 Sito web</a></div>` : '',
    r.googleMaps ? `<div class="popup-line"><a href="${escapeHtml(r.googleMaps)}" target="_blank" rel="noopener">🗺️ Google Maps</a></div>` : ''
  ].join('');
}

function addMarkers(rows) {
  if (!state.markers || typeof L === 'undefined') return;
  const markers = [];
  for (const r of rows) {
    const marker = L.marker([r.latitudine, r.longitudine]).bindPopup(popupHtml(r));
    marker.on('click', () => activateCard(r.id));
    state.markerById.set(r.id, marker);
    markers.push(marker);
  }
  if (markers.length) state.markers.addLayers ? state.markers.addLayers(markers) : markers.forEach(m => state.markers.addLayer(m));
}

function cardHtml(r) {
  const website = r.sito_web ? `<a href="${escapeHtml(r.sito_web)}" target="_blank" rel="noopener">Sito</a>` : '';
  const maps = r.googleMaps ? `<a href="${escapeHtml(r.googleMaps)}" target="_blank" rel="noopener">Google Maps</a>` : '';
  return `<article class="result-card" data-id="${escapeHtml(r.id)}"><div class="result-top"><div class="result-name">${escapeHtml(r.nome)}</div><span class="badge">${escapeHtml(r.categoria)}</span></div><div class="result-meta">${r.indirizzo ? '📍 ' + escapeHtml(r.indirizzo) : '📍 Posizione disponibile'}${r.telefono ? '<br>☎ ' + escapeHtml(r.telefono) : ''}${r.rating ? '<br>⭐ ' + escapeHtml(r.rating) + (r.reviews ? ' (' + escapeHtml(r.reviews) + ')' : '') : ''}</div><div class="result-actions">${website}${maps}<a href="#" data-focus="${escapeHtml(r.id)}">Mappa</a></div></article>`;
}

function addCards(rows) {
  const container = $('results');
  const empty = container.querySelector('.empty-state, .no-results, .search-progress-card');
  if (empty) empty.remove();
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const wrapper = document.createElement('div'); wrapper.innerHTML = cardHtml(r);
    const card = wrapper.firstElementChild;
    card.addEventListener('click', e => { if (!e.target.closest('a')) activateCard(r.id); });
    card.querySelector('[data-focus]')?.addEventListener('click', e => { e.preventDefault(); activateCard(r.id); });
    frag.appendChild(card);
  }
  container.appendChild(frag);
}

function appendRows(rows) {
  const fresh = dedupe(rows);
  if (!fresh.length) return 0;
  state.allResults.push(...fresh);
  $('resultCount').textContent = state.allResults.length;
  applyFiltersAndRenderCounts();
  addMarkers(fresh);
  addCards(fresh);
  return fresh.length;
}

function applyFiltersAndRenderCounts() {
  const onlyContact = $('onlyContact').checked;
  const onlyWebsite = $('onlyWebsite').checked;
  state.filteredResults = state.allResults.filter(r => (!onlyContact || r.telefono) && (!onlyWebsite || r.sito_web));
  $('shownCount').textContent = state.filteredResults.length;
}

function activateCard(id) {
  document.querySelectorAll('.result-card').forEach(c => c.classList.toggle('active', c.dataset.id === id));
  const r = state.allResults.find(x => x.id === id);
  const marker = state.markerById.get(id);
  if (!r || !marker || !state.map) return;
  state.map.setView([r.latitudine, r.longitudine], Math.max(state.map.getZoom(), 14), { animate: true });
  marker.openPopup();
}

function setStatus(text, error=false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function setProgress(done, total, text) {
  const pct = total ? Math.round(done / total * 100) : 0;
  $('progressBar').style.width = `${pct}%`;
  $('progressCount').textContent = `${done}/${total}`;
  $('progressText').textContent = text;
}
function summary({type,region,province,city,keyword}) {
  const label = type === 'agency' ? 'Agenzie di viaggio' : type === 'operator' ? 'Tour operator' : 'Agenzie + Tour operator';
  $('querySummary').textContent = [label, region || 'Tutta Italia', province || null, city || null, keyword ? `“${keyword}”` : null].filter(Boolean).join(' • ');
}

async function searchTask(task, type, runId) {
  if (runId !== state.runId) return;
  const params = { q: task.q, start: task.start };
  const cached = readCache(params);
  let data = cached;
  if (!data) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const endpoint = `/api/serpapi?q=${encodeURIComponent(task.q)}&start=${task.start}`;
      const r = await fetch(endpoint, { signal: controller.signal, cache: 'no-store' });
      const payload = await r.json().catch(() => null);
      if (!r.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${r.status}`);
      data = payload;
      writeCache(params, data);
    } finally { clearTimeout(timer); }
  }
  if (runId !== state.runId) return;
  const places = (data.local_results || []).filter(p => matchesTarget(p, type));
  const rows = places.map(p => resultFromPlace(p, task.region)).filter(Boolean);
  const added = appendRows(rows);
  $('status').textContent = `${state.allResults.length} risultati disponibili — ricerca in corso…`;
  return { added, cached: Boolean(data.cached), next: data.serpapi_pagination?.next || null };
}

async function runQueue(tasks, type, runId) {
  let cursor = 0;
  const worker = async () => {
    while (true) {
      if (runId !== state.runId) return;
      const index = cursor++;
      if (index >= tasks.length) return;
      const task = tasks[index];
      try {
        const result = await searchTask(task, type, runId);
        if (runId !== state.runId) return;
        state.completed += 1;
        setProgress(state.completed, state.total, `${task.label}: +${result?.added || 0} risultati${result?.cached ? ' · cache' : ''}`);
      } catch (err) {
        if (runId !== state.runId) return;
        state.completed += 1;
        const message = err?.message || String(err);
        setProgress(state.completed, state.total, `${task.label}: errore`);
        setStatus(`Errore su ${task.label}: ${message}`, true);
        console.error('Travel Finder search error', task, err);
        if (!$('searchError').hidden) $('searchError').hidden = false;
        $('searchError').textContent = `Ultimo errore: ${task.label} — ${message}`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, tasks.length) }, worker));
}

async function runSearch() {
  if (state.running) return;
  const runId = ++state.runId;
  state.running = true; state.completed = 0;
  state.allResults = []; state.filteredResults = []; state.seen.clear(); state.markerById.clear();
  if (state.markers) state.markers.clearLayers();
  $('results').innerHTML = `<div class="search-progress-card"><b>Ricerca avviata.</b><br>Ogni risultato viene aggiunto appena arriva da SerpAPI.</div>`;
  $('searchError').hidden = true;
  $('searchError').textContent = '';
  $('resultCount').textContent = '0'; $('shownCount').textContent = '0';
  $('searchBtn').disabled = true; $('searchBtn').textContent = '⏳ Ricerca in corso…';
  $('progressWrap').hidden = false;

  const type = $('activityType').value;
  const region = cleanText($('region').value), province = cleanText($('province').value), city = cleanText($('city').value), keyword = cleanText($('keyword').value);
  summary({ type, region, province, city, keyword });

  const tasks = buildTasks(type, region, province, city, keyword);
  const health = await fetch('/api/health', { cache: 'no-store' }).then(r => r.json().catch(() => null)).catch(() => null);
  if (!health?.ok) {
    state.running = false; $('searchBtn').disabled = false; $('searchBtn').textContent = '🔎 Cerca';
    $('searchError').hidden = false;
    $('searchError').textContent = health?.error || 'Il backend /api/health non risponde. Controlla che la cartella functions/ sia stata pubblicata da Cloudflare Pages.';
    setStatus('Backend SerpAPI non configurato o non raggiungibile.', true);
    return;
  }
  const account = await fetchAccount();
  const availableMonthly = account?.searchesLeft ?? tasks.length;
  const availableHour = account?.hourRemaining ?? tasks.length;
  const allowed = Math.max(0, Math.min(tasks.length, availableMonthly, availableHour));
  const selectedTasks = tasks.slice(0, allowed);
  state.total = selectedTasks.length;

  if (!selectedTasks.length) {
    state.running = false; $('searchBtn').disabled = false; $('searchBtn').textContent = '🔎 Cerca';
    setProgress(0, 0, 'Nessuna richiesta disponibile');
    setStatus('Quota SerpAPI esaurita o limite orario raggiunto.', true);
    return;
  }

  const limited = selectedTasks.length < tasks.length;
  if (limited) {
    setStatus(`Avvio di ${selectedTasks.length} ricerche su ${tasks.length}: quota/limite orario insufficiente per completarle tutte.`);
  } else {
    setStatus(`${selectedTasks.length} ricerche in coda. Risultati progressivi in arrivo.`);
  }
  setProgress(0, state.total, 'Avvio…');
  await runQueue(selectedTasks, type, runId);
  if (runId !== state.runId) return;
  state.running = false; $('searchBtn').disabled = false; $('searchBtn').textContent = '🔎 Cerca';
  setProgress(state.total, state.total, `Ricerca terminata: ${state.allResults.length} risultati`);
  setStatus(limited ? `Ricerca parziale completata: ${state.allResults.length} risultati.` : `Ricerca completata: ${state.allResults.length} risultati.`);
  fetchAccount();
}

function resetFilters() {
  ++state.runId; state.running = false;
  $('activityType').value='all'; $('region').value=''; $('province').value=''; $('city').value=''; $('keyword').value='';
  $('onlyContact').checked=false; $('onlyWebsite').checked=false;
  state.allResults=[]; state.filteredResults=[]; state.seen.clear(); state.markerById.clear();
  if (state.markers) state.markers.clearLayers();
  $('resultCount').textContent='0'; $('shownCount').textContent='0'; $('querySummary').textContent='Nessuna ricerca ancora eseguita';
  $('progressWrap').hidden=true; $('searchBtn').disabled=false; $('searchBtn').textContent='🔎 Cerca';
  $('results').innerHTML=`<div class="empty-state"><div class="empty-icon">🧭</div><h2>Trova agenzie e tour operator</h2><p>Imposta i filtri e premi <b>Cerca</b>. La ricerca usa SerpAPI / Google Maps e mostra i risultati progressivamente.</p></div>`;
  setStatus('Pronto per una nuova ricerca.');
  if (state.map) state.map.setView([42.5,12.5],6);
}

function exportRows() {
  applyFiltersAndRenderCounts();
  return state.filteredResults.map(r => ({
    Nome:r.nome, Categoria:r.categoria, Regione:r.regione, Provincia:r.provincia, Comune:r.citta,
    Indirizzo:r.indirizzo, Telefono:r.telefono, Email:r.email, Sito:r.sito_web, Rating:r.rating, Recensioni:r.reviews,
    Latitudine:r.latitudine, Longitudine:r.longitudine, GoogleMaps:r.googleMaps
  }));
}
function toCsv(rows) {
  if (!rows.length) return '';
  const headers=Object.keys(rows[0]); const q=v=>`"${String(v??'').replace(/"/g,'""')}"`;
  return [headers.map(q).join(';'),...rows.map(r=>headers.map(h=>q(r[h])).join(';'))].join('\r\n');
}
function downloadText(filename,text,mime) { const blob=new Blob([text],{type:mime}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=filename; a.click(); setTimeout(()=>URL.revokeObjectURL(url),500); }
function exportCsv() { const rows=exportRows(); if(rows.length) downloadText(`travel-finder-italia-${Date.now()}.csv`,'\ufeff'+toCsv(rows),'text/csv;charset=utf-8'); }
function exportXlsx() { const rows=exportRows(); if(!rows.length) return; if(typeof XLSX==='undefined') return alert('Excel non disponibile: usa CSV.'); const ws=XLSX.utils.json_to_sheet(rows); const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'Risultati'); XLSX.writeFile(wb,`travel-finder-italia-${Date.now()}.xlsx`); }

function init() {
  initMap();
  if (typeof ITALIAN_REGIONS !== 'undefined') ITALIAN_REGIONS.forEach(r => { const o=document.createElement('option'); o.value=r; o.textContent=r; $('region').appendChild(o); });
  $('searchBtn').addEventListener('click', runSearch);
  $('clearBtn').addEventListener('click', resetFilters);
  $('cancelSearchBtn').addEventListener('click', () => { ++state.runId; state.running=false; $('searchBtn').disabled=false; $('searchBtn').textContent='🔎 Cerca'; setProgress(state.completed,state.total,'Ricerca annullata'); setStatus(`Ricerca interrotta. ${state.allResults.length} risultati già caricati.`); });
  $('csvBtn').addEventListener('click', exportCsv); $('xlsxBtn').addEventListener('click', exportXlsx);
  $('onlyContact').addEventListener('change', applyFiltersAndRenderCounts); $('onlyWebsite').addEventListener('change', applyFiltersAndRenderCounts);
  [$('province'),$('city'),$('keyword')].forEach(i => i.addEventListener('keydown', e => { if(e.key === 'Enter') runSearch(); }));
  fetchAccount();
}
document.addEventListener('DOMContentLoaded', init);
