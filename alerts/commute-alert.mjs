/*
 * Commute traffic alert.
 *
 * Run on a schedule by .github/workflows/commute-alerts.yml. Checks the
 * commute with live traffic (TomTom Routing API) and, if traffic is heavy,
 * sends a message to your phone via Telegram and/or ntfy.
 *
 * Everything personal comes from GitHub secrets, never from this file:
 *   TOMTOM_KEY                       TomTom API key
 *   HOME_COORDS, WORK_COORDS         "lat, lon", e.g. "17.45040, 78.38100"
 *   TELEGRAM_BOT_TOKEN (+ TELEGRAM_CHAT_ID)   and/or   NTFY_TOPIC
 * Optional repository variables:
 *   ALERT_EXTRA_PCT   alert when the trip takes this % longer than on empty
 *                     roads (default 50, the dashboard's "Heavy" level)
 *   EVENING_DEPART / MORNING_DEPART   usual departure, "HH:MM" IST
 *
 * The repository is public, so its Actions logs are public too: this script
 * never logs places, road names or message text.
 */

const env = process.env;
const DASHBOARD_URL = "https://tejacharan239.github.io/Traffic_Hyderabad/";
const EXTRA_PCT = Number(env.ALERT_EXTRA_PCT) || 50;
const FORCE = env.FORCE === "true";
const TRIPS = {
  // window: only alert between these IST times (scheduled runs can start late)
  toHome: { label: "home", depart: env.EVENING_DEPART || "17:00", window: ["16:15", "17:30"] },
  toWork: { label: "work", depart: env.MORNING_DEPART || "07:00", window: ["06:15", "07:30"] }
};

const log = (...a) => console.log(...a);

/* ---------- time helpers (IST = UTC+5:30) ---------- */
const IST_MS = 5.5 * 3600e3;
function istNow() {
  const d = new Date(Date.now() + IST_MS);
  const minutes = env.TEST_TIME_IST ? toMin(env.TEST_TIME_IST) : d.getUTCHours() * 60 + d.getUTCMinutes(); // override for testing
  return { date: d.toISOString().slice(0, 10), minutes };
}
const toMin = hhmm => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const fmtClock = min => {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const fmtDur = s => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const isoAtIst = (date, min) => `${date}T${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:00+05:30`;

/* ---------- TomTom ---------- */
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TomTom request failed: HTTP ${res.status}`); // no URL: it holds the key and places
  return res.json();
}

function parseCoords(name, value) {
  const m = String(value || "").match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) throw new Error(`${name} must look like "17.45040, 78.38100"`);
  return { lat: Number(m[1]), lon: Number(m[2]) };
}

function viaRoads(guidance, total) {
  const ins = (guidance && guidance.instructions) || [];
  const byRoad = new Map();
  for (let i = 0; i < ins.length - 1; i++) {
    const name = ins[i].street || (ins[i].roadNumbers && ins[i].roadNumbers[0]);
    if (!name) continue;
    byRoad.set(name, (byRoad.get(name) || 0) + ins[i + 1].routeOffsetInMeters - ins[i].routeOffsetInMeters);
  }
  return [...byRoad.entries()].filter(([, len]) => len >= Math.max(1500, total * 0.08))
    .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n]) => n);
}

async function routes(key, from, to, { departAt, alternatives = 2, details = true } = {}) {
  let url = `https://api.tomtom.com/routing/1/calculateRoute/${from.lat},${from.lon}:${to.lat},${to.lon}/json` +
    `?key=${encodeURIComponent(key)}&traffic=true&travelMode=car&routeType=fastest` +
    `&maxAlternatives=${alternatives}&computeTravelTimeFor=all`;
  if (details) url += "&instructionsType=text&language=en-GB";
  if (departAt) url += `&departAt=${encodeURIComponent(departAt)}`;
  const json = await getJson(url);
  return (json.routes || []).map(r => ({
    time: r.summary.travelTimeInSeconds,
    empty: r.summary.noTrafficTravelTimeInSeconds,
    usual: r.summary.historicTrafficTravelTimeInSeconds,
    length: r.summary.lengthInMeters,
    via: details ? viaRoads(r.guidance, r.summary.lengthInMeters) : [],
    points: (r.legs || []).flatMap(l => (l.points || []).map(p => [p.latitude, p.longitude]))
  })).sort((a, b) => a.time - b.time);
}

