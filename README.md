# Loaded Tabs Limit

Brave/Chromium (MV3, Chrome 121+) extension. Keeps the N most recently used tabs loaded (across all windows) and discards the rest with `chrome.tabs.discard`.

Author: OmAr-Kader · License: GPL-3.0 (add the `LICENSE` file)

## Install
`brave://extensions` → enable Developer mode → Load unpacked → select this folder. Click the toolbar icon to open settings. Add `icons/` (16/32/48/128) and an `"icons"` / `"action.default_icon"` entry in `manifest.json` when ready.

## Rules
- Ranked by `tab.lastAccessed`; the top N stay loaded. Already-discarded tabs don't count.
- Never discarded and not counted toward N: the active tab of each window, audible tabs, filtered sites, tabs marked non-discardable in `brave://discards`, pinned tabs (toggle).
- A tab over the limit is discarded only after it has stayed over it for the configured delay (default 10 s, 0 = immediately). Becoming active, audible, filtered or back within the top N cancels the countdown; a tab that stops being audible gets a fresh countdown.
- Filters: `github.com` = site + all subdomains, every page. `github.com/user/repo` = that exact page only (`?query` and `#hash` are ignored). Scheme and `www.` are ignored.

## Design notes
- `background.js` is a stateless "snapshot → plan → act" pass triggered by tab/window/storage events (throttled 250 ms, serialized).
- Countdown start times live in `chrome.storage.session`, so they survive service-worker suspension. A `setTimeout` (≤25 s) gives precision while the worker is alive; a `chrome.alarms` alarm wakes it otherwise. The tab state is re-checked right before `discard`.
- Tabs the browser refuses to discard are remembered per URL and not retried in a loop.
- Settings: `chrome.storage.local`. Import/export as JSON.

## Test
`npm test` (Node 18+, no dependencies).
