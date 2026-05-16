/* =====================================================================
 * Glance Dashboard — new tab page
 * Data sources (all free, no API key required):
 *   - Location  : navigator.geolocation
 *   - Geocode   : nominatim.openstreetmap.org (lat/lon → 시/구/동, Korean)
 *   - Weather   : weather.naver.com (KMA 기상청 data, scraped from page)
 *   - Air       : weather.naver.com (AirKorea 에어코리아 KHAI, in same page)
 *   - KOSPI     : query1.finance.yahoo.com (Yahoo Finance v8 chart)
 *   - FX rates  : open.er-api.com
 * ===================================================================== */

const REFRESH_MS = 5 * 60 * 1000; // auto-refresh data every 5 minutes
let refreshTimer = null;

/* ----------------------- helpers ----------------------- */

const $ = (id) => document.getElementById(id);

const fmt = {
  num: (v, digits = 2) =>
    typeof v === 'number' && !Number.isNaN(v)
      ? v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
      : '—',
  int: (v) =>
    typeof v === 'number' && !Number.isNaN(v) ? Math.round(v).toLocaleString('en-US') : '—',
  pct: (v) => (typeof v === 'number' && !Number.isNaN(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—'),
  signed: (v, digits = 2) =>
    typeof v === 'number' && !Number.isNaN(v)
      ? `${v >= 0 ? '+' : ''}${v.toLocaleString('en-US', {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })}`
      : '—',
};

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

function setStatus(id, text, ok = true) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? '' : 'var(--red)';
}

function setError(cardId, statusId, msg) {
  const card = $(cardId);
  if (card) card.classList.add('error');
  setStatus(statusId, msg, false);
}

/* ----------------------- clock ----------------------- */

function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  $('time').textContent = `${hh}:${mm}:${ss}`;

  $('date').textContent = now.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

setInterval(updateClock, 1000);
updateClock();

/* ----------------------- location ----------------------- */

// Get browser geolocation. Resolves to { lat, lon } or null if denied/unavailable.
function getBrowserCoords() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (err) => {
        console.warn('geolocation:', err.message);
        resolve(null);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 30 * 60 * 1000 },
    );
  });
}

// Reverse geocode lat/lon → Korean address parts via Nominatim.
// Returns { city, gu, dong } or null.
async function reverseGeocodeKorean(lat, lon) {
  const url =
    `https://nominatim.openstreetmap.org/reverse` +
    `?lat=${lat}&lon=${lon}&format=json&accept-language=ko&zoom=18`;
  const data = await fetchJson(url, { headers: { Accept: 'application/json' } });
  const a = data?.address || {};
  if (a.country_code !== 'kr') return null;
  return {
    city: a.city || a.province || a.state || '',           // 서울특별시 / 부산광역시 / 경기도
    gu:   a.borough || a.city_district || a.county || '',  // 강남구 / 해운대구
    dong: a.suburb || a.quarter || a.neighbourhood || '',  // 자양2동 / 중1동
  };
}

// Resolve Naver weather regionCode from a Korean (gu, dong) pair.
// Naver search returns multiple matches; pick the best one.
async function resolveNaverRegionCode({ city, gu, dong }) {
  const keyword = [gu, dong].filter(Boolean).join(' ').trim();
  if (!keyword) return null;
  const url = `https://weather.naver.com/search/api/searchRegion?keyword=${encodeURIComponent(keyword)}`;
  const data = await fetchJson(url, {
    headers: { Accept: 'application/json', Referer: 'https://weather.naver.com/today' },
  });
  const list = data?.keywordSearchResultList || [];
  if (list.length === 0) return null;

  // Prefer exact match on city + gu + dong, then gu + dong, then first result.
  const norm = (s) => (s || '').replace(/\s+/g, '');
  const exact = list.find((r) =>
    norm(r.lareaName) === norm(city) && norm(r.mareaName) === norm(gu) && norm(r.sareaName) === norm(dong));
  if (exact) return exact;
  const guDong = list.find((r) =>
    norm(r.mareaName) === norm(gu) && norm(r.sareaName) === norm(dong));
  return guDong || list[0];
}

const REGION_CACHE_KEY = 'glance.naverRegion.v1';

// Returns { regionCode, label } where label is "시 구 동" (or "—" if unresolved).
async function getNaverRegion() {
  // Try cached resolution first (keyed by rounded coords ~100m).
  const coords = await getBrowserCoords();
  const cacheKey = coords ? `${coords.lat.toFixed(3)},${coords.lon.toFixed(3)}` : 'ip';
  try {
    const raw = localStorage.getItem(REGION_CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached.key === cacheKey && cached.regionCode) return cached;
    }
  } catch (_) { /* ignore malformed cache */ }

  if (!coords) return { key: 'ip', regionCode: null, label: '' };  // Naver will IP-resolve

  try {
    const addr = await reverseGeocodeKorean(coords.lat, coords.lon);
    if (!addr) throw new Error('not in Korea');
    const region = await resolveNaverRegionCode(addr);
    if (!region) throw new Error('no Naver region match');
    const label = `${region.lareaName} ${region.mareaName} ${region.sareaName}`;
    const result = { key: cacheKey, regionCode: region.regionCode, label };
    try { localStorage.setItem(REGION_CACHE_KEY, JSON.stringify(result)); } catch (_) {}
    return result;
  } catch (err) {
    console.warn('region resolve failed, falling back to Naver IP default:', err);
    return { key: cacheKey, regionCode: null, label: '' };
  }
}

