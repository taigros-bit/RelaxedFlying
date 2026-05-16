// ============================================================
// RelaxedFlying — /api/flights  (Vercel Serverless Function)
//
// STRATEGY: Maximum flight coverage via 3 parallel sources:
// 1. FIDS Departure board DEP airport (AM + PM, 2 calls)
// 2. FIDS Arrival board ARR airport filtered to origin=DEP (AM + PM, 2 calls)
// 3. Merge + deduplicate by flight number
//
// AeroDataBox FIDS response field reference (verified):
//   departure.airport.iata       = DEP airport (e.g. "DEL")
//   departure.scheduledTime.local = dep time "2026-03-28 06:30+05:30"
//   arrival.airport.iata         = ARR airport (e.g. "DXB")
//   arrival.scheduledTime.local  = arr time
//   number                       = flight number "EK517"
//   airline.iata / airline.name
//   aircraft.model / aircraft.iata
//   status                       = "Expected" | "Departed" | "Arrived" | etc
//   terminal, gate (if available)
//
// Note: movement.airport.iata = the searched airport (always DEP for DEP search)
// Do NOT use movement.airport.iata to filter destination - use arrival.airport.iata
// ============================================================

const KEY  = 'b03cbc2da8mshfd6f5e8ac7c5894p18cc07jsnaabba528fd4a';
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
  // Log first result to debug time fields
  if (results.length > 0) {
    const f = results[0];
    console.log(`[FIDS ${iata} ${dir}] count=${results.length} sample:`, JSON.stringify({
      num: f.number,
      dep_sched: f.departure?.scheduledTime,
      dep_revised: f.departure?.revisedTime,
      dep_actual: f.departure?.actualTime,
      movement_sched: f.movement?.scheduledTime,
      arr_sched: f.arrival?.scheduledTime,
      arr_ap: f.arrival?.airport?.iata,
    }));
  } else {
    console.log(`[FIDS ${iata} ${dir}] count=0`);
  }
  return results;
}

// ── Normalise one ADB flight → our format ───────────────────
function norm(f, fallbackDep, fallbackArr) {
  // DEPARTURE fields
  const depAP   = (f.departure?.airport?.iata   || fallbackDep || '').toUpperCase();
  const depTime = parseTime(f.departure?.scheduledTime);
  const depAct  = parseTime(f.departure?.actualTime || f.departure?.revisedTime);

  // ARRIVAL fields
  const arrAP   = (f.arrival?.airport?.iata || fallbackArr || '').toUpperCase();
  const arrTime = parseTime(f.arrival?.scheduledTime);
  const arrAct  = parseTime(f.arrival?.actualTime || f.arrival?.revisedTime);

  // Airline
  const alIata  = (f.airline?.iata    || '').toUpperCase();
  const alName  = f.airline?.name     || alIata;

  // Flight number
  const num     = (f.number || f.iataNumber || '').toUpperCase().trim();

  // Aircraft
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

// ── Dedup: prefer fids over routes; prefer timed over untimed ─
function dedup(flights) {
  const map = new Map();
  for (const f of flights) {
    const key = f.number;
    if (!key) { map.set(Math.random().toString(36), f); continue; }
    if (!map.has(key)) { map.set(key, f); continue; }
    const ex = map.get(key);
    // Prefer entry with known departure time
    const hasDep = f.departure.scheduledTime.local;
    const exDep  = ex.departure.scheduledTime.local;
    if (hasDep && !exDep) map.set(key, f);
  }
  return [...map.values()];
}

// ── Fill missing arrival times using estimated duration ──────
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
  // AeroDataBox accepts both "EK517" format and "EK/517" format
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

  const q = req.query;

  // ── Flight number lookup ────────────────────────────────
  if (q.fn && q.date) {
    const raw  = await searchByFN(q.fn, q.date);
    const norm = raw.map(f => norm(f, q.dep||'', q.arr||''));
    return res.status(200).json({ departures: norm, source: 'fn', count: norm.length });
  }

  // ── Route search ─────────────────────────────────────────
  const { dep, arr, date } = q;
  if (!dep || !arr || !date) {
    return res.status(400).json({ error: 'Missing dep, arr, or date' });
  }

  const depCoords = q.depLat && q.depLon ? { lat: +q.depLat, lon: +q.depLon } : null;
  const arrCoords = q.arrLat && q.arrLon ? { lat: +q.arrLat, lon: +q.arrLon } : null;

  // Run 4 FIDS calls in parallel (DEP departures AM+PM, ARR arrivals AM+PM)
  const [depAM, depPM, arrAM, arrPM] = await Promise.all([
    fids(dep, `${date}T00:00`, `${date}T11:59`, 'Departure'),
    fids(dep, `${date}T12:00`, `${date}T23:59`, 'Departure'),
    fids(arr, `${date}T00:00`, `${date}T11:59`, 'Arrival'),
    fids(arr, `${date}T12:00`, `${date}T23:59`, 'Arrival'),
  ]);

  // --- DEP board: filter to flights going to ARR ---
  // Primary check: f.arrival.airport.iata === arr
  // Secondary: f.leg?.arrival?.airport?.iata === arr (codeshares)
  const depFlights = [...depAM, ...depPM].filter(f => {
    const dest = (f.arrival?.airport?.iata || f.leg?.arrival?.airport?.iata || '').toUpperCase();
    return dest === arr.toUpperCase();
  });

  // --- ARR board: filter to flights coming from DEP ---
  const arrFlights = [...arrAM, ...arrPM].filter(f => {
    const origin = (f.departure?.airport?.iata || f.leg?.departure?.airport?.iata || '').toUpperCase();
    return origin === dep.toUpperCase();
  });

  // Normalise both sets
  const normDep = depFlights.map(f => norm(f, dep, arr));
  const normArr = arrFlights.map(f => norm(f, dep, arr));

  // Merge: DEP board is primary, ARR board fills gaps
  const merged = dedup([...normDep, ...normArr]);

  // Fill missing arrival times
  const filled = fillTimes(merged, depCoords, arrCoords);

  // Sort by departure time (unknown times at end)
  filled.sort((a, b) => {
    const ta = a.departure.scheduledTime.local || 'ZZ';
    const tb = b.departure.scheduledTime.local || 'ZZ';
    return ta.localeCompare(tb);
  });

  return res.status(200).json({
    departures: filled,
    source: 'aerodatabox_multi',
    counts: {
      dep_board:  normDep.length,
      arr_board:  normArr.length,
      merged:     filled.length,
    },
  });
}
