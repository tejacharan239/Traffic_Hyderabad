# Traffic_Hyderabad

Live status of Hyderabad traffic: an auto-refreshing dashboard. It monitors 18 key corridors (Hitech City, Gachibowli, Panjagutta, Ameerpet, Mehdipatnam, LB Nagar, Uppal, ORR and others) and shows city-wide congestion, active incidents and a congestion trend on an interactive map.

![Dashboard screenshot](docs/screenshot.png)

## Features

- **City congestion index**: extra travel time across the monitored corridors compared with free-flow conditions (similar to the TomTom Traffic Index).
- **Live map** (Leaflet): TomTom's live flow layer for all roads, the monitored corridors coloured by congestion, and incident markers.
- **Corridor table**: current speed vs free-flow speed, delay and status (Free flow / Moderate / Heavy / Severe / Closed), sortable. Click a row to fly to it on the map.
- **Incidents feed**: accidents, jams, road works, closures and flooding, sorted by severity.
- **Congestion trend** for 3h, 6h or 24h, stored in your browser and built up as the page refreshes.
- Auto-refresh with a countdown. Refresh pauses while the tab is hidden, to save API quota.
- Light and dark mode, and a mobile layout.
- **Demo mode** with simulated rush-hour data, used when no API key is set, so the dashboard works out of the box.

## Live data: get a free TomTom API key

Real-time data comes from the [TomTom Traffic API](https://developer.tomtom.com/traffic-api/documentation/product-information/introduction) (Flow Segment Data, Incident Details and Traffic Flow tiles).

1. Create a free account at <https://developer.tomtom.com/> and copy your API key.
2. Open the dashboard and click **Settings**.
3. Paste the key and click **Save**.

The key is stored only in your browser's `localStorage`. To deploy with a built-in key, set `tomtomKey` in [`js/config.js`](js/config.js), **and restrict the key to your domain** in the TomTom developer portal, because it will be visible to anyone who opens the page.

### Quota

Each refresh makes one Flow request per corridor (18) plus one Incidents request. The free tier allows about 2,500 non-tile requests a day:

| Refresh interval | Requests per hour | Viewing time per day on free tier |
|---|---|---|
| 1 min | 1,140 | ~2 h |
| 5 min (default) | 228 | ~11 h |
| 15 min | 76 | ~33 h |

Map traffic tiles count against a separate, larger tile quota.

## Run locally

The site is static (plain HTML, CSS and JS, with no build step).

```bash
cd Traffic_Hyderabad
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` directly also works.

## Deploy

A GitHub Actions workflow (`.github/workflows/pages.yml`) publishes the site to GitHub Pages on every push to `main`. Enable it once under **Settings → Pages → Source: GitHub Actions**.

## Customise

All tunable settings live in [`js/config.js`](js/config.js):

- `corridors`: add or remove monitored locations (`lat`/`lon` is any point on the road; TomTom snaps it to the nearest segment).
- `refreshSeconds`, `historyHours`, map centre and zoom, and the incident bounding box.

Status thresholds (extra travel time vs free flow): Free flow < 20%, Moderate 20–50%, Heavy 50–100%, Severe ≥ 100%.

## Project layout

```
index.html          page structure
css/styles.css      styles and light/dark theme tokens
js/config.js        corridors and settings
js/data.js          TomTom API client and demo-data simulator
js/app.js           UI rendering, map, chart and refresh loop
```

## Data and attribution

- Traffic data © TomTom. Base map © OpenStreetMap contributors, © CARTO.
- For official advisories and diversions, see the [Hyderabad Traffic Police](https://www.htp.gov.in/).
- Demo-mode values are simulated and are not real traffic conditions.
