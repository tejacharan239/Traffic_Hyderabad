/* Hyderabad Traffic Live - UI and refresh loop. */
(function () {
  "use strict";

  const cfg = window.TRAFFIC_CONFIG;
  const { fetchLive, fetchDemo } = window.TrafficData;
  const $ = id => document.getElementById(id);

  /* ---------------- storage (best effort) ---------------- */
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem("hydtraffic." + k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem("hydtraffic." + k, JSON.stringify(v)); } catch { /* storage unavailable */ } }
  };

  /* ---------------- state ---------------- */
  const state = {
    key: store.get("key", "") || cfg.tomtomKey || "",
    refreshSec: store.get("refreshSec", cfg.refreshSeconds),
    rangeHours: store.get("rangeHours", 6),
    sort: store.get("sort", "congestion"),
    readings: [],
    incidents: [],
    lastUpdated: null,
    nextAt: 0,
    loading: false,
    error: null
  };
  const isLive = () => Boolean(state.key);

  /* ---------------- metrics ---------------- */
  const STATUS = {
    free:     { label: "Free flow" },
    moderate: { label: "Moderate" },
    heavy:    { label: "Heavy" },
    severe:   { label: "Severe" },
    closed:   { label: "Closed" },
    unknown:  { label: "No data" }
  };
  const STATUS_ORDER = ["free", "moderate", "heavy", "severe", "closed"];

  // Congestion = extra travel time vs free flow, in percent (TomTom-index style).
  function congestionOf(r) {
    if (!r || r.roadClosure) return null;
    if (r.currentTravelTime && r.freeFlowTravelTime) return Math.max(0, (r.currentTravelTime / r.freeFlowTravelTime - 1) * 100);
    if (r.currentSpeed > 0) return Math.max(0, (r.freeFlowSpeed / r.currentSpeed - 1) * 100);
    return null;
  }
  function statusKey(pct, closed) {
    if (closed) return "closed";
    if (pct == null) return "unknown";
    if (pct < 20) return "free";
    if (pct < 50) return "moderate";
    if (pct < 100) return "heavy";
    return "severe";
  }
  const statusOf = r => statusKey(congestionOf(r), r && r.roadClosure);

  function cityMetrics(readings) {
    const open = readings.filter(r => !r.roadClosure && r.currentTravelTime && r.freeFlowTravelTime);
    const cur = open.reduce((s, r) => s + r.currentTravelTime, 0);
    const ff = open.reduce((s, r) => s + r.freeFlowTravelTime, 0);
    const speeds = readings.filter(r => !r.roadClosure && r.currentSpeed > 0);
    return {
      index: ff ? Math.max(0, (cur / ff - 1) * 100) : null,
      avgSpeed: speeds.length ? speeds.reduce((s, r) => s + r.currentSpeed, 0) / speeds.length : null,
      avgFree: speeds.length ? speeds.reduce((s, r) => s + r.freeFlowSpeed, 0) / speeds.length : null
    };
  }

  /* ---------------- formatting ---------------- */
  const IST = { timeZone: "Asia/Kolkata" };
  const fmtTime = t => new Date(t).toLocaleTimeString("en-IN", { ...IST, hour: "2-digit", minute: "2-digit" });
  const fmtClock = t => new Date(t).toLocaleTimeString("en-IN", { ...IST, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const fmtDelay = s => s < 60 ? `+${Math.max(0, Math.round(s))} s` : `+${Math.round(s / 60)} min`;
  const fmtPct = p => p == null ? "–" : String(Math.round(p));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m ago`;
  }
  const statusChip = k => `<span class="status s-${k}"><i aria-hidden="true"></i>${STATUS[k].label}</span>`;
  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const statusColor = k => cssVar(`--st-${k}`);

  /* ---------------- theme ---------------- */
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  function effectiveDark() {
    const t = document.documentElement.dataset.theme;
    return t ? t === "dark" : darkQuery.matches;
  }
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    updateBaseLayer();
    if (state.readings.length) { renderMap(); renderTrend(); }
  }

  /* ---------------- map ---------------- */
  const map = L.map("map", { zoomControl: true, attributionControl: true }).setView(cfg.map.center, cfg.map.zoom);
  const baseLayers = {
    light: L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }),
    dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    })
  };
  let currentBase = null;
  function updateBaseLayer() {
    const want = effectiveDark() ? baseLayers.dark : baseLayers.light;
    if (currentBase === want) return;
    if (currentBase) map.removeLayer(currentBase);
    want.addTo(map).bringToBack();
    currentBase = want;
  }
  updateBaseLayer();

  const corridorLayer = L.layerGroup().addTo(map);
  const incidentLayer = L.layerGroup().addTo(map);
  let flowTiles = null;
  const layerControl = L.control.layers(null, { "Monitored corridors": corridorLayer, "Incidents": incidentLayer }, { collapsed: true }).addTo(map);
  const corridorMarkers = new Map();
  const incidentMarkers = new Map();

  function syncFlowTiles() {
    if (isLive() && !flowTiles) {
      flowTiles = L.tileLayer(`https://{s}.api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${encodeURIComponent(state.key)}`, {
        subdomains: "abcd", maxZoom: 22, opacity: 0.85, zIndex: 5,
        attribution: 'Traffic &copy; <a href="https://www.tomtom.com">TomTom</a>'
      }).addTo(map);
      layerControl.addOverlay(flowTiles, "All-road traffic flow (TomTom)");
    } else if (!isLive() && flowTiles) {
      layerControl.removeLayer(flowTiles);
      map.removeLayer(flowTiles);
      flowTiles = null;
    }
    $("map-note").textContent = isLive()
      ? "TomTom live flow on all roads · monitored corridors outlined"
      : "Corridor segments coloured by congestion (demo)";
  }

  function corridorPopup(c, r) {
    const pct = congestionOf(r);
    const k = statusOf(r);
    const delay = r ? (r.currentTravelTime - r.freeFlowTravelTime) : 0;
    const gmaps = `https://www.google.com/maps/@${c.lat},${c.lon},16z/data=!5m1!1e1`;
    return `<div class="popup">
      <h3>${esc(c.name)}</h3>
      <div class="row">${esc(c.area)}</div>
      <div class="row" style="margin:6px 0">${statusChip(k)}</div>
      ${r && r.roadClosure ? `<div class="row">Road reported <b>closed</b> on this segment</div>` : r ? `<div class="row">Speed <b>${Math.round(r.currentSpeed)} km/h</b> (free flow ${Math.round(r.freeFlowSpeed)})</div>
      <div class="row">Congestion <b>${fmtPct(pct)}%</b> extra time · delay <b>${fmtDelay(delay)}</b></div>` : `<div class="row">No reading this cycle</div>`}
      <div class="row" style="margin-top:6px"><a href="${gmaps}" target="_blank" rel="noopener">Open in Google Maps traffic ↗</a></div>
    </div>`;
  }

  function renderMap() {
    corridorLayer.clearLayers();
    corridorMarkers.clear();
    const byId = new Map(state.readings.map(r => [r.id, r]));
    const surface = cssVar("--surface");
    for (const c of cfg.corridors) {
      const r = byId.get(c.id);
      const k = statusOf(r);
      const color = statusColor(k);
      const group = L.featureGroup();
      // Demo readings have no real road geometry, so only live data draws segments.
      if (isLive() && r && r.coords && r.coords.length > 1) {
        L.polyline(r.coords, { color: surface, weight: 10, opacity: 0.95, interactive: false }).addTo(group);
        L.polyline(r.coords, { color, weight: 6, opacity: 1, lineCap: "round" }).addTo(group);
      }
      const dot = L.circleMarker([c.lat, c.lon], { radius: isLive() ? 7 : 9, color: surface, weight: 2, fillColor: color, fillOpacity: 1 }).addTo(group);
      dot.bindTooltip(`${esc(c.name)} · ${STATUS[k].label}`, { direction: "top", offset: [0, -6] });
      group.bindPopup(corridorPopup(c, r));
      group.addTo(corridorLayer);
      corridorMarkers.set(c.id, { group, dot });
    }
  }

  function renderIncidentMarkers() {
    incidentLayer.clearLayers();
    incidentMarkers.clear();
    for (const inc of state.incidents) {
      const icon = L.divIcon({ className: "", html: `<div class="inc-marker m${inc.magnitude}">!</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
      const m = L.marker([inc.lat, inc.lon], { icon, title: inc.category, keyboard: false });
      m.bindPopup(`<div class="popup"><h3>${esc(inc.category)}</h3>
        <div class="row">${esc(inc.description)}</div>
        ${inc.from || inc.to ? `<div class="row">${esc(inc.from)}${inc.to ? " → " + esc(inc.to) : ""}</div>` : ""}
        ${inc.delay ? `<div class="row">Delay <b>${fmtDelay(inc.delay)}</b></div>` : ""}
        ${inc.startTime ? `<div class="row">Since ${fmtTime(inc.startTime)} IST</div>` : ""}</div>`);
      m.addTo(incidentLayer);
      incidentMarkers.set(inc.id, m);
    }
  }

  /* ---------------- KPIs ---------------- */
  function renderKpis() {
    const m = cityMetrics(state.readings);
    const k = statusKey(m.index, false);
    $("kpi-index").textContent = fmtPct(m.index);
    $("kpi-index-sub").innerHTML = `${statusChip(k)}<span>extra travel time vs free flow</span>`;
    $("kpi-speed").textContent = m.avgSpeed == null ? "–" : Math.round(m.avgSpeed);
    $("kpi-speed-sub").textContent = m.avgFree == null ? "across monitored corridors" : `free flow ${Math.round(m.avgFree)} km/h`;

    const major = state.incidents.filter(i => i.magnitude >= 3).length;
    $("kpi-incidents").textContent = state.incidents.length;
    $("kpi-incidents-sub").textContent = major ? `${major} major or closure` : "in Greater Hyderabad";

    const counts = Object.fromEntries(STATUS_ORDER.map(s => [s, 0]));
    for (const c of cfg.corridors) {
      const r = state.readings.find(x => x.id === c.id);
      const s = statusOf(r);
      if (s in counts) counts[s]++;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    $("segbar").innerHTML = STATUS_ORDER.filter(s => counts[s]).map(s =>
      `<span class="seg s-${s}" style="flex-grow:${counts[s]}" title="${STATUS[s].label}: ${counts[s]} of ${total}"></span>`).join("");
    $("segbar").setAttribute("aria-label", STATUS_ORDER.map(s => `${STATUS[s].label} ${counts[s]}`).join(", "));
    $("seg-legend").innerHTML = STATUS_ORDER.filter(s => s !== "closed" || counts.closed).map(s =>
      `<li>${statusChip(s)}<b>${counts[s]}</b></li>`).join("");
  }

  /* ---------------- corridor table ---------------- */
  function renderTable() {
    const byId = new Map(state.readings.map(r => [r.id, r]));
    const rows = cfg.corridors.map(c => {
      const r = byId.get(c.id);
      const pct = congestionOf(r);
      return { c, r, pct, k: statusOf(r), delay: r ? r.currentTravelTime - r.freeFlowTravelTime : -1 };
    });
    const closedFirst = x => (x.k === "closed" ? 1e9 : x.pct ?? -1);
    const sorters = {
      congestion: (a, b) => closedFirst(b) - closedFirst(a),
      delay: (a, b) => b.delay - a.delay,
      speed: (a, b) => (a.r ? a.r.currentSpeed : 1e9) - (b.r ? b.r.currentSpeed : 1e9),
      name: (a, b) => a.c.name.localeCompare(b.c.name)
    };
    rows.sort(sorters[state.sort] || sorters.congestion);
    $("corridor-rows").innerHTML = rows.map(({ c, r, pct, k, delay }) => `
      <tr data-id="${esc(c.id)}" tabindex="0">
        <td><div class="c-name">${esc(c.name)}</div><div class="c-area">${esc(c.area)}</div><div class="only-narrow">${statusChip(k)}</div></td>
        <td class="col-status">${statusChip(k)}<div class="meter" aria-hidden="true"><span style="width:${Math.min(100, (pct || 0) / 1.5)}%;background:${statusColor(k)}"></span></div></td>
        <td class="num">${r && !r.roadClosure ? `${Math.round(r.currentSpeed)} km/h<div class="c-ff">of ${Math.round(r.freeFlowSpeed)}</div>` : "–"}</td>
        <td class="num">${r && !r.roadClosure ? fmtDelay(delay) + `<div class="c-ff">${fmtPct(pct)}% extra</div>` : "–"}</td>
      </tr>`).join("");
  }

  function focusCorridor(id) {
    const entry = corridorMarkers.get(id);
    const c = cfg.corridors.find(x => x.id === id);
    if (!entry || !c) return;
    map.flyTo([c.lat, c.lon], 15, { duration: 0.6 });
    entry.group.openPopup([c.lat, c.lon]);
    if (window.matchMedia("(max-width: 1100px)").matches) $("map").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ---------------- incidents list ---------------- */
  function renderIncidents() {
    const list = [...state.incidents].sort((a, b) => b.magnitude - a.magnitude || b.delay - a.delay);
    $("incident-note").textContent = list.length ? `${list.length} active · sorted by severity` : "";
    $("incident-list").innerHTML = list.length ? list.map(i => `
      <li data-id="${esc(i.id)}" tabindex="0">
        <div class="inc-marker m${i.magnitude}" aria-hidden="true">!</div>
        <div><div class="inc-title">${esc(i.category)}</div>
          <div class="inc-meta">${esc(i.description !== i.category ? i.description : "")}${i.from ? `${i.description !== i.category ? " · " : ""}${esc(i.from)}${i.to ? " → " + esc(i.to) : ""}` : ""}</div></div>
        <div class="inc-delay">${i.magnitude === 4 ? "Closed" : i.delay ? fmtDelay(i.delay) : ""}<small>${["Unknown", "Minor", "Moderate", "Major", "Closure"][i.magnitude] || ""}</small></div>
      </li>`).join("") : `<li class="none">No incidents reported right now.</li>`;
  }

  function focusIncident(id) {
    const m = incidentMarkers.get(id);
    if (!m) return;
    map.flyTo(m.getLatLng(), 15, { duration: 0.6 });
    m.openPopup();
    if (window.matchMedia("(max-width: 1100px)").matches) $("map").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ---------------- history ---------------- */
  function liveHistory() { return store.get("history", []); }
  function pushHistory(t, index) {
    if (index == null) return;
    const cutoff = t - cfg.historyHours * 3600e3;
    const h = liveHistory().filter(p => p.t >= cutoff);
    h.push({ t, v: Math.round(index * 10) / 10 });
    store.set("history", h);
  }
  // Demo mode: synthesise history from the simulator so the chart has shape.
  function demoHistory(now) {
    const out = [];
    const step = 10 * 60e3;
    for (let t = now - cfg.historyHours * 3600e3; t <= now; t += step) {
      out.push({ t, v: cityMetrics(fetchDemo(cfg, t).readings).index });
    }
    return out;
  }

  /* ---------------- trend chart (SVG) ---------------- */
  const tooltip = $("tooltip");
  function showTip(x, y, html) {
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
    let left = x + 14, top = y - h - 10;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top < 8) top = y + 14;
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
  }
  const hideTip = () => { tooltip.hidden = true; };

  function niceMax(v) {
    const m = Math.max(50, v * 1.1);
    const step = m <= 100 ? 25 : m <= 200 ? 50 : 100;
    return Math.ceil(m / step) * step;
  }

  function renderTrend() {
    const el = $("trend");
    const now = Date.now();
    const all = isLive() ? liveHistory() : demoHistory(now);
    const from = now - state.rangeHours * 3600e3;
    const pts = all.filter(p => p.t >= from && p.v != null);

    const W = Math.max(280, el.clientWidth - 24), H = 260;
    const m = { l: 40, r: 12, t: 12, b: 28 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const yMax = niceMax(pts.reduce((a, p) => Math.max(a, p.v), 0));
    const x = t => m.l + ((t - from) / (now - from)) * iw;
    const y = v => m.t + ih - (v / yMax) * ih;

    const yStep = yMax <= 100 ? 25 : yMax <= 200 ? 50 : 100;
    let grid = "";
    for (let v = 0; v <= yMax; v += yStep) {
      grid += `<line class="${v === 0 ? "baseline" : "gridline"}" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
      grid += `<text class="tick" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`;
    }
    const tickEvery = state.rangeHours <= 3 ? 0.5 : state.rangeHours <= 6 ? 1 : 4;
    // Align ticks to round IST clock times (IST = UTC+5:30).
    const stepMs = tickEvery * 3600e3, istOffset = 5.5 * 3600e3;
    const firstTick = Math.ceil((from + istOffset) / stepMs) * stepMs - istOffset;
    let xt = "", lastX = -Infinity;
    for (let t = firstTick; t <= now; t += stepMs) {
      if (x(t) - lastX < 72) continue; // keep labels from colliding on narrow screens
      lastX = x(t);
      xt += `<text class="tick" x="${x(t)}" y="${H - 8}" text-anchor="middle">${fmtTime(t)}</text>`;
    }

    let body;
    if (pts.length < 2) {
      body = `<text class="empty" x="${m.l + iw / 2}" y="${m.t + ih / 2}" text-anchor="middle">Collecting data — the trend appears after a couple of refreshes.</text>`;
    } else {
      const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
      const area = `${d}L${x(pts[pts.length - 1].t).toFixed(1)},${y(0)}L${x(pts[0].t).toFixed(1)},${y(0)}Z`;
      const last = pts[pts.length - 1];
      body = `<path class="area" d="${area}"/><path class="line" d="${d}"/>
        <circle class="dot" r="4.5" cx="${x(last.t)}" cy="${y(last.v)}"/>
        <g id="hover" style="display:none"><line class="cross" y1="${m.t}" y2="${m.t + ih}"/><circle class="dot" r="5"/></g>
        <rect id="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/>`;
    }
    const latest = pts.length ? Math.round(pts[pts.length - 1].v) : null;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="City congestion over the last ${state.rangeHours} hours${latest != null ? `, now ${latest}% extra travel time` : ""}">${grid}${xt}${body}</svg>`;

    const hit = el.querySelector("#hit");
    if (!hit) return;
    const hover = el.querySelector("#hover");
    const svg = el.querySelector("svg");
    hit.addEventListener("pointermove", ev => {
      const rect = svg.getBoundingClientRect();
      const sx = (ev.clientX - rect.left) * (W / rect.width);
      const t = from + ((sx - m.l) / iw) * (now - from);
      let best = pts[0];
      for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      hover.style.display = "";
      hover.querySelector("line").setAttribute("x1", x(best.t));
      hover.querySelector("line").setAttribute("x2", x(best.t));
      hover.querySelector("circle").setAttribute("cx", x(best.t));
      hover.querySelector("circle").setAttribute("cy", y(best.v));
      showTip(ev.clientX, ev.clientY, `<div class="t-head">${fmtTime(best.t)} IST</div>
        <div class="t-val">${Math.round(best.v)}% extra time</div>${statusChip(statusKey(best.v, false))}`);
    });
    hit.addEventListener("pointerleave", () => { hover.style.display = "none"; hideTip(); });
  }

  /* ---------------- header / banner ---------------- */
  function renderHeader() {
    const pill = $("mode-pill");
    pill.textContent = isLive() ? "Live · TomTom" : "Demo data";
    pill.classList.toggle("live", isLive());
    $("live-dot").className = "live-dot" + (state.error ? " err" : state.lastUpdated ? " on" : "");
    $("updated").textContent = state.lastUpdated ? `Updated ${fmtTime(state.lastUpdated)} IST (${ago(state.lastUpdated)})` : "Loading…";
    $("source-note").innerHTML = isLive()
      ? "Traffic data: TomTom Traffic API. Base map © OpenStreetMap contributors, © CARTO."
      : "Demo mode: traffic values are simulated from typical Hyderabad rush-hour patterns. Base map © OpenStreetMap contributors, © CARTO.";
  }

  function showBanner(kind, html) {
    const b = $("banner");
    if (!html) { b.hidden = true; return; }
    b.className = `banner ${kind}`;
    b.innerHTML = html;
    b.hidden = false;
    const btn = b.querySelector("[data-open-settings]");
    if (btn) btn.addEventListener("click", openSettings);
  }

  function updateBanner(warnings = []) {
    if (state.error) {
      showBanner("error", `<strong>Couldn't load live traffic:</strong> ${esc(state.error)}. Showing the last data received. <a href="#" data-open-settings>Check settings</a>`);
    } else if (!isLive()) {
      showBanner("info", `<strong>Demo mode.</strong> The numbers below are simulated. Add a free TomTom API key in <a href="#" data-open-settings>Settings</a> to see real-time Hyderabad traffic.`);
    } else if (warnings.length) {
      showBanner("error", esc(warnings.join(" · ")));
    } else {
      showBanner(null, null);
    }
  }

  function renderAll() {
    renderHeader();
    renderKpis();
    renderMap();
    renderIncidentMarkers();
    renderTable();
    renderIncidents();
    renderTrend();
  }

  /* ---------------- refresh loop ---------------- */
  let controller = null;
  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    $("refresh-btn").disabled = true;
    controller = new AbortController();
    let warnings = [];
    try {
      const data = isLive() ? await fetchLive(cfg, state.key, controller.signal) : fetchDemo(cfg);
      state.readings = data.readings;
      state.incidents = data.incidents;
      state.lastUpdated = Date.now();
      state.error = null;
      warnings = data.warnings;
      if (isLive()) pushHistory(state.lastUpdated, cityMetrics(state.readings).index);
    } catch (err) {
      if (err.name !== "AbortError") state.error = err.message || String(err);
    } finally {
      state.loading = false;
      $("refresh-btn").disabled = false;
      state.nextAt = Date.now() + (isLive() ? state.refreshSec : 60) * 1000;
      updateBanner(warnings);
      renderAll();
    }
  }

  function tick() {
    const now = Date.now();
    $("clock").textContent = `${fmtClock(now)} IST`;
    if (state.lastUpdated) $("updated").textContent = `Updated ${fmtTime(state.lastUpdated)} IST (${ago(state.lastUpdated)})`;
    if (state.loading) { $("countdown").textContent = "Refreshing…"; return; }
    if (document.hidden) { $("countdown").textContent = "Paused"; return; }
    const s = Math.max(0, Math.round((state.nextAt - now) / 1000));
    $("countdown").textContent = `Next update in ${s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`}`;
    if (now >= state.nextAt) refresh();
  }

  /* ---------------- settings ---------------- */
  const dialog = $("settings");
  function updateQuotaHint() {
    const sec = Number($("interval-select").value);
    const perHour = Math.round((3600 / sec) * (cfg.corridors.length + 1));
    const hours = Math.floor(2500 / perHour * 10) / 10;
    $("quota-hint").textContent = `≈ ${perHour} API requests per hour while this tab is open (free tier: 2,500/day ≈ ${hours} h of viewing).`;
  }
  function openSettings(ev) {
    if (ev) ev.preventDefault();
    $("key-input").value = state.key;
    $("interval-select").value = String(state.refreshSec);
    updateQuotaHint();
    dialog.showModal();
  }
  $("interval-select").addEventListener("change", updateQuotaHint);
  dialog.addEventListener("close", () => {
    if (dialog.returnValue !== "save") return;
    const newKey = $("key-input").value.trim();
    const keyChanged = newKey !== state.key;
    state.key = newKey;
    state.refreshSec = Number($("interval-select").value);
    store.set("key", state.key);
    store.set("refreshSec", state.refreshSec);
    if (keyChanged) {
      if (controller) controller.abort();
      state.loading = false;
      state.readings = []; state.incidents = []; state.lastUpdated = null; state.error = null;
      syncFlowTiles();
      refresh();
    } else {
      state.nextAt = Math.min(state.nextAt, Date.now() + state.refreshSec * 1000);
    }
  });

  /* ---------------- wire up ---------------- */
  $("settings-btn").addEventListener("click", openSettings);
  $("refresh-btn").addEventListener("click", refresh);
  $("theme-btn").addEventListener("click", () => {
    const next = effectiveDark() ? "light" : "dark";
    store.set("theme", next);
    applyTheme(next);
  });
  darkQuery.addEventListener("change", () => { if (!document.documentElement.dataset.theme) applyTheme(null); });

  $("sort-select").value = state.sort;
  $("sort-select").addEventListener("change", e => { state.sort = e.target.value; store.set("sort", state.sort); renderTable(); });

  const rowActivate = (sel, fn) => ev => {
    const li = ev.target.closest(sel);
    if (!li || !li.dataset.id) return;
    if (ev.type === "keydown" && ev.key !== "Enter" && ev.key !== " ") return;
    if (ev.type === "keydown") ev.preventDefault();
    fn(li.dataset.id);
  };
  for (const evt of ["click", "keydown"]) {
    $("corridor-rows").addEventListener(evt, rowActivate("tr", focusCorridor));
    $("incident-list").addEventListener(evt, rowActivate("li", focusIncident));
  }

  document.querySelectorAll(".range button").forEach(b => {
    b.classList.toggle("on", Number(b.dataset.hours) === state.rangeHours);
    b.addEventListener("click", () => {
      state.rangeHours = Number(b.dataset.hours);
      store.set("rangeHours", state.rangeHours);
      document.querySelectorAll(".range button").forEach(o => o.classList.toggle("on", o === b));
      renderTrend();
    });
  });

  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() >= state.nextAt) refresh(); });
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderTrend, 150); });

  const savedTheme = store.get("theme", null);
  if (savedTheme) applyTheme(savedTheme);
  syncFlowTiles();
  refresh();
  setInterval(tick, 1000);
  tick();
})();
