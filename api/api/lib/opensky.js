// api/lib/opensky.js
// OpenSky Network — live ADS-B positions via OAuth2
// Credentials from credentials.json you downloaded

const TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const API_BASE  = "https://opensky-network.org/api";

let _cache = { token: null, expiresAt: 0 };

async function getToken() {
  if (_cache.token && Date.now() < _cache.expiresAt - 60000) return _cache.token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     process.env.OPENSKY_CLIENT_ID,
      client_secret: process.env.OPENSKY_CLIENT_SECRET,
    }).toString(),
  });
  if (!res.ok) throw new Error(`OpenSky token failed: ${res.status}`);
  const d = await res.json();
  _cache = { token: d.access_token, expiresAt: Date.now() + d.expires_in * 1000 };
  return _cache.token;
}

// Get all airborne aircraft in a lat/lon bounding box
export async function getAircraftInBox(minLat, maxLat, minLon, maxLon) {
  const token = await getToken();
  const url = `${API_BASE}/states/all?lamin=${minLat}&lamax=${maxLat}&lomin=${minLon}&lomax=${maxLon}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`OpenSky states failed: ${res.status}`);
  const data = await res.json();
  if (!data.states) return [];
  return data.states
    .filter(s => !s[8]) // airborne only
    .map(s => ({
      icao24:   s[0],
      callsign: s[1]?.trim() || null,
      lat:      s[6],
      lon:      s[5],
      alt_ft:   s[7] != null ? Math.round(s[7] * 3.281) : null,
      speed_kn: s[9] != null ? Math.round(s[9] * 1.944) : null,
      heading:  s[10],
      climbing: s[11] != null ? s[11] > 0.5 : null,
    }));
}
