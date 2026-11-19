// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) OmAr-Kader
//
// MV3 service worker. Every event only requests a reconcile; reconcile() is a stateless
// "look at all tabs, decide, act" pass, so missed events or worker restarts cannot corrupt state.
//
// Delay handling: the time a tab first went over the limit is persisted in storage.session
// (survives worker restarts). A setTimeout gives precision while the worker is alive and a
// chrome.alarms alarm is the backup that wakes the worker if it was suspended (Chrome enforces
// a ~30 s minimum for alarms). Cancellation is implicit: a tab that becomes active, audible,
// filtered, ranks within N, or is closed is no longer a candidate and its entry is dropped.

import { loadSettings, STORAGE_KEY, CACHE_CLEAR_KEY, shouldClearCache, runCacheClear } from './shared.js';
import { planDiscards, isSkipped } from './planner.js';

const PENDING_KEY = 'pendingSince';
const SKIP_KEY = 'undiscardable';
const STARTUP_KEY = 'startupUntil';
const STARTUP_WINDOW_MS = 30_000; // session restore keeps creating tabs for a while after onStartup
// Tabs activated within this grace before onStartup - the session restore bringing the active tabs
// back - still count as "this session", so a tab the user switches away from right after launch is
// governed by the normal rules instead of being insta-discarded by the startup sweep.
const STARTUP_ACTIVATE_GRACE_MS = 5_000;
const ALARM_NAME = 'discard-due';
const DEBOUNCE_MS = 250;
const TIMER_MAX_MS = 25_000; // beyond this the worker is likely suspended; rely on the alarm

let debounceTimer = null;
let wakeTimer = null;
let running = false;
let rerun = false;

/* ---------- scheduling ---------- */

// Leading-edge throttle: bursts of events collapse into one pass, latency stays bounded.
function requestReconcile(delay = DEBOUNCE_MS) {
  if (debounceTimer !== null) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void run();
  }, delay);
}

async function run() {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    do {
      rerun = false;
      await reconcile();
    } while (rerun);
  } catch (err) {
    console.error('[Loaded Tabs Limit] reconcile failed', err);
  } finally {
    running = false;
  }
}

function scheduleWake(at) {
  clearTimeout(wakeTimer);
  wakeTimer = null;
  if (at == null) {
    void chrome.alarms.clear(ALARM_NAME);
    return;
  }
  const wait = Math.max(0, at - Date.now());
  if (wait <= TIMER_MAX_MS) wakeTimer = setTimeout(() => requestReconcile(0), wait + 50);
  void chrome.alarms.create(ALARM_NAME, { when: Math.max(at, Date.now()) + 1000 });
}

/* ---------- core pass ---------- */

async function tryDiscard(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return 'gone';
  }
  // Last-moment re-check: the user may have come back since the snapshot was taken.
  if (tab.active || tab.audible || tab.discarded) return 'skipped';
  try {
    return (await chrome.tabs.discard(tabId)) ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}

async function reconcile() {
  const [settings, tabs, session] = await Promise.all([
    loadSettings(),
    chrome.tabs.query({}),
    chrome.storage.session.get([PENDING_KEY, SKIP_KEY, STARTUP_KEY]),
  ]);

  const skip = session[SKIP_KEY] ?? {};
  const now = Date.now();
  // Startup mode covers the session-restore burst after browser launch, and applies only to tabs
  // last activated before this launch (restored from the previous session, not touched since -
  // lastAccessed is refreshed on every activation): they are discarded as they load. Tabs the user
  // opens or switches to during the window have a fresh lastAccessed and follow the normal limit
  // and delay, so startup never forces "only one loaded tab" onto live user activity.
  const startupUntil = session[STARTUP_KEY] ?? 0;
  const startupSince =
    settings.startupActiveOnly && now < startupUntil
      ? startupUntil - STARTUP_WINDOW_MS - STARTUP_ACTIVATE_GRACE_MS // = onStartup - grace
      : null;

  const plan = planDiscards({
    tabs,
    settings,
    pending: session[PENDING_KEY] ?? {},
    skip,
    now,
    startupSince,
  });

  const nextPending = plan.nextPending;
  let discarded = 0;
  for (const tab of plan.due) {
    delete nextPending[tab.id];
    const result = await tryDiscard(tab.id);
    if (result === 'ok') discarded++;
    else if (result === 'failed') skip[tab.id] = { url: tab.url || tab.pendingUrl || '', at: Date.now() };
  }

  // Forget refusals once the tab is gone, navigated elsewhere, or the retry window has passed.
  const urls = new Map(tabs.map((t) => [t.id, t.url || t.pendingUrl || '']));
  for (const id of Object.keys(skip)) {
    if (!isSkipped(skip[id], urls.get(Number(id)), now)) delete skip[id];
  }

  await chrome.storage.session.set({ [PENDING_KEY]: nextPending, [SKIP_KEY]: skip });
  await updateBadge(settings, plan.loadedCount - discarded);

  const delayMs = settings.delaySeconds * 1000;
  const sinceTimes = Object.values(nextPending);
  scheduleWake(sinceTimes.length ? Math.min(...sinceTimes) + delayMs : null);
}

async function updateBadge(settings, loadedCount) {
  if (!settings.showBadge) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  await chrome.action.setBadgeText({ text: String(loadedCount) });
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
}

/* ---------- auto cache clear ---------- */

// Checked once per browser launch: when enabled and the last clear (manual or automatic) falls
// outside the current daily/weekly/monthly calendar bucket, the cache is cleared and the
// timestamp recorded, which starts the next period. Never runs on install/update/reload.
async function autoClearCache() {
  try {
    const settings = await loadSettings();
    if (!settings.autoClearCache) return;
    const stored = await chrome.storage.local.get(CACHE_CLEAR_KEY);
    if (!shouldClearCache(stored[CACHE_CLEAR_KEY], settings.clearCachePeriod)) return;
    await runCacheClear();
    console.info('[Loaded Tabs Limit] cache cleared');
  } catch (err) {
    console.error('[Loaded Tabs Limit] auto cache clear failed', err);
  }
}

/* ---------- listeners (must be registered synchronously at top level) ---------- */

chrome.runtime.onInstalled.addListener(() => requestReconcile(0));
// Browser launch: for a short window, tabs restored from the previous session (last activated
// before the launch) are discarded as they load, so only the active tab of each window stays
// loaded. The sweep never touches tabs opened or switched to during the window - those follow the
// normal rules. Not done on install/update/reload of the extension.
chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.session.set({ [STARTUP_KEY]: Date.now() + STARTUP_WINDOW_MS });
  requestReconcile(0);
  setTimeout(() => requestReconcile(0), STARTUP_WINDOW_MS + 500); // final sweep, then normal rules
  void autoClearCache();
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) requestReconcile(0);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) requestReconcile(0);
});

chrome.tabs.onActivated.addListener(() => requestReconcile());
chrome.tabs.onCreated.addListener(() => requestReconcile());
chrome.tabs.onRemoved.addListener(() => requestReconcile());
chrome.tabs.onAttached.addListener(() => requestReconcile());
chrome.tabs.onDetached.addListener(() => requestReconcile());
chrome.tabs.onReplaced.addListener(() => requestReconcile());
// Chrome's onUpdated does not support event filters (addListener throws), so filter here.
const RELEVANT_UPDATE_KEYS = ['audible', 'autoDiscardable', 'discarded', 'pinned', 'status', 'url'];
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (RELEVANT_UPDATE_KEYS.some((key) => key in changeInfo)) requestReconcile();
});
chrome.windows.onFocusChanged.addListener(() => requestReconcile());
