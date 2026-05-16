// api/turbulence.js
// ============================================================
// Master turbulence endpoint for RelaxedFlying
//
// GET /api/turbulence?dep=LJU&arr=LHR&date=2026-05-16&flightLevel=320
//
// Sources used (in priority order):
//   1. Meteomatics EDR  — ICAO-standard turbulence metric (best)
//   2. AviationWeather PIREPs — real pilot turbulence reports
//   3. Open-Meteo      — wind shear + CAPE proxy (always available)
//
// Returns:
//   { overall, climb, cruise, descent, profile[7], sources, raw }
//   overall/climb/cruise/descent = 0-6 scale matching TURB[] in index.html
// ============================================================

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { dep, arr, date, flightLevel = "320" } = req.query;
  if (!dep || !arr) return res.status(400).json({ error: "Missing dep or arr" });

  const fl = parseInt(flightLevel);
  const targetDate = date || new Date().toISOString().split("T")[0];

  // Airport coordinates — expand as needed
  const COORDS = {
    LJU:{lat:46.22,lon:14.46}, ZAG:{lat:45.74,lon:16.07}, DBV:{lat:42.56,lon:18.27},
    ZRH:{lat:47.46,lon:8.55},  VIE:{lat:48.11,lon:16.57}, MUC:{lat:48.35,lon:11.79},
    FRA:{lat:50.03,lon:8.57},  LHR:{lat:51.48,lon:-0.46}, LGW:{lat:51.15,lon:-0.18},
    STN:{lat:51.88,lon:0.24},  CDG:{lat:49.01,lon:2.55},  AMS:{lat:52.31,lon:4.77},
    BRU:{lat:50.90,lon:4.48},  MAD:{lat:40.47,lon:-3.56}, BCN:{lat:41.30,lon:2.08},
    FCO:{lat:41.80,lon:12.24}, MXP:{lat:45.63,lon:8.72},  ATH:{lat:37.94,lon:23.95},
    IST:{lat:41.27,lon:28.74}, DXB:{lat:25.25,lon:55.36}, DOH:{lat:25.27,lon:51.61},
    JFK:{lat:40.64,lon:-73.78},LAX:{lat:33.94,lon:-118.41},WAW:{lat:52.17,lon:20.97},
    BUD:{lat:47.44,lon:19.26}, PRG:{lat:50.10,lon:14.26}, CPH:{lat:55.62,lon:12.65},
    ARN:{lat:59.65,lon:17.92}, HEL:{lat:60.32,lon:24.96}, OSL:{lat:60.20,lon:11.08},
    TLL:{lat:59.41,lon:24.83}, RIX:{lat:56.92,lon:23.97}, VNO:{lat:54.63,lon:25.28},
    MLA:{lat:35.86,lon:14.48}, LIS:{lat:38.77,lon:-9.13}, OPO:{lat:41.24,lon:-8.68},
    GVA:{lat:46.24,lon:6.11},  BSL:{lat:47.60,lon:7.53},  BEG:{lat:44.82,lon:20.29},
    SOF:{lat:42.70,lon:23.41}, OTP:{lat:44.57,lon:26.10}, SKP:{lat:41.96,lon:21.62},
  };

  const depC = COORDS[dep.toUpperCase()];
  const arrC = COORDS[arr.toUpperCase()];
  if (!depC || !arrC) {
    return res.status(400).json({ error: `Unknown airport: ${!depC ? dep : arr}` });
  }

  // Build 5 equally-spaced waypoints along the route
  const waypoints = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    lat: depC.lat + (arrC.lat - depC.lat) * t,
    lon: depC.lon + (arrC.lon - depC.lon) * t,
    t,
  }));

  const results = { sources: [], raw: {} };

  // ── SOURCE 1: Open-Meteo (always, free, no key) ──────────
  try {
    const omScores = await Promise.all(waypoints.map(wp => fetchOpenMeteo(wp.lat, wp.lon, targetDate)));
    const climb  = avg(omScores.slice(0, 2).map(s => s.climbScore));
    const cruise = avg(omScores.slice(1, 4).map(s => s.cruiseScore));
    const descent= avg(omScores.slice(3, 5).map(s => s.climbScore));
    results.openMeteo = { climb, cruise, descent, waypoints: omScores };
    results.raw.openMeteo = omScores;
    results.sources.push("open-meteo");
  } catch (e) {
    console.error("Open-Meteo failed:", e.message);
  }

  // ── SOURCE 2: AviationWeather PIREPs (always, free, no key) ──
  try {
    const pireps = await fetchPireps(dep, arr);
    if (pireps.length > 0) {
      const maxTurb = Math.max(...pireps.map(p => p.score));
      results.pireps = { count: pireps.length, maxScore: maxTurb, reports: pireps };
      results.sources.push("pireps");
    }
  } catch (e) {
    console.error("PIREPs failed:", e.message);
  }

  // ── SOURCE 3: Meteomatics EDR (best — use if credentials available) ──
  if (process.env.METEOMATICS_USER && process.env.METEOMATICS_PASS) {
    try {
      const edrScores = await Promise.all(
        waypoints.map(wp => fetchMeteomaticsEDR(wp.lat, wp.lon, fl, targetDate))
      );
      const validEdr = edrScores.filter(s => s !== null);
      if (validEdr.length > 0) {
        const edrClimb  = avg(validEdr.slice(0, 2).map(s => s.score10));
        const edrCruise = avg(validEdr.slice(1, 4).map(s => s.score10));
        const edrDescent= avg(validEdr.slice(3, 5).map(s => s.score10));
        results.meteomatics = { climb: edrClimb, cruise: edrCruise, descent: edrDescent, raw: validEdr };
        results.sources.push("meteomatics-edr");
      }
    } catch (e) {
      console.error("Meteomatics failed:", e.message);
    }
  }

  // ── BLEND: combine sources into final scores ──────────────
  // Priority: Meteomatics (best) > PIREPs (real pilots) > Open-Meteo (proxy)
  const final = blendSources(results);

  return res.status(200).json({
    dep, arr, date: targetDate, flightLevel: fl,
    ...final,
    sources: results.sources,
    raw: results.raw,
  });
}

