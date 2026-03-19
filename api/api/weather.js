// Airport coordinates for weather lookup
const AIRPORT_COORDS = {
  LJU:{lat:46.22,lon:14.46},ZAG:{lat:45.74,lon:16.07},SPU:{lat:43.54,lon:16.30},
  DBV:{lat:42.56,lon:18.27},ZRH:{lat:47.46,lon:8.55},GVA:{lat:46.24,lon:6.11},
  VIE:{lat:48.11,lon:16.57},MUC:{lat:48.35,lon:11.79},FRA:{lat:50.03,lon:8.57},
  BER:{lat:52.37,lon:13.51},LHR:{lat:51.48,lon:-0.46},CDG:{lat:49.01,lon:2.55},
  AMS:{lat:52.31,lon:4.77},BRU:{lat:50.90,lon:4.48},MAD:{lat:40.47,lon:-3.56},
  BCN:{lat:41.30,lon:2.08},FCO:{lat:41.80,lon:12.24},MXP:{lat:45.63,lon:8.72},
  ATH:{lat:37.94,lon:23.95},IST:{lat:41.27,lon:28.74},DXB:{lat:25.25,lon:55.36},
  JFK:{lat:40.64,lon:-73.78},LAX:{lat:33.94,lon:-118.41},
  BEG:{lat:44.82,lon:20.29},TGD:{lat:42.36,lon:19.25},TIV:{lat:42.40,lon:18.72},
  SKP:{lat:41.96,lon:21.62},SOF:{lat:42.70,lon:23.41},BUD:{lat:47.44,lon:19.26},
  PRG:{lat:50.10,lon:14.26},WAW:{lat:52.17,lon:20.97},CPH:{lat:55.62,lon:12.65},
  OSL:{lat:60.20,lon:11.08},ARN:{lat:59.65,lon:17.92},HEL:{lat:60.32,lon:24.96},
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const { dep, arr, date } = req.query;
  if (!dep || !arr) return res.status(400).json({ error: 'Missing params' });

  const depCoords = AIRPORT_COORDS[dep.toUpperCase()];
  const arrCoords = AIRPORT_COORDS[arr.toUpperCase()];
  
  if (!depCoords || !arrCoords) {
    return res.status(200).json({ error: 'Airport coordinates not found', dep, arr });
  }

  // Midpoint of route for turbulence
  const midLat = (depCoords.lat + arrCoords.lat) / 2;
  const midLon = (depCoords.lon + arrCoords.lon) / 2;
  
  const targetDate = date || new Date().toISOString().split('T')[0];

  try {
    // Open-Meteo - free, no API key, accurate 7-day forecast + historical
    // Get wind at cruise altitude (~250hPa = ~34000ft) and surface weather
    const url = `https://api.open-meteo.com/v1/forecast?`
      + `latitude=${midLat}&longitude=${midLon}`
      + `&hourly=wind_speed_10m,wind_gusts_10m,temperature_2m,precipitation_probability,cloudcover,windspeed_250hPa,winddirection_250hPa`
      + `&daily=precipitation_sum,windspeed_10m_max,winddirection_10m_dominant`
      + `&wind_speed_unit=kmh`
      + `&timezone=auto`
      + `&start_date=${targetDate}&end_date=${targetDate}`;

    // Also get departure airport weather
    const depUrl = `https://api.open-meteo.com/v1/forecast?`
      + `latitude=${depCoords.lat}&longitude=${depCoords.lon}`
      + `&hourly=temperature_2m,precipitation_probability,cloudcover,wind_speed_10m,wind_gusts_10m,visibility`
      + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max`
      + `&timezone=auto`
      + `&start_date=${targetDate}&end_date=${targetDate}`;

    // Arrival airport weather
    const arrUrl = `https://api.open-meteo.com/v1/forecast?`
      + `latitude=${arrCoords.lat}&longitude=${arrCoords.lon}`
      + `&hourly=temperature_2m,precipitation_probability,cloudcover,wind_speed_10m,visibility`
      + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max`
      + `&timezone=auto`
      + `&start_date=${targetDate}&end_date=${targetDate}`;

    const [routeRes, depRes, arrRes] = await Promise.all([
      fetch(url), fetch(depUrl), fetch(arrUrl)
    ]);
    
    const [routeData, depData, arrData] = await Promise.all([
      routeRes.json(), depRes.json(), arrRes.json()
    ]);

    // Calculate turbulence index from high-altitude wind speed
    // Jet stream winds > 150 km/h at 250hPa = significant turbulence
    const hourlyWinds = routeData.hourly?.windspeed_250hPa || [];
    const avgJetWind = hourlyWinds.reduce((a,b)=>a+b,0) / (hourlyWinds.length||1);
    
    // Turbulence score 0-6 based on jet stream
    let turbScore;
    if (avgJetWind < 60) turbScore = 0;
    else if (avgJetWind < 90) turbScore = 1;
    else if (avgJetWind < 120) turbScore = 2;
    else if (avgJetWind < 150) turbScore = 3;
    else if (avgJetWind < 180) turbScore = 4;
    else if (avgJetWind < 220) turbScore = 5;
    else turbScore = 6;

    // Hourly turbulence profile (7 points for the forecast strip)
    const turbProfile = [];
    const step = Math.floor(hourlyWinds.length / 7) || 1;
    for (let i=0; i<7; i++) {
      const w = hourlyWinds[i*step] || avgJetWind;
      let ts = 0;
      if (w > 220) ts = 6;
      else if (w > 180) ts = 5;
      else if (w > 150) ts = 4;
      else if (w > 120) ts = 3;
      else if (w > 90) ts = 2;
      else if (w > 60) ts = 1;
      turbProfile.push(ts);
    }

    return res.status(200).json({
      turbulenceScore: turbScore,
      turbulenceProfile: turbProfile,
      jetStreamSpeed: Math.round(avgJetWind),
      route: routeData,
      departure: depData,
      arrival: arrData,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
