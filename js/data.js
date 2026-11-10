/*
 * Data layer: live TomTom Traffic API calls, plus a clearly-labelled demo
 * simulator used when no API key is configured.
 *
 * Both sources return the same shapes:
 *   corridor reading: { id, currentSpeed, freeFlowSpeed, currentTravelTime,
 *                       freeFlowTravelTime, confidence, roadClosure, coords }
 *   incident:         { id, category, magnitude, description, from, to,
 *                       delay, length, startTime, lat, lon, line }
 */
(function () {
  "use strict";

  const TT = "https://api.tomtom.com/traffic/services";

  const INCIDENT_FIELDS =
    "{incidents{type,geometry{type,coordinates},properties{id,iconCategory," +
    "magnitudeOfDelay,events{description,code},startTime,endTime,from,to," +
    "length,delay,roadNumbers}}}";

  // TomTom iconCategory codes -> readable labels
  const CATEGORY = {
    0: "Unknown", 1: "Accident", 2: "Fog", 3: "Dangerous conditions", 4: "Rain",
    5: "Ice", 6: "Traffic jam", 7: "Lane closed", 8: "Road closed",
    9: "Road works", 10: "Wind", 11: "Flooding", 14: "Broken-down vehicle"
  };

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  async function getJson(url, signal) {
    const res = await fetch(url, { signal });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      if (res.status === 403 || res.status === 401) msg = "API key rejected (check the key and its allowed domains)";
      else if (res.status === 429) msg = "Rate limit reached - try a longer refresh interval";
      throw new ApiError(res.status, msg);
    }
    return res.json();
  }

  // Run async jobs with a small concurrency cap so we stay under QPS limits.
  async function pool(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        try { out[i] = { ok: true, value: await fn(items[i]) }; }
        catch (err) { out[i] = { ok: false, error: err }; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  /* ---------------- Live: TomTom ---------------- */

  async function liveFlow(key, corridor, signal) {
    const url = `${TT}/4/flowSegmentData/absolute/10/json` +
      `?point=${corridor.lat},${corridor.lon}&unit=KMPH&key=${encodeURIComponent(key)}`;
    const d = (await getJson(url, signal)).flowSegmentData;
    return {
      id: corridor.id,
      currentSpeed: d.currentSpeed,
      freeFlowSpeed: d.freeFlowSpeed,
      currentTravelTime: d.currentTravelTime,
      freeFlowTravelTime: d.freeFlowTravelTime,
      confidence: d.confidence,
      roadClosure: Boolean(d.roadClosure),
      coords: ((d.coordinates && d.coordinates.coordinate) || []).map(p => [p.latitude, p.longitude])
    };
  }

  async function liveIncidents(key, bbox, signal) {
    const url = `${TT}/5/incidentDetails?bbox=${bbox.join(",")}` +
      `&fields=${encodeURIComponent(INCIDENT_FIELDS)}` +
      `&language=en-GB&timeValidityFilter=present&key=${encodeURIComponent(key)}`;
    const json = await getJson(url, signal);
    return (json.incidents || []).map(f => {
      const p = f.properties || {};
      const g = f.geometry || {};
      const line = g.type === "LineString" && g.coordinates.length ? g.coordinates.map(([lon, lat]) => [lat, lon]) : null;
      const pt = g.type === "Point" ? [g.coordinates[1], g.coordinates[0]] : line && line[Math.floor(line.length / 2)];
      if (!pt) return null;
      return {
        id: p.id,
        category: CATEGORY[p.iconCategory] || "Incident",
        magnitude: p.magnitudeOfDelay ?? 0,
        description: (p.events && p.events[0] && p.events[0].description) || CATEGORY[p.iconCategory] || "Incident",
        from: p.from || "", to: p.to || "",
        delay: p.delay || 0, length: p.length || 0,
        startTime: p.startTime || null,
        lat: pt[0], lon: pt[1], line
      };
    }).filter(Boolean);
  }

  async function fetchLive(cfg, key, signal) {
    const [flows, incidents] = await Promise.all([
      pool(cfg.corridors, 4, c => liveFlow(key, c, signal)),
      liveIncidents(key, cfg.bbox, signal).then(v => ({ ok: true, value: v }), e => ({ ok: false, error: e }))
    ]);
    const readings = flows.filter(r => r.ok).map(r => r.value);
    const failures = flows.filter(r => !r.ok).map(r => r.error);
    if (!readings.length && failures.length) throw failures[0];
    return {
      readings,
      incidents: incidents.ok ? incidents.value : [],
      warnings: [
        ...(failures.length ? [`${failures.length} corridor(s) failed: ${failures[0].message}`] : []),
        ...(!incidents.ok ? [`Incidents unavailable: ${incidents.error.message}`] : [])
      ]
    };
  }

  /* ---------------- Demo simulator ---------------- */

  // Hour of day in India Standard Time (UTC+5:30), fractional.
  function istHour(t) {
    const d = new Date(t);
    return ((d.getUTCHours() + d.getUTCMinutes() / 60 + 5.5) % 24 + 24) % 24;
  }
  function istDay(t) { return new Date(t + 5.5 * 3600e3).getUTCDay(); }

  // 0..1 load curve with Hyderabad-style morning and long evening peaks.
  function rushCurve(t) {
    const h = istHour(t);
    const g = (mu, s) => Math.exp(-((h - mu) ** 2) / (2 * s * s));
    let v = 0.12 + 0.70 * g(10, 1.2) + 0.85 * g(18.8, 1.6) + 0.25 * g(14, 2.2);
    if (h < 6) v *= 0.4;
    const day = istDay(t);
    if (day === 0) v *= 0.6; else if (day === 6) v *= 0.85;
    return Math.min(1, v);
  }

  function hashStr(s) { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) / 4294967295; }
  // Smooth pseudo-noise in [-1, 1] that drifts over ~tens of minutes.
  function drift(seed, t) {
    const m = t / 60000;
    return 0.5 * Math.sin(m / 17 + seed * 40) + 0.3 * Math.sin(m / 7.3 + seed * 91) + 0.2 * Math.sin(m / 3.1 + seed * 13);
  }

  function demoReading(c, t) {
    const seed = hashStr(c.id);
    let congestion = rushCurve(t) * c.load * 0.55 + drift(seed, t) * 0.07;
    congestion = Math.max(0.02, Math.min(0.8, congestion));
    const ff = c.ff;
    const speed = Math.round(ff * (1 - congestion));
    const lengthM = 900 + Math.round(seed * 1400);
    return {
      id: c.id,
      currentSpeed: speed,
      freeFlowSpeed: ff,
      currentTravelTime: Math.round(lengthM / (speed / 3.6)),
      freeFlowTravelTime: Math.round(lengthM / (ff / 3.6)),
      confidence: 1,
      roadClosure: false,
      coords: []
    };
  }

  const DEMO_INCIDENTS = [
    { category: "Accident", magnitude: 3, description: "Accident - two vehicles, left lane blocked", from: "Raidurg", to: "Biodiversity Junction", lat: 17.4290, lon: 78.3800 },
    { category: "Road works", magnitude: 2, description: "Metro works - lane narrowed", from: "Lakdikapul", to: "Khairatabad", lat: 17.4050, lon: 78.4620 },
    { category: "Traffic jam", magnitude: 2, description: "Stationary traffic", from: "Mehdipatnam", to: "Tolichowki", lat: 17.3985, lon: 78.4270 },
    { category: "Flooding", magnitude: 3, description: "Waterlogging after rain", from: "Rajbhavan Rd", to: "Somajiguda", lat: 17.4220, lon: 78.4600 },
    { category: "Broken-down vehicle", magnitude: 1, description: "Broken-down bus", from: "Ameerpet", to: "SR Nagar", lat: 17.4410, lon: 78.4430 },
    { category: "Lane closed", magnitude: 1, description: "Right lane closed for VIP movement", from: "Begumpet", to: "Rasoolpura", lat: 17.4430, lon: 78.4760 },
    { category: "Traffic jam", magnitude: 3, description: "Queueing traffic", from: "Nagole", to: "LB Nagar", lat: 17.3600, lon: 78.5560 },
    { category: "Road closed", magnitude: 4, description: "Road closed - event", from: "Necklace Rd", to: "PVNR Marg", lat: 17.4150, lon: 78.4700 },
    { category: "Road works", magnitude: 1, description: "Flyover construction", from: "Uppal", to: "Narapally", lat: 17.4030, lon: 78.5700 }
  ];

  function demoIncidents(t) {
    const bucket = Math.floor(t / (25 * 60e3));
    const n = 3 + Math.round(rushCurve(t) * 3);
    const out = [];
    for (let i = 0; i < DEMO_INCIDENTS.length && out.length < n; i++) {
      if (hashStr(`${bucket}-${i}`) < 0.55) {
        const inc = DEMO_INCIDENTS[i];
        out.push({
          ...inc, id: `demo-${i}`,
          delay: inc.magnitude === 4 ? 0 : Math.round(60 + inc.magnitude * 180 * (0.5 + hashStr(`${bucket}d${i}`))),
          length: Math.round(300 + 1500 * hashStr(`${i}l`)),
          startTime: new Date(bucket * 25 * 60e3 - hashStr(`${i}s`) * 3600e3).toISOString(),
          line: null
        });
      }
    }
    return out;
  }

  function fetchDemo(cfg, t = Date.now()) {
    return {
      readings: cfg.corridors.map(c => demoReading(c, t)),
      incidents: demoIncidents(t),
      warnings: []
    };
  }

  window.TrafficData = { fetchLive, fetchDemo, ApiError };
})();
