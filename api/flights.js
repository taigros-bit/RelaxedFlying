export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  var dep = (req.query.dep || '').toUpperCase().trim();
  var arr = (req.query.arr || '').toUpperCase().trim();
  var date = req.query.date || new Date().toISOString().slice(0,10);

  if (!dep || !arr) return res.status(400).json({error:'Missing dep/arr'});

  var key = 'b03cbc2da8mshfd6f5e8ac7c5894p18cc07jsnaabba528fd4a';

  async function fetchWindow(from, to) {
    var url = 'https://aerodatabox.p.rapidapi.com/flights/airports/iata/'
      + dep + '/' + from + '/' + to
      + '?withLeg=true&direction=Departure&withCancelled=false&withCodeshared=false&withCargo=false&withPrivate=false&withLocation=false';
    var r = await fetch(url, {
      headers: {
        'x-rapidapi-host': 'aerodatabox.p.rapidapi.com',
        'x-rapidapi-key': key
      }
    });
    if (!r.ok) return [];
    var data = await r.json();
    return data.departures || [];
  }

  try {
    // AeroDataBox max 12h window — split day into two calls
    var [morning, evening] = await Promise.all([
      fetchWindow(date + 'T00:00', date + 'T11:59'),
      fetchWindow(date + 'T12:00', date + 'T23:59')
    ]);

    var all = morning.concat(evening);

    // Filter to our destination
    var filtered = all.filter(function(f) {
      var a = f.arrival && f.arrival.airport && f.arrival.airport.iata;
      return a && a.toUpperCase() === arr;
    });

    return res.status(200).json({
      source: 'aerodatabox',
      dep: dep,
      arr: arr,
      date: date,
      total_departures: all.length,
      count: filtered.length,
      departures: filtered
    });

  } catch(e) {
    return res.status(200).json({error: e.message});
  }
}
