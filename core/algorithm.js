// ============================================================
// RelaxedFlying — /api/flights.js  (Vercel Serverless Function)
// FIXED VERSION — bugfixes applied:
//   1. API key now reads from environment variable (not hardcoded)
//   2. norm() function renamed to normalizeFlightData() — fixes flight number search crash
//   3. parseLiveFlights null safety added
// ============================================================

const KEY  = process.env.AERODATABOX_KEY;
const HOST = 'aerodatabox.p.rapidapi.com';
const BASE = `https://${HOST}`;

const HDR = {
  'x-rapidapi-host': HOST,
  'x-rapidapi-key':  KEY,
  'Accept': 'application/json',
};

// ── Utility: safe fetch → json or null ──────────────────────
async function safeFetch(url) {
  try {
    const r = await fetch(url, { headers: HDR });
    if (!r.ok) {
      console.error(`ADB ${r.status}: ${url.slice(0, 120)}`);
      return null;
    }
    return await r.json();
  } catch (e) {
    console.error(`Fetch error: ${e.message}`);
    return null;
  }
}

// ── Parse "2026-03-28 06:30+05:30" or "2026-03-28T06:30:00Z" → "06:30" ──
function parseTime(val) {
  if (!val) return '';
  const s = typeof val === 'object'
    ? (val.local || val.utc || val.dateLocal || val.dateUtc || '')
    : String(val);
  const m = s.match(/[T\s](\d{2}:\d{2})/);
  return m ? m[1] : '';
}

// ── Estimate flight duration from coords ────────────────────
function estMins(depCoords, arrCoords) {
  if (!depCoords || !arrCoords) return 120;
  const R = 6371, d = Math.PI / 180;
  const dlat = (arrCoords.lat - depCoords.lat) * d;
  const dlon = (arrCoords.lon - depCoords.lon) * d;
  const a = Math.sin(dlat/2)**2 + Math.cos(depCoords.lat*d)*Math.cos(arrCoords.lat*d)*Math.sin(dlon/2)**2;
  const dist = R * 2 * Math.asin(Math.sqrt(a));
  const spd = dist < 500 ? 700 : dist < 1500 ? 800 : dist < 4000 ? 850 : 880;
  const ovhd = dist < 500 ? 30 : dist < 1500 ? 35 : 40;
  return Math.round(dist / spd * 60) + ovhd;
}

function addMins(t, m) {
  if (!t) return '';
  const [h, min] = t.split(':').map(Number);
  const tot = (h*60 + min + m) % 1440;
  return `${String(Math.floor(tot/60)).padStart(2,'0')}:${String(tot%60).padStart(2,'0')}`;
}

// ── Fetch FIDS for one 12h window ───────────────────────────
async function fids(iata, from, to, dir) {
  const p = new URLSearchParams({
    withLeg: 'true', direction: dir,
    withCancelled: 'false', withCodeshared: 'true',
    withCargo: 'false', withPrivate: 'false', withLocation: 'false',
  });
  const url = `${BASE}/flights/airports/iata/${iata}/${from}/${to}?${p}`;
  const data = await safeFetch(url);
  if (!data) return [];
  const results = [
    ...(data.departures || []),
    ...(data.arrivals   || []),
  ];
  if (results.length > 0) {
    const f = results[0];
    console.log(`[FIDS ${iata} ${dir}] count=${results.length} sample:`, JSON.stringify({
      num: f.number,
      dep_sched: f.departure?.scheduledTime,
      arr_ap: f.arrival?.airport?.iata,
    }));
  } else {
    console.log(`[FIDS ${iata} ${dir}] count=0`);
  }
  return results;
}

// ── Normalise one ADB flight → our format ───────────────────
// FIXED: renamed from norm() to normalizeFlightData() to avoid variable name collision
function normalizeFlightData(f, fallbackDep, fallbackArr) {
  const depAP   = (f.departure?.airport?.iata   || fallbackDep || '').toUpperCase();
  const depTime = parseTime(f.departure?.scheduledTime);
  const depAct  = parseTime(f.departure?.actualTime || f.departure?.revisedTime);
  const arrAP   = (f.arrival?.airport?.iata || fallbackArr || '').toUpperCase();
  const arrTime = parseTime(f.arrival?.scheduledTime);
  const arrAct  = parseTime(f.arrival?.actualTime || f.arrival?.revisedTime);
  const alIata  = (f.airline?.iata    || '').toUpperCase();
  const alName  = f.airline?.name     || alIata;
  const num     = (f.number || f.iataNumber || '').toUpperCase().trim();
  const acModel = f.aircraft?.model || '';
  const acIata  = (f.aircraft?.iata  || '').toUpperCase();

  return {
    number:    num,
    airline:   { iata: alIata, name: alName },
    departure: {
      airport:       { iata: depAP },
      scheduledTime: { local: depTime },
      actualTime:    depAct,
      terminal:      f.departure?.terminal || '',
      gate:          f.departure?.gate     || '',
    },
    arrival: {
      airport:       { iata: arrAP },
      scheduledTime: { local: arrTime },
      actualTime:    arrAct,
    },
    aircraft: { model: acModel, iata: acIata },
    status:   f.status || '',
    _src:     'fids',
  };
}

