export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { dep, arr, date } = req.query;
  if (!dep || !arr) return res.status(400).json({ error: 'Missing dep or arr' });

  const KEY = 'a1eae7e4d0f83d2605f99aab1abb04b2';

  // Check if date is in the past, today, or future
  const today = new Date();
  today.setHours(0,0,0,0);
  const reqDate = date ? new Date(date+'T00:00:00') : today;
  const diffDays = Math.round((reqDate - today) / 86400000);

  let url;
  if (diffDays > 0) {
    // Future: use timetable endpoint (works on Basic plan for near future)
    url = `https://api.aviationstack.com/v1/timetable?access_key=${KEY}&iataCode=${dep}&type=departure`;
  } else {
    // Today or past: use flights endpoint with date filter
    const dateParam = date ? `&flight_date=${date}` : '';
    url = `https://api.aviationstack.com/v1/flights?access_key=${KEY}&dep_iata=${dep}&arr_iata=${arr}&limit=10${dateParam}`;
  }

  try {
    const r = await fetch(url);
    const data = await r.json();

    // For timetable, filter by arrival airport
    if (diffDays > 0 && data.data) {
      data.data = data.data.filter(f => 
        f.arrival && f.arrival.iataCode && f.arrival.iataCode.toUpperCase() === arr.toUpperCase()
      ).slice(0, 8);
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
