export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { dep, arr, date } = req.query;
  if (!dep || !arr) return res.status(400).json({ error: 'Missing dep or arr' });

  const KEY = 'a1eae7e4d0f83d2605f99aab1abb04b2';

  const today = new Date();
  today.setHours(0,0,0,0);
  const reqDate = date ? new Date(date + 'T00:00:00') : today;
  const diffDays = Math.round((reqDate - today) / 86400000);

  let results = { data: [] };

  try {
    if (diffDays > 0) {
      // Future: use timetable (schedules) - filter by route
      const url = `https://api.aviationstack.com/v1/timetable?access_key=${KEY}&iataCode=${dep}&type=departure&limit=100`;
      const r = await fetch(url);
      const d = await r.json();
      if (d.data) {
        // Filter to our arrival airport and remove codeshares
        results.data = d.data.filter(f => {
          const arrIata = (f.arrival?.iataCode || f.arrival?.iata || '').toUpperCase();
          const isCodeshare = f.codeshared != null;
          return arrIata === arr.toUpperCase() && !isCodeshare;
        }).slice(0, 8);
        // Add the requested date to each flight for time parsing
        results.data = results.data.map(f => ({ ...f, _requestedDate: date }));
      }
    } else {
      // Today or past: use flights endpoint
      const dateParam = date ? `&flight_date=${date}` : '';
      const url = `https://api.aviationstack.com/v1/flights?access_key=${KEY}&dep_iata=${dep}&arr_iata=${arr}&limit=20${dateParam}`;
      const r = await fetch(url);
      const d = await r.json();
      if (d.data) {
        // Remove codeshares
        results.data = d.data.filter(f => !f.codeshared).slice(0, 8);
      }
      // If no results, try without date filter (get live)
      if (!results.data.length) {
        const url2 = `https://api.aviationstack.com/v1/flights?access_key=${KEY}&dep_iata=${dep}&arr_iata=${arr}&limit=20`;
        const r2 = await fetch(url2);
        const d2 = await r2.json();
        if (d2.data) results.data = d2.data.filter(f => !f.codeshared).slice(0, 8);
      }
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  return res.status(200).json(results);
}
