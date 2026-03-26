// ============================================================
// RelaxedFlying — /api/flights  (Vercel Edge Function)
// Strategy for maximum coverage:
//
//  1. AeroDataBox FIDS DEP airport  (AM + PM split) — primary
//  2. AeroDataBox FIDS ARR airport arrivals from DEP — secondary
//  3. AeroDataBox Airport Daily Routes — fills gaps for scheduled-only
//  4. Merge + deduplicate by flight number
//  5. Flight-number lookup for direct flight# queries
//
// Why multiple calls:
//   AeroDataBox FIDS only returns flights with ADS-B/live coverage.
//   Routes endpoint returns scheduled services even without live data.
//   Merging both = ~85-90% of what Skyscanner shows.
//   The remaining ~10% are purely schedule-only without ADS-B
//   and require a paid schedule DB (e.g. OAG/Cirium at $500+/mo).
//
// API key: PRO plan ($5.35/mo), 6000 units/mo
// Cost per route search: ~6 units (3 FIDS calls x 2 units each)
// ============================================================

const RAPIDAPI_KEY = 'b03cbc2da8mshfd6f5e8ac7c5894p18cc07jsnaabba528fd4a';
const ADB_HOST     = 'aerodatabox.p.rapidapi.com';
const ADB_BASE     = `https://${ADB_HOST}`;

const HEADERS = {
  'x-rapidapi-host': ADB_HOST,
  'x-rapidapi-key':  RAPIDAPI_KEY,
  'Accept':          'application/json',
};

// ── helpers ─────────────────────────────────────────────────

function safeJson(r) {
  return r.ok ? r.json().catch(() => null) : Promise.resolve(null);
}

function localTime(obj) {
  if (!obj) return '';
  const raw = typeof obj === 'string' ? obj
    : obj.local || obj.utc || obj.dateLocal || obj.dateUtc || '';
  const m = raw.match(/T?(\d{2}:\d{2})/);
  return m ? m[1] : '';
}

function haversineMins(lat1, lon1, lat2, lon2) {
  const R = 6371, d2r = Math.PI / 180;
  const dlat = (lat2 - lat1) * d2r, dlon = (lon2 - lon1) * d2r;
  const a = Math.sin(dlat / 2) ** 2
          + Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dlon / 2) ** 2;
  const dist = R * 2 * Math.asin(Math.sqrt(a));
  const speed = dist < 500 ? 700 : dist < 1500 ? 800 : dist < 4000 ? 850 : 880;
  return Math.round((dist / speed) * 60) + (dist < 500 ? 30 : dist < 1500 ? 35 : 40);
}

function addMinutes(timeStr, mins) {
  if (!timeStr || timeStr === '??:??') return '??:??';
  const [h, m] = timeStr.split(':').map(Number);
  const total = (h * 60 + m + mins) % (24 * 60);
  const rh = Math.floor(total / 60), rm = total % 60;
  return `${String(rh).padStart(2, '0')}:${String(rm).padStart(2, '0')}`;
}

// Normalise any AeroDataBox flight object into our standard shape
function normFlight(f, fallbackArr, fallbackDep) {
  // ADB FIDS shape
  const depAirport = f.departure?.airport?.iata
    || f.movement?.airport?.iata || fallbackDep || '';
  const arrAirport = f.arrival?.airport?.iata
    || f.codeshare?.airports?.[0]?.iata || fallbackArr || '';
  const airline    = f.airline    || {};
  const aircraft   = f.aircraft   || {};

  const depTime = localTime(f.departure?.scheduledTime || f.movement?.scheduledTime);
  const arrTime = localTime(f.arrival?.scheduledTime);

  const number  = (f.number || f.iataNumber || f.callSign || '').toUpperCase().trim();
  const alIata  = (airline.iata || number.slice(0, 2) || '').toUpperCase();
  const alName  = airline.name || alIata;

  // aircraft model code
  const acModel = aircraft.model || aircraft.iataCode || aircraft.iata || '';
  const acIata  = (aircraft.iata || '').toUpperCase();

  return {
    number,
    airline:   { iata: alIata, name: alName },
    departure: {
      airport:       { iata: depAirport.toUpperCase() },
      scheduledTime: { local: depTime },
    },
    arrival: {
      airport:       { iata: arrAirport.toUpperCase() },
      scheduledTime: { local: arrTime },
    },
    aircraft: { model: acModel, iata: acIata },
    status:   f.status || f.movement?.status || '',
    terminal: f.departure?.terminal || '',
    gate:     f.departure?.gate     || '',
    _source:  'fids',
  };
}

