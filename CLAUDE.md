# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Glance Dashboard" — a Chrome **Manifest V3** extension that overrides the new-tab page (`chrome_url_overrides.newtab` → `newtab.html`) with a four-card dashboard: weather, air quality (KHAI), KOSPI, and USD/KRW. No bundler, no build step, no tests, no npm. The extension is the source: `manifest.json` + `newtab.html` + `app.js` + `styles.css` + `icons/`.

## Loading / iterating

- Load the extension via `chrome://extensions` → *Developer mode* → *Load unpacked* → select this directory.
- After editing any file, hit the reload icon on the extension card in `chrome://extensions`, then open a new tab.
- DevTools for the dashboard: open a new tab, then ⌘⌥I — this is a regular page context, not a service worker, so `console.log` / Network panel work normally.
- Regenerate the icons (only if the brand mark changes) with `python3 build_icons.py` — pure stdlib, writes `icons/icon{16,48,128}.png`.

## Architecture — the non-obvious part

The weather and air-quality cards do **not** call public APIs. They scrape `weather.naver.com/today/{regionCode}` and parse a `var blockApiResult = {...}` blob embedded in the HTML (`fetchNaverWeather` in `app.js`). This is intentional — it gives us KMA (기상청) weather and AirKorea (에어코리아) KHAI data without an API key, but it means:

- **One Naver page fetch backs two cards.** `lastNaverData` is a module-level cache populated by `loadNaverData(regionCode)` before `loadWeather()` and `loadAir()` run. Don't refactor those two into independent fetchers — you'd double the scrape traffic.
- **The parsing regex is brittle** by nature. If Naver changes the page shape, both cards break together; the regex in `fetchNaverWeather` is the first place to look.
- **`host_permissions` in `manifest.json` is the allowlist** for every cross-origin fetch (`weather.naver.com`, `nominatim.openstreetmap.org`, `open.er-api.com`, `query1.finance.yahoo.com`). Adding a new data source requires adding its host here, otherwise `fetch()` is blocked at the extension boundary.

### Location resolution pipeline

`getNaverRegion()` chains four steps to map the user to a Naver `regionCode`:

1. `navigator.geolocation` → `{lat, lon}` (prompts the user; falls back to Naver IP default on denial/timeout).
2. Nominatim reverse geocode → Korean `{city, gu, dong}` (rejects non-KR via `country_code !== 'kr'`).
3. `weather.naver.com/search/api/searchRegion?keyword=...` → list of region matches.
4. Best-match selection: exact `city+gu+dong`, else `gu+dong`, else first result.

The resolution is cached in `localStorage` under `glance.naverRegion.v1`, keyed by coords rounded to 3 decimal places (~100 m). When debugging "wrong region", clear this key in DevTools → Application → Local Storage.

### Refresh orchestration

`refreshAll()` in `app.js`:
- Fires KOSPI (Yahoo `^KS11`) and FX (`open.er-api.com`) in parallel immediately — they don't need region resolution.
- Awaits region resolution + Naver page fetch sequentially (the page fetch depends on `regionCode`).
- `Promise.allSettled` joins all four cards so one failure doesn't poison the others; each card sets its own error state via `setError(cardId, statusId, msg)`.
- Auto-refresh runs every 5 min and is paused via `visibilitychange` when the tab is hidden.

### Air-quality grading

`khaiVisual(khai, grade)` colors the ring by Korean grade text (`좋음 / 보통 / 나쁨 / 매우나쁨`), **not** by numeric thresholds — Naver/AirKorea's bucketing is the source of truth, and it differs from US AQI. Note `보통` is mapped to blue (matches Naver), not yellow. KHAI percentage fill saturates at 250 (real-world ceiling), not at the theoretical 500 max.

## Data-source preferences

Korea-specific cards must use Korean-native sources (KMA via Naver for weather, AirKorea KHAI for air). Don't swap in OpenWeatherMap, AQICN, or similar — the user prefers domestic data.
