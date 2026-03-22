export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  var dep = (req.query.dep || '').toUpperCase().trim();
  var arr = (req.query.arr || '').toUpperCase().trim();
  var date = req.query.date || new Date().toISOString().slice(0,10);

  if (!dep || !arr) return res.status(400).json({error:'Missing dep/arr'});

  var key = 'b03cbc2da8mshfd6f5e8ac7c5894p18cc07jsnaabba528fd4a';

  try {
    var fromDT = date + 'T00:00';
    var toDT   = date + 'T23:59';
    var url = 'https://aerodatabox.p.rapidapi.com/flights/airports/iata/'
      + dep + '/' + fromDT + '/' + toDT
      + '?withLeg=true&direction=Departure&withCancelled=false&withCodeshared=false&withCargo=false&withPrivate=false&withLocation=false';

    var r = await fetch(url, {
      headers: {
        'x-rapidapi-host': 'aerodatabox.p.rapidapi.com',
        'x-rapidapi-key': key
      }
    });

    var body = await r.text();

    if (!r.ok) {
      return res.status(200).json({error:'AeroDataBox HTTP '+r.status, detail: body.slice(0,500)});
    }

    var data = JSON.parse(body);
    var all = data.departures || [];

    // Filter to destination
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
    return res.status(200).json({error: e.message, stack: e.stack ? e.stack.slice(0,300) : ''});
  }
}