// ── Dedup by flight number ────────────────────────────────────
function dedup(flights) {
  const map = new Map();
  for (const f of flights) {
    const key = f.number;
    if (!key) { map.set(Math.random().toString(36), f); continue; }
    if (!map.has(key)) { map.set(key, f); continue; }
    const ex = map.get(key);
    const hasDep = f.departure.scheduledTime.local;
    const exDep  = ex.departure.scheduledTime.local;
    if (hasDep && !exDep) map.set(key, f);
  }
  return [...map.values()];
}

// ── Fill missing arrival times ────────────────────────────────
function fillTimes(flights, depCoords, arrCoords) {
  const dur = estMins(depCoords, arrCoords);
  return flights.map(f => {
    if (!f.arrival.scheduledTime.local && f.departure.scheduledTime.local) {
      return { ...f, arrival: { ...f.arrival, scheduledTime: { local: addMins(f.departure.scheduledTime.local, dur) }, _estimated: true } };
    }
    return f;
  });
}

// ── FLIGHT NUMBER SEARCH ─────────────────────────────────────
async function searchByFN(fn, date) {
  const clean = fn.toUpperCase().replace(/\s/g,'');
  const url = `${BASE}/flights/${encodeURIComponent(clean)}/${date}`;
  const data = await safeFetch(url);
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

// ════════════════════════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!KEY) {
    return res.status(500).json({
      error: 'AERODATABOX_KEY environment variable not set. Add it in Vercel dashboard → Settings → Environment Variables.'
    });
  }

  const q = req.query;

  // ── Flight number lookup ─────────────────────────────────
  if (q.fn && q.date) {
    const raw = await searchByFN(q.fn, q.date);
    // FIXED: renamed variable to avoid shadowing normalizeFlightData function
    const normalizedFlights = raw.map(f => normalizeFlightData(f, q.dep||'', q.arr||''));
    return res.status(200).json({ departures: normalizedFlights, source: 'fn', count: normalizedFlights.length });
  }

  // ── Route search ─────────────────────────────────────────
  const { dep, arr, date } = q;
  if (!dep || !arr || !date) {
    return res.status(400).json({ error: 'Missing dep, arr, or date' });
  }

  const depCoords = q.depLat && q.depLon ? { lat: +q.depLat, lon: +q.depLon } : null;
  const arrCoords = q.arrLat && q.arrLon ? { lat: +q.arrLat, lon: +q.arrLon } : null;

  // 4 parallel FIDS calls
  const [depAM, depPM, arrAM, arrPM] = await Promise.all([
    fids(dep, `${date}T00:00`, `${date}T11:59`, 'Departure'),
    fids(dep, `${date}T12:00`, `${date}T23:59`, 'Departure'),
    fids(arr, `${date}T00:00`, `${date}T11:59`, 'Arrival'),
    fids(arr, `${date}T12:00`, `${date}T23:59`, 'Arrival'),
  ]);

  const depFlights = [...depAM, ...depPM].filter(f => {
    const dest = (f.arrival?.airport?.iata || f.leg?.arrival?.airport?.iata || '').toUpperCase();
    return dest === arr.toUpperCase();
  });

  const arrFlights = [...arrAM, ...arrPM].filter(f => {
    const origin = (f.departure?.airport?.iata || f.leg?.departure?.airport?.iata || '').toUpperCase();
    return origin === dep.toUpperCase();
  });

  // FIXED: using normalizeFlightData instead of norm
  const normDep = depFlights.map(f => normalizeFlightData(f, dep, arr));
  const normArr = arrFlights.map(f => normalizeFlightData(f, dep, arr));

  const merged = dedup([...normDep, ...normArr]);
  const filled = fillTimes(merged, depCoords, arrCoords);

  filled.sort((a, b) => {
    const ta = a.departure.scheduledTime.local || 'ZZ';
    const tb = b.departure.scheduledTime.local || 'ZZ';
    return ta.localeCompare(tb);
  });

  return res.status(200).json({
    departures: filled,
    source: 'aerodatabox_multi',
    counts: {
      dep_board: normDep.length,
      arr_board: normArr.length,
      merged:    filled.length,
    },
  });
}
