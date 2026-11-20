# Sturdy: Browser Cleaner

Brave/Chromium (MV3, Chrome 121+) extension. Keeps the N most recently used tabs loaded (across all windows) and discards the rest with `chrome.tabs.discard`, and can clear the browser cache on a daily, weekly or monthly schedule.

Author: OmAr-Kader · License: GPL-3.0 [LICENSE](LICENSE)

## 🎥 How it works

<img width="1920" alt="How it works" src="https://github.com/user-attachments/assets/5b69fd80-a20a-478c-aa81-008c3c977aa8" />

## Install

`brave://extensions` → enable Developer mode → Load unpacked → select this folder. Click the toolbar icon to open settings. After editing the code, press the reload icon on the extension card to pick up the changes.

## Settings

- **General** — tab limit (1–999, default 4), discard delay (0–3600 s, default 10 s, 0 = immediately), never discard pinned tabs, badge counter, and "on browser start, load only the active tab of each window".
- **Cache clearing** — one toggle plus a Day/Week/Month period, and "Clear cache now" for a manual clear (which also restarts the period). The automatic clear runs in the background on a `chrome.alarms` schedule, even while the browser stays open; when the current period has no clear yet (including the very first time) it clears immediately. Only cached files are removed — cookies, history, passwords and site data are untouched. "Last cleared" and "Next clear" update live while the page is open, and both the row and the button show "Cleaning…" while a clear is running, so no refresh is needed. While a clear runs, the extension's toolbar popup (the panel anchored under the toolbar icon) opens on its own and shows the progress, then "Cache cleaned successfully" with an OK button; dismissing it returns the icon to its normal click-opens-settings behavior. This also covers a schedule missed while the device slept: the clear runs at the next browser start and the popup opens as soon as a window exists.
- **Filtered sites** — the site list, see the rules below.
- **Import / Export** — JSON backup of everything above: limit, delay, the three toggles, automatic clearing on/off and its period, and the site list. Import applies every scalar setting present in the file and merges the file's sites into the current list — existing entries win, invalid or duplicate URLs are dropped, and invalid values fall back to defaults.

## Rules

- The active tab of each window counts toward N and is never discarded; the remaining slots go to the most recently used tabs (ranked by `tab.lastAccessed`). Already-discarded tabs don't count.
- Never discarded and not counted toward N: audible tabs, filtered sites, tabs marked non-discardable in `brave://discards`, pinned tabs (toggle).
- A tab over the limit is discarded only after it has stayed over it for the configured delay (default 10 s, 0 = immediately). Becoming active, audible, filtered or back within the top N cancels the countdown; a tab that stops being audible gets a fresh countdown.
- On browser start (option, default on): for 30 s after launch, tabs restored from the previous session (last activated before the launch) are discarded immediately as they load, so only the active tab of each window stays loaded. Tabs opened or switched to during that window follow the normal limit and delay instead. Filtered, pinned (if protected) and audible tabs are still exempt. Not triggered by installing/reloading the extension.
- Filters: `github.com` = site + all subdomains, every page. `github.com/user/repo` = that exact page only (`?query` and `#hash` are ignored). Scheme and `www.` are ignored.
- Cache clearing (option, default off, weekly): a single one-shot `chrome.alarms` alarm is kept at the start of the next day, week (starting Monday) or month. When it fires the persisted last-clear time is re-checked and the cache is cleared once — `chrome.browsingData.removeCache` (cached files only) — then the next period is scheduled. No "Last cleared" yet → clears immediately. A clear missed while the browser was closed runs at the next browser start (or as soon as the service worker wakes). Calendar buckets, not elapsed time: a clear at 23:50 also covers the next morning, and a manual clear also restarts the period.

## Design notes

- `background.js` is a stateless "snapshot → plan → act" pass triggered by tab/window/storage events (throttled 250 ms, serialized).
- Countdown start times live in `chrome.storage.session`, so they survive service-worker suspension. A `setTimeout` (≤25 s) gives precision while the worker is alive; a `chrome.alarms` alarm wakes it otherwise. The tab state is re-checked right before `discard`.
- Tabs the browser refuses to discard are remembered per URL and not retried in a loop.
- Settings: `chrome.storage.local`, exported/imported as JSON (see Settings above). The last cache-clear time is stored next to them (`lastCacheClearAt`), so manual and automatic clears share one timer. A session-scoped `cacheClearingSince` marker plus `chrome.storage.onChanged` lets an open settings page follow a running clear live.
- Cache scheduling is idempotent: one named alarm (creating it again replaces the old one), all resync paths are serialized, and the alarm handler re-reads `lastCacheClearAt` instead of assuming the alarm means "clear now". Late, duplicate or self-healed alarms in an already-cleared period only reschedule the next one. Alarms are reconciled on install/update, browser start, settings changes, manual clears and every service-worker start (Chrome may drop alarms across restarts). If a sync or clear fails, no retry alarm is created — that could loop forever on a persistent failure. The next reconciliation trigger (browser/worker start, settings change, next alarm) retries, just like the old browser-start check.
- Permissions: `tabs` (read titles, URLs and `lastAccessed`, discard), `storage` (settings and countdowns), `alarms` (discard-delay wakeups and the cache-clear schedule), `browsingData` (cache clearing).
- Cleaning progress popup: while a cache clear runs, the background attaches `popup.html` to the toolbar icon with `chrome.action.setPopup` and opens it with `chrome.action.openPopup` (Chrome/Brave 127+, no user gesture needed; on older versions it appears when the icon is clicked during the clear) — never `window.open`, which popup blockers and some browsers suppress. The mechanism is fully event-driven, since MV3 service workers are suspended between events and timer loops die with them: all popup state lives in `chrome.storage.session` (`popupPhaseUntil`, `popupOpened`), and one idempotent `syncPopup()` re-runs on every relevant Chrome event — `storage.onChanged` of the `cacheClearingSince` marker (clear starts/ends in any context), `windows.onCreated`/`onFocusChanged` (`openPopup` needs a window to anchor to, so a missed schedule that clears at browser start after sleep retries until the first window appears), a `popup-phase-end` `chrome.alarms` alarm (detaches after the result phase), and every service-worker start (self-heal after suspension, update or crash). The popup follows the same marker as the settings page, shows the progress and then the result with an OK button; dismissing it ends the phase itself, so a closed popup is never re-attached, and opened with nothing to show it closes itself instead of displaying an idle screen. A set popup suppresses `action.onClicked`, which is why detaching is what returns the icon to click-opens-settings.

### For monitoring Brave Browser memory usage

```bash
ps -axo rss=,comm= | awk '/Brave Browser/ {sum += $1; count++} END {printf "Brave processes: %d\nTotal RAM: %.2f GB (%.0f MB)\n", count, sum/1024/1024, sum/1024}'
```

## Test

`npm test` (Node 18+, no dependencies).
