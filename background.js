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

import { loadSettings, STORAGE_KEY } from './shared.js';
import { planDiscards, isSkipped } from './planner.js';

const PENDING_KEY = 'pendingSince';
const SKIP_KEY = 'undiscardable';
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
    chrome.storage.session.get([PENDING_KEY, SKIP_KEY]),
  ]);

  const skip = session[SKIP_KEY] ?? {};
  const plan = planDiscards({
    tabs,
    settings,
    pending: session[PENDING_KEY] ?? {},
    skip,
    now: Date.now(),
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
  const now = Date.now();
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

/* ---------- listeners (must be registered synchronously at top level) ---------- */

chrome.runtime.onInstalled.addListener(() => requestReconcile(0));
chrome.runtime.onStartup.addListener(() => requestReconcile(0));

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
