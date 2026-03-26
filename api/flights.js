// Vercel serverless function — /api/flights
// AeroDataBox via RapidAPI — correct implementation
// Max window: 12h, so we split 24h into two calls

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { dep, arr, date, fn } = req.query;
  const RAPIDAPI_KEY = 'b03cbc2da8mshfd6f5e8ac7c5894p18cc07jsnaabba528fd4a';

  const headers = {
    'x-rapidapi-host': 'aerodatabox.p.rapidapi.com',
    'x-rapidapi-key': RAPIDAPI_KEY,
  };

  // ── FLIGHT NUMBER SEARCH ───────────────────────────────────
  if (fn && date) {
    try {
      const fnClean = fn.toUpperCase().replace(/\s/g, '');
      const url = `https://aerodatabox.p.rapidapi.com/flights/${fnClean}/${date}`;
      const r = await fetch(url, { headers });
      if (!r.ok) return res.status(502).json({ error: `ADB error ${r.status}`, departures: [] });
      const data = await r.json();
      // ADB returns array for flight number search
      const flights = Array.isArray(data) ? data : [data];
      return res.status(200).json({ departures: flights, source: 'aerodatabox_fn' });
    } catch (e) {
      return res.status(500).json({ error: e.message, departures: [] });
    }
  }

  // ── ROUTE SEARCH ──────────────────────────────────────────
  if (!dep || !arr || !date) {
    return res.status(400).json({ error: 'Missing dep, arr, or date' });
  }

  try {
    // AeroDataBox max window = 12h — split into AM and PM
    const params = '?withLeg=true&direction=Departure&withCancelled=false&withCodeshared=false&withCargo=false&withPrivate=false&withLocation=false';

    const [rAM, rPM] = await Promise.all([
      fetch(`https://aerodatabox.p.rapidapi.com/flights/airports/iata/${dep}/${date}T00:00/${date}T11:59${params}`, { headers }),
      fetch(`https://aerodatabox.p.rapidapi.com/flights/airports/iata/${dep}/${date}T12:00/${date}T23:59${params}`, { headers }),
    ]);

    const [dAM, dPM] = await Promise.all([
      rAM.ok ? rAM.json() : { departures: [] },
      rPM.ok ? rPM.json() : { departures: [] },
    ]);

    // Combine both windows
    const all = [
      ...(dAM.departures || dAM.arrivals || []),
      ...(dPM.departures || dPM.arrivals || []),
    ];

    // Filter to flights going to our destination airport
    const filtered = all.filter(f => {
      // AeroDataBox structure for FIDS:
      // f.arrival.airport.iata OR f.movement.airport.iata (destination)
      const dest = (
        f?.arrival?.airport?.iata ||
        f?.movement?.airport?.iata ||
        ''
      ).toUpperCase();
      return dest === arr.toUpperCase();
    });

    // Return in format index.html expects (parseLiveFlights reads .departures[])
    return res.status(200).json({
      departures: filtered,
      source: 'aerodatabox',
      total: all.length,
      filtered: filtered.length,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message, departures: [] });
  }
}