// ── Open-Meteo: wind shear + CAPE turbulence proxy ───────────
async function fetchOpenMeteo(lat, lon, date) {
  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`
    + `&hourly=windspeed_250hPa,windspeed_300hPa,windspeed_500hPa,cape`
    + `&wind_speed_unit=kmh&timezone=UTC`
    + `&start_date=${date}&end_date=${date}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const d = await res.json();
  const h = d.hourly;
  const w250 = avg(h.windspeed_250hPa || []);
  const w300 = avg(h.windspeed_300hPa || []);
  const w500 = avg(h.windspeed_500hPa || []);
  const cape = avg(h.cape || []);
  const shear = Math.abs(w250 - w300);

  // Cruise score (FL250-350): jet stream + shear
  const jet   = w250 > 220 ? 9 : w250 > 180 ? 7.5 : w250 > 140 ? 6 : w250 > 100 ? 4 : w250 > 70 ? 2.5 : 1;
  const sh    = shear > 80 ? 6 : shear > 50 ? 4.5 : shear > 30 ? 3 : shear > 15 ? 1.5 : 0.5;
  const cv    = cape > 2000 ? 6 : cape > 1000 ? 4 : cape > 400 ? 2 : cape > 100 ? 1 : 0;
  const cruiseScore = Math.min(10, jet * 0.5 + sh * 0.3 + cv * 0.2);

  // Climb/descent score (FL100-250): mid-level wind + CAPE
  const mid   = w500 > 120 ? 6 : w500 > 80 ? 4 : w500 > 50 ? 2 : 1;
  const climbScore = Math.min(10, mid * 0.6 + cv * 0.4);

  return { lat, lon, w250, w300, w500, cape, shear, cruiseScore, climbScore };
}