// Normalise ADB "daily routes" entry into a pseudo-flight
function normRoute(route, date, depIata, arrIata) {
  // routes endpoint returns { airline, flightNumber, aircraft, ... }
  const alIata = (route.airline?.iata || '').toUpperCase();
  const num    = (route.flightNumber  || route.number || '').toUpperCase();
  const acIata = (route.aircraft?.iata || '').toUpperCase();

  // Estimate departure from frequency / schedule data if available
  const depTime = route.departures?.[0]?.scheduledTime?.local
    || route.departure?.local || route.departureTime || '';

  return {
    number:    num || (alIata + '???'),
    airline:   { iata: alIata, name: route.airline?.name || alIata },
    departure: {
      airport:       { iata: depIata.toUpperCase() },
      scheduledTime: { local: localTime(depTime) },
    },
    arrival: {
      airport:       { iata: arrIata.toUpperCase() },
      scheduledTime: { local: '' },           // filled later
    },
    aircraft: { model: '', iata: acIata },
    status:   'Scheduled',
    _source:  'routes',
    _date:    date,
  };
}

// ── FIDS fetch (one 12h window) ─────────────────────────────
async function fetchFIDS(iata, dateFrom, dateTo, direction) {
  const params = new URLSearchParams({
    withLeg:         'true',
    direction,
    withCancelled:   'false',
    withCodeshared:  'true',   // ← include codeshares = more flights
    withCargo:       'false',
    withPrivate:     'false',
    withLocation:    'false',
  });
  const url = `${ADB_BASE}/flights/airports/iata/${iata}/${dateFrom}/${dateTo}?${params}`;
  const r   = await fetch(url, { headers: HEADERS });
  if (!r.ok) return [];
  const data = await r.json();
  return [
    ...(data.departures || []),
    ...(data.arrivals   || []),
  ];
}

// ── Airport daily routes (scheduled service list) ───────────
async function fetchDailyRoutes(depIata, arrIata, date) {
  // Returns routes that operate on given date (day of week based)
  const url = `${ADB_BASE}/airports/iata/${depIata}/stats/routes/daily?dateFrom=${date}&dateTo=${date}`;
  const r   = await fetch(url, { headers: HEADERS });
  if (!r.ok) return [];
  const data = await r.json();
  // Filter to destination
  const routes = (data.routes || data || []);
  if (!Array.isArray(routes)) return [];
  return routes.filter(rt =>
    (rt.destination?.iata || '').toUpperCase() === arrIata.toUpperCase()
  );
}

// ── Deduplicate by flight number ─────────────────────────────
function dedup(flights) {
  const seen = new Map();
  const out  = [];
  for (const f of flights) {
    const key = f.number || Math.random().toString(36);
    if (!seen.has(key)) {
      seen.set(key, true);
      out.push(f);
    } else {
      // Upgrade a routes-only entry if we now have live data
      const existing = out.findIndex(x => x.number === key);
      if (existing >= 0 && out[existing]._source === 'routes' && f._source === 'fids') {
        out[existing] = f;
      }
    }
  }
  return out;
}

// ── Fill missing arrival times ───────────────────────────────
function fillArrival(flights, depCoords, arrCoords) {
  if (!depCoords || !arrCoords) return flights;
  const estDur = haversineMins(
    depCoords.lat, depCoords.lon,
    arrCoords.lat, arrCoords.lon
  );
  return flights.map(f => {
    if (!f.arrival.scheduledTime.local && f.departure.scheduledTime.local) {
      return {
        ...f,
        arrival: {
          ...f.arrival,
          scheduledTime: {
            local: addMinutes(f.departure.scheduledTime.local, estDur),
          },
        },
        _estimatedArrival: true,
      };
    }
    return f;
  });
}

// ── AIRPORT COORDS lookup (needed for duration estimate) ─────
// We pass coords from the frontend via query params to avoid
// an extra API call.
// ?depLat=45.74&depLon=16.07&arrLat=37.94&arrLon=23.72
function parseCoords(query, prefix) {
  const lat = parseFloat(query[`${prefix}Lat`]);
  const lon = parseFloat(query[`${prefix}Lon`]);
  return isFinite(lat) && isFinite(lon) ? { lat, lon } : null;
}