function paintLocation(label) {
  $('location-text').textContent = label || 'Naver IP default';
}

/* --------- Naver weather page fetch + parse --------- */

// Maps Korean weather text (wetrTxt from KMA via Naver) to an emoji.
function naverWeatherEmoji(wetrTxt = '') {
  if (wetrTxt.includes('천둥') || wetrTxt.includes('번개')) return '⛈️';
  if (wetrTxt.includes('소나기')) return '🌦️';
  if (wetrTxt.includes('비/눈') || wetrTxt.includes('진눈깨비')) return '🌨️';
  if (wetrTxt.includes('눈')) return '❄️';
  if (wetrTxt.includes('비')) return '🌧️';
  if (wetrTxt.includes('안개')) return '🌫️';
  if (wetrTxt.includes('흐림')) return '☁️';
  if (wetrTxt.includes('구름많음')) return '⛅';
  if (wetrTxt.includes('구름조금')) return '🌤️';
  if (wetrTxt.includes('맑음')) return '☀️';
  return '🌡️';
}

// Fetch /today/{regionCode} HTML and parse the embedded `var blockApiResult = {...}`.
async function fetchNaverWeather(regionCode) {
  const path = regionCode ? `/today/${regionCode}` : '/today';
  const res = await fetch(`https://weather.naver.com${path}`, {
    credentials: 'omit',
    headers: { 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });
  if (!res.ok) throw new Error(`naver HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/var\s+blockApiResult\s*=\s*({[\s\S]*?});\s*<\/script>/)
        || html.match(/var\s+blockApiResult\s*=\s*({[\s\S]*?});\s*var\s/);
  if (!m) throw new Error('blockApiResult not found');
  const data = JSON.parse(m[1]);
  return data?.results?.choiceResult || {};
}

let lastNaverData = null;  // share between loadWeather and loadAir

async function loadNaverData(regionCode) {
  lastNaverData = await fetchNaverWeather(regionCode);
  return lastNaverData;
}

/* ----------------------- weather ----------------------- */

async function loadWeather() {
  setStatus('weather-status', 'loading');
  try {
    const cr = lastNaverData;
    const nf = cr?.['nowSynthesisFcast~~1']?.nowFcast || cr?.['talkHeader~~1']?.nowFcastInfo;
    if (!nf) throw new Error('no nowFcast');

    const tmpr     = nf.tmpr;
    const stmpr    = nf.stmpr ?? nf.tmpr;
    const humd     = nf.humd;
    const windMs   = nf.windSpd;                  // m/s
    const windKmh  = windMs != null ? windMs * 3.6 : null;
    const wetrTxt  = nf.wetrTxt || '';

    $('weather-icon').textContent  = naverWeatherEmoji(wetrTxt);
    $('weather-desc').textContent  = wetrTxt || '—';
    $('weather-temp').textContent  = fmt.int(tmpr);
    $('weather-feels').textContent = stmpr != null ? `${fmt.int(stmpr)}°` : '—';
    $('weather-humidity').textContent = humd != null ? `${fmt.int(humd)}%` : '—';
    $('weather-wind').textContent  = windKmh != null ? `${fmt.int(windKmh)} km/h` : '—';

    setStatus('weather-status', 'KMA 기상청');
    $('weather-card').classList.remove('error');
  } catch (err) {
    console.error('weather:', err);
    setError('weather-card', 'weather-status', 'offline');
  }
}

/* ----------------------- air quality ----------------------- */

// Korean air-quality grades (4-level) → ring color + fill percentage.
// Naver/AirKorea uses: 좋음 / 보통 / 나쁨 / 매우나쁨.
function khaiVisual(khai, grade) {
  // Pick color by Korean grade text (works for both KHAI and PM grades).
  let color;
  switch (grade) {
    case '좋음':      color = '#4ade80'; break;  // green
    case '보통':      color = '#60a5fa'; break;  // blue (Naver uses blue, not yellow)
    case '나쁨':      color = '#fb923c'; break;  // orange
    case '매우나쁨':  color = '#f87171'; break;  // red
    default:          color = 'var(--text-dim)';
  }
  // KHAI scale max ~ 500; in practice 0–250 covers all real conditions, so map 250 → 100%.
  const pct = khai != null ? Math.min((khai / 250) * 100, 100) : 0;
  return { color, pct };
}

async function loadAir() {
  setStatus('air-status', 'loading');
  try {
    const cr = lastNaverData;
    const af = cr?.['nowSynthesisFcast~~1']?.airFcast;
    if (!af) throw new Error('no airFcast');

    const khai      = af.stationKhai;
    const khaiGrade = af.stationKhaiLegend1 || '';
    const pm10      = af.stationPM10;
    const pm25      = af.stationPM25;
    const station   = af.stationName || '';

    $('aqi-value').textContent = fmt.int(khai);
    $('air-desc').textContent  = station ? `${khaiGrade} · ${station} 측정소` : khaiGrade || '—';
    $('air-pm25').textContent  = pm25 != null ? `${fmt.int(pm25)} ㎍/㎥` : '—';
    $('air-pm10').textContent  = pm10 != null ? `${fmt.int(pm10)} ㎍/㎥` : '—';

    const { color, pct } = khaiVisual(khai, khaiGrade);
    const ring = $('aqi-ring');
    ring.style.setProperty('--aqi-color', color);
    ring.style.setProperty('--aqi-pct', `${pct}%`);

    setStatus('air-status', '에어코리아');
    $('air-card').classList.remove('error');
  } catch (err) {
    console.error('air:', err);
    setError('air-card', 'air-status', 'offline');
  }
}

/* ----------------------- KOSPI ----------------------- */

async function loadKospi() {
  setStatus('kospi-status', 'loading');
  try {
    // %5E = ^ ; ^KS11 is the KOSPI composite index symbol on Yahoo Finance
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?interval=1d&range=5d`;
    const data = await fetchJson(url);
    const r = data?.chart?.result?.[0];
    if (!r) throw new Error('empty result');

    const meta = r.meta || {};
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    const change = price - prev;
    const pct = (change / prev) * 100;

    // On weekends/holidays Yahoo sometimes drops regularMarketDayOpen but keeps
    // high/low. Fall back to the last non-null open from the daily series.
    const opens = r.indicators?.quote?.[0]?.open || [];
    const lastSeriesOpen = [...opens].reverse().find((v) => v != null);
    const open = meta.regularMarketDayOpen ?? meta.open ?? lastSeriesOpen;
    const high = meta.regularMarketDayHigh;
    const low  = meta.regularMarketDayLow;

    $('kospi-value').textContent = fmt.num(price, 2);
    $('kospi-open').textContent = fmt.num(open, 2);
    $('kospi-high').textContent = fmt.num(high, 2);
    $('kospi-low').textContent  = fmt.num(low, 2);

    const changeEl = $('kospi-change');
    changeEl.textContent = `${fmt.signed(change, 2)}  (${fmt.pct(pct)})`;
    changeEl.className = 'change ' + (change > 0 ? 'up' : change < 0 ? 'down' : 'neutral');

    setStatus('kospi-status', 'live');
    $('kospi-card').classList.remove('error');
  } catch (err) {
    console.error('kospi:', err);
    setError('kospi-card', 'kospi-status', 'offline');
  }
}

/* ----------------------- USD / KRW ----------------------- */

async function loadFx() {
  setStatus('fx-status', 'loading');
  try {
    const data = await fetchJson('https://open.er-api.com/v6/latest/USD');
    const rates = data?.rates || {};
    const usdKrw = rates.KRW;
    if (!usdKrw) throw new Error('no KRW rate');

    // For EUR/KRW and JPY/KRW we cross-rate via USD base.
    const eurKrw = rates.EUR ? usdKrw / rates.EUR : null;
    const jpyKrw = rates.JPY ? usdKrw / rates.JPY : null;

    $('fx-value').textContent = fmt.num(usdKrw, 2);
    $('fx-100').textContent = fmt.num(usdKrw * 100, 0) + ' ₩';
    $('fx-eur').textContent = eurKrw ? fmt.num(eurKrw, 2) : '—';
    $('fx-jpy').textContent = jpyKrw ? fmt.num(jpyKrw, 2) : '—'; // per 1 JPY

    setStatus('fx-status', 'live');
    $('fx-card').classList.remove('error');
  } catch (err) {
    console.error('fx:', err);
    setError('fx-card', 'fx-status', 'offline');
  }
}

/* ----------------------- orchestration ----------------------- */

async function refreshAll() {
  $('refresh').classList.add('spinning');
  $('last-updated').textContent = 'Refreshing…';

  // Region resolution can be slow (geolocation prompt + Nominatim) but is cached.
  // KOSPI and FX don't need it, so kick them off in parallel.
  const kospiP = loadKospi();
  const fxP    = loadFx();

  const region = await getNaverRegion();
  paintLocation(region.label);

  try {
    await loadNaverData(region.regionCode);
  } catch (err) {
    console.error('naver page fetch:', err);
    lastNaverData = null;
  }
  await Promise.allSettled([loadWeather(), loadAir(), kospiP, fxP]);

  const now = new Date();
  $('last-updated').textContent =
    `Updated ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  $('refresh').classList.remove('spinning');
}

$('refresh').addEventListener('click', refreshAll);

// Pause auto-refresh when tab is hidden, resume when visible.
function startAuto() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, REFRESH_MS);
}
function stopAuto() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAuto();
  else startAuto();
});

refreshAll().then(startAuto);