// ── AviationWeather PIREPs ────────────────────────────────────
async function fetchPireps(dep, arr) {
  const TURB_MAP = { NEG:0, LGT:2, "LGT-MOD":3, MOD:5, "MOD-SEV":7, SEV:9, EXTRM:10 };
  const res = await fetch(
    `https://aviationweather.gov/api/data/pirep?id=${dep}&distance=400&age=3&format=json`,
    { headers: { "User-Agent": "RelaxedFlying/1.0 (relaxedflying.app)" } }
  );
  if (!res.ok) return [];
  const reports = await res.json();
  if (!Array.isArray(reports)) return [];
  return reports
    .filter(r => r.tbInt && r.tbInt !== "NEG")
    .map(r => ({
      time: r.obsTime,
      lat: r.latitude,
      lon: r.longitude,
      alt_ft: r.altitude ? r.altitude * 100 : null,
      intensity: r.tbInt,
      score: TURB_MAP[r.tbInt] ?? 3,
      type: r.tbType || "UNK",
    }));
}

// ── Meteomatics EDR ───────────────────────────────────────────
async function fetchMeteomaticsEDR(lat, lon, fl, date) {
  const auth  = Buffer.from(`${process.env.METEOMATICS_USER}:${process.env.METEOMATICS_PASS}`).toString("base64");
  const dt    = `${date}T12:00:00Z`;
  const param = `edr_max_FL${fl}_3h:m23s1`;
  const url   = `https://api.meteomatics.com/${dt}/${param}/${lat.toFixed(3)},${lon.toFixed(3)}/json`;
  const res   = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) return null;
  const data  = await res.json();
  const edr   = data?.data?.[0]?.coordinates?.[0]?.dates?.[0]?.value ?? null;
  if (edr === null) return null;
  // EDR 0-1 → score 0-10
  const score10 = edr < 0.1 ? 0 : edr < 0.2 ? 2 : edr < 0.4 ? 5 : edr < 0.6 ? 8 : 10;
  return { lat, lon, edr, score10, severity: edr < 0.1 ? "none" : edr < 0.2 ? "light" : edr < 0.4 ? "moderate" : edr < 0.6 ? "severe" : "extreme" };
}

// ── Blend sources into final 0-6 score ───────────────────────
function blendSources(r) {
  let climbRaw, cruiseRaw, descentRaw;

  if (r.meteomatics) {
    // Meteomatics is most accurate — 70% weight
    const om = r.openMeteo || { climb: 3, cruise: 3, descent: 3 };
    climbRaw  = r.meteomatics.climb  * 0.7 + om.climb  * 0.3;
    cruiseRaw = r.meteomatics.cruise * 0.7 + om.cruise * 0.3;
    descentRaw= r.meteomatics.descent* 0.7 + om.descent* 0.3;
  } else if (r.openMeteo) {
    climbRaw  = r.openMeteo.climb;
    cruiseRaw = r.openMeteo.cruise;
    descentRaw= r.openMeteo.descent;
  } else {
    climbRaw = cruiseRaw = descentRaw = 3; // fallback
  }

  // If PIREPs report worse — bump up
  if (r.pireps && r.pireps.maxScore > cruiseRaw) {
    cruiseRaw = cruiseRaw * 0.6 + r.pireps.maxScore * 0.4;
  }

  // Convert 0-10 → 0-6 and round
  const to6 = v => Math.max(0, Math.min(6, Math.round(v * 0.6)));
  const climb   = to6(climbRaw);
  const cruise  = to6(cruiseRaw);
  const descent = to6(descentRaw);
  const overall = to6(climbRaw * 0.2 + cruiseRaw * 0.6 + descentRaw * 0.2);

  // 7-point profile for the forecast strip in index.html
  const profile = [
    to6(climbRaw * 1.1),
    to6(climbRaw),
    to6(climbRaw * 0.4 + cruiseRaw * 0.6),
    to6(cruiseRaw),
    to6(cruiseRaw * 0.6 + descentRaw * 0.4),
    to6(descentRaw),
    to6(descentRaw * 1.05),
  ];

  return { overall, climb, cruise, descent, profile };
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + (b || 0), 0) / arr.length;
}
