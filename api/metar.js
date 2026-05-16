// api/metar.js
// ============================================================
// GET /api/metar?dep=LJLJ&arr=EGLL
// Returns decoded METARs for departure + arrival airports
// Uses CheckWX — 3,000 free requests/day, clean JSON
// ============================================================
// IATA → ICAO mapping for CheckWX (which needs ICAO codes)
const IATA_TO_ICAO = {
  LJU:"LJLJ", ZAG:"LDZA", DBV:"LDDU", SPU:"LDSP", PUY:"LDPL", ZAD:"LDZD",
  ZRH:"LSZH", GVA:"LSGG", BSL:"LFSB", BRN:"LSZB",
  VIE:"LOWW", GRZ:"LOWG", SZG:"LOWS", INN:"LOWI", LNZ:"LOWL", KLU:"LOWK",
  MUC:"EDDM", FRA:"EDDF", BER:"EDDB", HAM:"EDDH", DUS:"EDDL", STR:"EDDS",
  CGN:"EDDK", NUE:"EDDN", LEJ:"EDDP", BRE:"EDDW", HAJ:"EDDV",
  LHR:"EGLL", LGW:"EGKK", STN:"EGSS", LTN:"EGGW", LCY:"EGLC",
  MAN:"EGCC", EDI:"EGPH", GLA:"EGPF", BHX:"EGBB", BRS:"EGGD",
  CDG:"LFPG", ORY:"LFPO", NCE:"LFMN", LYS:"LFLL", MRS:"LFML",
  BOD:"LFBD", TLS:"LFBO", NTE:"LFRS",
  AMS:"EHAM", BRU:"EBBR", CRL:"EBCI",
  MAD:"LEMD", BCN:"LEBL", PMI:"LEPA", AGP:"LEMG", ALC:"LEAL",
  VLC:"LEVC", SVQ:"LEZL", BIO:"LEBB",
  LIS:"LPPT", OPO:"LPPR", FAO:"LPFR",
  FCO:"LIRF", CIA:"LIRA", MXP:"LIMC", LIN:"LIML", BGY:"LIME",
  VCE:"LIPZ", NAP:"LIRN", BLQ:"LIPE", PMO:"LICJ", CTA:"LICC",
  BRI:"LIBD", PSA:"LIRP", VRN:"LIPX", TRN:"LIMF",
  ATH:"LGAV", SKG:"LGTS", HER:"LGIR", RHO:"LGRP", CFU:"LGKR",
  IST:"LTFM", SAW:"LTFJ", AYT:"LTAI", ADB:"LTBJ", ESB:"LTAC",
  PRG:"LKPR", BRQ:"LKTB", BTS:"LZIB", WAW:"EPWA", KRK:"EPKK",
  WRO:"EPWR", GDN:"EPGD", BUD:"LHBP", DEB:"LHDC", SOF:"LBSF",
  OTP:"LROP", CLJ:"LRCL", BEG:"LYBE", TGD:"LYPG", SKP:"LWSK",
  TIA:"LATI", TLL:"EETN", RIX:"EVRA", VNO:"EYVI",
  CPH:"EKCH", OSL:"ENGM", BGO:"ENBR", ARN:"ESSA", GOT:"ESGG",
  HEL:"EFHK", TMP:"EFTP",
  DXB:"OMDB", AUH:"OMAA", DOH:"OTHH", BAH:"OBBI", MCT:"OOMS",
  AMM:"OJAI", TLV:"LLBG", CAI:"HECA", HRG:"HEGN", SSH:"HESH",
  CMN:"GMMC", RAK:"GMMX", TUN:"DTTJ", ALG:"DAAG",
  NBO:"HKJK", JNB:"FAOR", CPT:"FACT", ADD:"HAAB",
  JFK:"KJFK", LGA:"KLGA", EWR:"KEWR", LAX:"KLAX", ORD:"KORD",
  ATL:"KATL", DFW:"KDFW", DEN:"KDEN", SFO:"KSFO", SEA:"KSEA",
  MIA:"KMIA", BOS:"KBOS", IAD:"KIAD", DCA:"KDCA",
  DEL:"VIDP", BOM:"VABB", BLR:"VOBL", MAA:"VOMM",
  BKK:"VTBS", HKT:"VTSP", KUL:"WMKK", SIN:"WSSS",
  HKG:"VHHH", TPE:"RCTP", NRT:"RJAA", HND:"RJTT", KIX:"RJBB",
  ICN:"RKSI", SYD:"YSSY", MEL:"YMML", BNE:"YBBN",
  MLA:"LMML",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=120");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { dep, arr } = req.query;
  if (!dep) return res.status(400).json({ error: "Missing dep" });

  const KEY = process.env.CHECKWX_KEY;
  if (!KEY) return res.status(500).json({ error: "CHECKWX_KEY not configured" });

  const depIcao = IATA_TO_ICAO[dep.toUpperCase()];
  const arrIcao = arr ? IATA_TO_ICAO[arr.toUpperCase()] : null;

  if (!depIcao) return res.status(400).json({ error: `Unknown airport IATA: ${dep}` });

  // Build query string for CheckWX — can fetch multiple airports at once
  const icaos = [depIcao, arrIcao].filter(Boolean).join(",");

  try {
    const [metarRes, tafRes] = await Promise.all([
      fetch(`https://api.checkwx.com/metar/${icaos}/decoded`, {
        headers: { "X-API-Key": KEY }
      }),
      fetch(`https://api.checkwx.com/taf/${icaos}/decoded`, {
        headers: { "X-API-Key": KEY }
      }),
    ]);

    const [metarData, tafData] = await Promise.all([
      metarRes.ok ? metarRes.json() : null,
      tafRes.ok ? tafRes.json() : null,
    ]);

    // Parse into a cleaner format for index.html to consume
    function parseMetar(raw) {
      if (!raw) return null;
      return {
        icao:            raw.icao,
        raw_text:        raw.raw_text,
        observed:        raw.observed,
        temp_c:          raw.temperature?.celsius,
        dewpoint_c:      raw.dewpoint?.celsius,
        wind_speed_kn:   raw.wind?.speed_kts,
        wind_dir:        raw.wind?.degrees,
        wind_gust_kn:    raw.wind?.gust_kts,
        visibility_m:    raw.visibility?.meters,
        flight_category: raw.flight_category, // VFR / MVFR / IFR / LIFR
        clouds:          (raw.clouds || []).map(c => `${c.code}${c.base_feet_agl}`).join(" "),
        weather:         (raw.conditions || []).map(c => c.text).join(", "),
        barometer_hpa:   raw.barometer?.hpa,
      };
    }

    const metarByIcao = {};
    (metarData?.data || []).forEach(m => { metarByIcao[m.icao] = parseMetar(m); });

    const tafByIcao = {};
    (tafData?.data || []).forEach(t => { tafByIcao[t.icao] = t; });

    return res.status(200).json({
      dep: {
        iata: dep.toUpperCase(),
        icao: depIcao,
        metar: metarByIcao[depIcao] || null,
        taf:   tafByIcao[depIcao]   || null,
      },
      arr: arrIcao ? {
        iata: arr.toUpperCase(),
        icao: arrIcao,
        metar: metarByIcao[arrIcao] || null,
        taf:   tafByIcao[arrIcao]   || null,
      } : null,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
