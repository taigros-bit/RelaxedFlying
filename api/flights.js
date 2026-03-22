export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { dep, arr, date } = req.query;
  if (!dep || !arr || !date) {
    return res.status(400).json({ error: 'Missing dep, arr or date' });
  }

  const KEY = 'b03cbc2da8mshfd6f5e8ac7c5894p18cc07jsnaabba528fd4a';

  try {
    const fromLocal = `${date}T00:00`;
    const toLocal   = `${date}T23:59`;
    const url = `https://aerodatabox.p.rapidapi.com/flights/airports/iata/${dep.toUpperCase()}/${fromLocal}/${toLocal}?withLeg=true&direction=Departure&withCancelled=false&withCodeshared=false&withCargo=false&withPrivate=false&withLocation=false`;

    const r = await fetch(url, {
      headers: {
        'x-rapidapi-key': KEY,
        'x-rapidapi-host': 'aerodatabox.p.rapidapi.com'
      }
    });

    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).json({ error: 'AeroDataBox API error', details: txt });
    }

    const raw = await r.json();
    const departures = raw.departures || [];

    // Filter only flights going to our destination
    const filtered = departures.filter(f => {
      const dest = (f.movement?.airport?.iata || '').toUpperCase();
      return dest === arr.toUpperCase();
    });

    // Transform to app format
    const flights = filtered.map(f => {
      const mv    = f.movement || {};
      const sched = mv.scheduledTime || {};
      const local = sched.local || sched.utc || '';
      // Parse "2026-03-23T07:40+01:00" -> "07:40"
      const depTime = local.match(/T(\d{2}:\d{2})/) ? local.match(/T(\d{2}:\d{2})/)[1] : '??:??';

      // Arrival time — AeroDataBox departure endpoint doesn't include arrival time
      // so we expose departure time and let frontend calculate from Haversine
      return {
        flightNumber: f.number || '',
        airline: {
          name: f.airline?.name || '',
          iata: f.airline?.iata || ''
        },
        aircraft: {
          iata: f.aircraft?.model?.code || ''
        },
        dep_time: depTime,
        arr_time: null, // will be calculated from Haversine in frontend
        departure: {
          scheduledTime: { local: local }
        },
        arrival: {
          scheduledTime: { local: null }
        }
      };
    });

    return res.status(200).json({
      source: 'aerodatabox',
      flights: flights
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