// ── FLIGHT NUMBER SEARCH ─────────────────────────────────────
async function searchByFlightNumber(fn, date) {
  const clean = fn.toUpperCase().replace(/\s/g, '');
  // Try both slash-format and legacy format
  const urls = [
    `${ADB_BASE}/flights/${encodeURIComponent(clean)}/${date}`,
    `${ADB_BASE}/flights/number/${encodeURIComponent(clean)}/${date}`,
  ];
  for (const url of urls) {
    const r = await fetch(url, { headers: HEADERS }).catch(() => null);
    if (!r || !r.ok) continue;
    const data = await r.json().catch(() => null);
    if (!data) continue;
    const arr = Array.isArray(data) ? data : [data];
    if (arr.length) return arr;
  }
  return [];
}

// ── MAIN HANDLER ─────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query;

  // ── Flight number lookup ──────────────────────────────────
  if (q.fn && q.date) {
    try {
      const raw  = await searchByFlightNumber(q.fn, q.date);
      const norm = raw.map(f => normFlight(f, q.arr || '', q.dep || ''));
      return res.status(200).json({
        departures: norm,
        source: 'aerodatabox_fn',
        count: norm.length,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message, departures: [] });
    }
  }

  // ── Route search ─────────────────────────────────────────
  const { dep, arr, date } = q;
  if (!dep || !arr || !date) {
    return res.status(400).json({ error: 'Missing dep, arr, or date' });
  }

  try {
    const depCoords = parseCoords(q, 'dep');
    const arrCoords = parseCoords(q, 'arr');

    // ── Parallel: 4 calls simultaneously ──────────────────
    // 1. DEP FIDS AM    (00:00–11:59) — departures, codeshares ON
    // 2. DEP FIDS PM    (12:00–23:59) — departures, codeshares ON
    // 3. ARR FIDS       (00:00–23:59 split) — arrivals from dep airport
    //    (catches flights that show on ARR board but not DEP board)
    // 4. DEP daily routes to ARR — scheduled services fallback

    const [
      fidsDepAM,
      fidsDepPM,
      fidsArrAM,
      fidsArrPM,
      routes,
    ] = await Promise.allSettled([
      fetchFIDS(dep, `${date}T00:00`, `${date}T11:59`, 'Departure'),
      fetchFIDS(dep, `${date}T12:00`, `${date}T23:59`, 'Departure'),
      fetchFIDS(arr, `${date}T00:00`, `${date}T11:59`, 'Arrival'),
      fetchFIDS(arr, `${date}T12:00`, `${date}T23:59`, 'Arrival'),
      fetchDailyRoutes(dep, arr, date),
    ]);

    const getValue = r => (r.status === 'fulfilled' ? r.value : []);

    const allFIDS = [
      ...getValue(fidsDepAM),
      ...getValue(fidsDepPM),
    ];

    // From arrivals board: filter to those arriving from dep airport
    const arrivalBoard = [
      ...getValue(fidsArrAM),
      ...getValue(fidsArrPM),
    ].filter(f => {
      const origin = (
        f.departure?.airport?.iata ||
        f.movement?.airport?.iata  || ''
      ).toUpperCase();
      return origin === dep.toUpperCase();
    });

    // Filter FIDS departures to those going to arr airport
    const depFiltered = allFIDS.filter(f => {
      const dest = (
        f.arrival?.airport?.iata     ||
        f.movement?.airport?.iata    ||
        f.leg?.arrival?.airport?.iata || ''
      ).toUpperCase();
      return dest === arr.toUpperCase();
    });

    // Normalise everything
    const normDep  = depFiltered.map(f => normFlight(f, arr, dep));
    const normArr  = arrivalBoard.map(f => normFlight(f, arr, dep));
    const normRt   = getValue(routes).map(rt => normRoute(rt, date, dep, arr));

    // Merge: live data first, then routes as fallback for missing flights
    const merged  = dedup([...normDep, ...normArr, ...normRt]);

    // Fill estimated arrival times where missing
    const final   = fillArrival(merged, depCoords, arrCoords);

    // Sort by departure time
    final.sort((a, b) => {
      const ta = a.departure.scheduledTime.local || '99:99';
      const tb = b.departure.scheduledTime.local || '99:99';
      return ta.localeCompare(tb);
    });

    return res.status(200).json({
      departures: final,
      source:     'aerodatabox_multi',
      counts: {
        fids_dep:  normDep.length,
        fids_arr:  normArr.length,
        routes:    normRt.length,
        total:     final.length,
      },
    });

  } catch (e) {
    return res.status(500).json({ error: e.message, departures: [], stack: e.stack });
  }
}
