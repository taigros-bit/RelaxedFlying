export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { dep, arr, date } = req.query;

  if (!dep || !arr) {
    return res.status(400).json({ error: 'Missing dep or arr' });
  }

  const API_KEY = 'a1eae7e4d0f83d2605f99aab1abb04b2';
  const url = `http://api.aviationstack.com/v1/flights?access_key=${API_KEY}&dep_iata=${dep}&arr_iata=${arr}&flight_date=${date || ''}&limit=6`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'API error', detail: err.message });
  }
}
