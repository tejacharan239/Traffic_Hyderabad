/*
 * Dashboard configuration.
 *
 * tomtomKey: leave empty to run in demo mode, or paste a key via the
 * Settings dialog in the UI (stored only in your browser). If you deploy
 * publicly with a key here, restrict the key to your domain in the
 * TomTom developer portal.
 */
window.TRAFFIC_CONFIG = {
  tomtomKey: "",

  // How often to poll live data, in seconds. Each refresh costs one Flow
  // request per corridor plus one Incident request. The TomTom free tier
  // allows 2,500 non-tile requests/day, so 300s (5 min) with 18 corridors
  // gives roughly 10 hours of viewing a day.
  refreshSeconds: 300,

  // How many hours of congestion-trend history to keep in the browser.
  historyHours: 24,

  map: { center: [17.415, 78.455], zoom: 12 },

  // Greater Hyderabad bounding box: [minLon, minLat, maxLon, maxLat]
  bbox: [78.25, 17.28, 78.65, 17.58],

  /*
   * Monitored corridors. lat/lon is a point on the road; TomTom snaps it to
   * the nearest road segment. ff (free-flow km/h) and load (how
   * rush-hour-sensitive the corridor is) are only used by demo mode.
   */
  corridors: [
    { id: "hitech",     name: "Hitech City Rd (Cyber Towers)", area: "Madhapur",       lat: 17.4504, lon: 78.3810, ff: 45, load: 1.15 },
    { id: "biodiv",     name: "Biodiversity Junction",         area: "Gachibowli",     lat: 17.4318, lon: 78.3866, ff: 50, load: 1.10 },
    { id: "gachi",      name: "Gachibowli Flyover",            area: "Gachibowli",     lat: 17.4401, lon: 78.3489, ff: 55, load: 1.00 },
    { id: "orr-nkg",    name: "ORR at Nanakramguda",           area: "Financial Dist.",lat: 17.4180, lon: 78.3380, ff: 90, load: 0.65 },
    { id: "jhcp",       name: "Jubilee Hills Checkpost",       area: "Jubilee Hills",  lat: 17.4300, lon: 78.4105, ff: 40, load: 1.05 },
    { id: "panjagutta", name: "Panjagutta Junction",           area: "Panjagutta",     lat: 17.4265, lon: 78.4510, ff: 40, load: 1.10 },
    { id: "ameerpet",   name: "Ameerpet X Roads",              area: "Ameerpet",       lat: 17.4375, lon: 78.4483, ff: 40, load: 1.05 },
    { id: "begumpet",   name: "Begumpet Rd (Greenlands)",      area: "Begumpet",       lat: 17.4440, lon: 78.4630, ff: 50, load: 0.95 },
    { id: "kphb",       name: "Kukatpally (KPHB)",             area: "Kukatpally",     lat: 17.4930, lon: 78.3990, ff: 50, load: 1.00 },
    { id: "miyapur",    name: "Miyapur X Roads",               area: "Miyapur",        lat: 17.4960, lon: 78.3570, ff: 50, load: 0.90 },
    { id: "paradise",   name: "Paradise Circle",               area: "Secunderabad",   lat: 17.4434, lon: 78.4867, ff: 40, load: 1.00 },
    { id: "tankbund",   name: "Tank Bund Rd",                  area: "Hussain Sagar",  lat: 17.4239, lon: 78.4738, ff: 45, load: 0.85 },
    { id: "mehdipatnam",name: "Mehdipatnam",                   area: "Mehdipatnam",    lat: 17.3950, lon: 78.4400, ff: 40, load: 1.00 },
    { id: "pvnr",       name: "PVNR Expressway (Attapur)",     area: "Attapur",        lat: 17.3710, lon: 78.4320, ff: 75, load: 0.60 },
    { id: "koti",       name: "Koti / Afzalgunj",              area: "Old City",       lat: 17.3820, lon: 78.4830, ff: 35, load: 1.00 },
    { id: "dsnr",       name: "Dilsukhnagar",                  area: "Dilsukhnagar",   lat: 17.3688, lon: 78.5247, ff: 45, load: 1.00 },
    { id: "lbnagar",    name: "LB Nagar Junction",             area: "LB Nagar",       lat: 17.3480, lon: 78.5510, ff: 50, load: 0.95 },
    { id: "uppal",      name: "Uppal X Roads",                 area: "Uppal",          lat: 17.4005, lon: 78.5590, ff: 50, load: 1.00 }
  ]
};