const CATEGORY = { 1: "Accident", 3: "Dangerous conditions", 4: "Rain", 6: "Traffic jam", 7: "Lane closed",
  8: "Road closed", 9: "Road works", 11: "Flooding", 14: "Broken-down vehicle" };

// Distance in metres from point p to the segment a-b (all [lat, lon]); flat-earth is fine at city scale.
function metersToSegment(p, a, b) {
  const k = 111320, c = Math.cos(p[0] * Math.PI / 180);
  const ax = (a[1] - p[1]) * k * c, ay = (a[0] - p[0]) * k;
  const bx = (b[1] - p[1]) * k * c, by = (b[0] - p[0]) * k;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
const nearRoute = (p, route, maxM) => route.some((a, i) => i > 0 && metersToSegment(p, route[i - 1], a) < maxM);

// Incidents (moderate or worse, not long-term closures) within ~250 m of the route.
async function incidentsOnRoute(key, points) {
  if (!points.length) return [];
  const lats = points.map(p => p[0]), lons = points.map(p => p[1]);
  const pad = 0.005;
  const bbox = [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad];
  const fields = "{incidents{geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,events{description},from,to,delay}}}";
  const json = await getJson(`https://api.tomtom.com/traffic/services/5/incidentDetails?bbox=${bbox.join(",")}` +
    `&fields=${encodeURIComponent(fields)}&language=en-GB&timeValidityFilter=present&key=${encodeURIComponent(key)}`);
  return (json.incidents || []).filter(f => {
    const p = f.properties || {};
    if (p.magnitudeOfDelay < 2 || p.magnitudeOfDelay === 4) return false;
    const g = f.geometry || {};
    const pts = g.type === "Point" ? [g.coordinates] : g.coordinates || [];
    return pts.some(([lon, lat]) => nearRoute([lat, lon], points, 250));
  }).map(f => {
    const p = f.properties;
    const what = (p.events && p.events[0] && p.events[0].description) || CATEGORY[p.iconCategory] || "Incident";
    const where = [p.from, p.to].filter(Boolean).join(" → ");
    return `${what}${where ? ` – ${where}` : ""}${p.delay ? ` (+${Math.round(p.delay / 60)} min)` : ""}`;
  }).slice(0, 3);
}

/* ---------- delivery ---------- */
async function sendTelegram(title, body) {
  const token = env.TELEGRAM_BOT_TOKEN;
  let chatId = env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    // First-time setup: find the chat from the message the user sent the bot.
    const upd = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates`)).json();
    const msg = (upd.result || []).map(u => u.message || u.edited_message).filter(Boolean).pop();
    if (!msg) throw new Error("Telegram: send any message to your bot first, then run this again");
    chatId = msg.chat.id;
    body += `\n\nSetup: your chat ID is ${chatId}. Add it as the TELEGRAM_CHAT_ID secret so alerts keep working.`;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: `${title}\n\n${body}`, disable_web_page_preview: true })
  });
  if (!res.ok) throw new Error(`Telegram send failed: HTTP ${res.status}`);
}

async function sendNtfy(title, body, urgent) {
  // JSON publishing, so the title can contain emoji (HTTP headers can't).
  const res = await fetch("https://ntfy.sh/", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message: body, priority: urgent ? 4 : 3, click: DASHBOARD_URL })
  });
  if (!res.ok) throw new Error(`ntfy send failed: HTTP ${res.status}`);
}

async function notify(title, body, urgent) {
  const channels = [];
  if (env.TELEGRAM_BOT_TOKEN) channels.push(["Telegram", () => sendTelegram(title, body)]);
  if (env.NTFY_TOPIC) channels.push(["ntfy", () => sendNtfy(title, body, urgent)]);
  let sent = 0;
  for (const [name, send] of channels) {
    try { await send(); sent++; log(`Sent via ${name}.`); }
    catch (err) { log(`Could not send via ${name}: ${err.message}`); }
  }
  if (!sent) throw new Error("No message could be sent");
}

/* ---------- main ---------- */
async function main() {
  const missing = ["TOMTOM_KEY", "HOME_COORDS", "WORK_COORDS"].filter(k => !env[k]);
  if (!env.TELEGRAM_BOT_TOKEN && !env.NTFY_TOPIC) missing.push("TELEGRAM_BOT_TOKEN or NTFY_TOPIC");
  if (missing.length) {
    log(`Alerts are not set up yet. Missing secrets: ${missing.join(", ")}. See README → Commute alerts.`);
    return; // exit cleanly so unconfigured forks don't get failure emails
  }
  const home = parseCoords("HOME_COORDS", env.HOME_COORDS);
  const work = parseCoords("WORK_COORDS", env.WORK_COORDS);

  const now = istNow();
  const dir = now.minutes < 12 * 60 ? "toWork" : "toHome";
  const trip = TRIPS[dir];
  const [from, to] = dir === "toWork" ? [home, work] : [work, home];

  if (!FORCE && (now.minutes < toMin(trip.window[0]) || now.minutes > toMin(trip.window[1]))) {
    log(`Outside the alert window (${trip.window.join("–")} IST); this run started late, skipping.`);
    return;
  }

  const rs = await routes(env.TOMTOM_KEY, from, to);
  if (!rs.length) throw new Error("TomTom returned no route");
  const best = rs[0];
  const extra = best.empty ? (best.time / best.empty - 1) * 100 : 0;
  const heavy = extra >= EXTRA_PCT;
  log(`Checked route to ${trip.label}: ${heavy ? "HEAVY" : "normal"} (${Math.round(extra)}% over empty roads; threshold ${EXTRA_PCT}%).`);

  if (!heavy && !FORCE) { log("No alert needed."); return; }

  const lines = [];
  const usual = best.usual ? `usually ${fmtDur(best.usual)}` : "";
  lines.push(`Now: ${fmtDur(best.time)}${usual ? ` (${usual}, ${fmtDur(best.empty)} on empty roads)` : ""}`);
  lines.push(`Fastest: ${best.via.length ? "via " + best.via.join(", ") + " · " : ""}${(best.length / 1000).toFixed(0)} km`);
  for (const r of rs.slice(1)) {
    lines.push(`Other route: ${r.via.length ? "via " + r.via.join(", ") + " · " : ""}${fmtDur(r.time)}`);
  }

  // When is it better to leave? Predicted times for the next half-hour slots.
  const departMin = toMin(trip.depart);
  const firstSlot = Math.max(departMin, Math.ceil((now.minutes + 10) / 30) * 30);
  const slots = [firstSlot, firstSlot + 30, firstSlot + 60];
  const predictions = await Promise.all(slots.map(m =>
    routes(env.TOMTOM_KEY, from, to, { departAt: isoAtIst(now.date, m), alternatives: 0, details: false })
      .then(r => r[0] ? `  ${fmtClock(m)} → ${fmtDur(r[0].time)}` : null, () => null)));
  if (predictions.some(Boolean)) lines.push("", "If you leave at:", ...predictions.filter(Boolean));

  try {
    const inc = await incidentsOnRoute(env.TOMTOM_KEY, best.points);
    if (inc.length) lines.push("", "On your route:", ...inc.map(i => `  ⚠ ${i}`));
  } catch { /* incidents are a bonus; don't fail the alert */ }

  lines.push("", `Live dashboard: ${DASHBOARD_URL}`);

  const title = heavy
    ? `🚗 Heavy traffic on your way ${trip.label}: ${fmtDur(best.time)}`
    : `✅ Test: traffic on your way ${trip.label} is normal (${fmtDur(best.time)})`;
  await notify(title, lines.join("\n"), heavy);
}

main().catch(err => { console.error(`Alert check failed: ${err.message}`); process.exit(1); });
