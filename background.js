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
//
// Cache clearing is owned by a separate one-shot chrome.alarms alarm scheduled at the start of
// the next calendar period; see "scheduled cache clearing" below.

import {
  loadSettings,
  STORAGE_KEY,
  CACHE_CLEAR_KEY,
  CACHE_CLEARING_KEY,
  TEST_CACHE_CLEAR_KEY,
  loadLastCacheClear,
  planCacheClear,
  isCacheClearing,
  runCacheClear,
  ACTION_TITLE,
  ACTION_TITLE_CLEANING,
  POPUP_PHASE_KEY,
  POPUP_OPENED_KEY,
  POPUP_ALARM_NAME,
} from './shared.js';
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
    console.error('[Sturdy: Browser Cleaner] reconcile failed', err);
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
  // Never discard a tab that is still loading: discarding mid-load can leave the tab in a
  // half-loaded state that does not auto-reload when activated (seen with slow SPAs such as
  // Discord). onUpdated('status') triggers a reconcile once loading finishes, so the tab is
  // simply discarded on a later pass.
  if (tab.active || tab.audible || tab.discarded || tab.status === 'loading') return 'skipped';
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

/* ---------- scheduled cache clearing ---------- */

// One named one-shot alarm owns the next clear. Calendar periods are irregular (months and DST
// days do not have a fixed length), so the alarm is created with `when` and re-created from the
// new timestamp after each clear instead of using periodInMinutes.
//
// Duplicate-trigger safety:
//  - chrome.alarms.create() with the same name replaces the previous alarm, so at most one clear
//    job can be pending.
//  - Every path that may clear (alarm, install, startup, settings change, self-heal on worker
//    start) funnels through the serialized syncCacheAlarm() chain, so two checks cannot both read
//    a stale "last cleared" and clear twice.
//  - The handler re-reads the persisted last-clear time instead of trusting that an alarm firing
//    means "clear now": late, missed, duplicate or self-healed alarms that fire in an already
//    covered period only reschedule the next period.
//
// Failure handling: a failed sync is only logged. It is retried by the next reconciliation
// trigger - browser start, service-worker start, settings change or the next alarm - exactly like
// the old browser-start check. Never create a retry alarm from the failure path: a persistent
// failure would keep recreating alarms forever.
const CACHE_ALARM_NAME = 'cache-clear-due';

let cacheSyncChain = Promise.resolve();

/** Serializes alarm reconciliation; returns the queued sync. */
function syncCacheAlarm() {
  cacheSyncChain = cacheSyncChain.then(syncCacheAlarmNow).catch((err) => {
    console.error('[Sturdy: Browser Cleaner] cache schedule failed', err);
  });
  return cacheSyncChain;
}

// TEST ONLY: reads the due time armed by the settings page cache-clear test card. It lives in
// storage.local, so a browser restart keeps the test scheduled just like the real cache schedule.
async function loadTestCacheClearWhen() {
  const stored = await chrome.storage.local.get(TEST_CACHE_CLEAR_KEY);
  return Number(stored[TEST_CACHE_CLEAR_KEY]) || 0;
}

async function syncCacheAlarmNow() {
  // Two passes at most: the first may clear a due cache, the second schedules the next period
  // from the timestamp that clear recorded.
  for (let pass = 0; pass < 2; pass++) {
    const [settings, lastClearAt, testWhen] = await Promise.all([
      loadSettings(),
      loadLastCacheClear(),
      loadTestCacheClearWhen(),
    ]);
    // TEST ONLY: testWhen is the injected next period time. Everything else is production.
    const plan = planCacheClear({
      autoClearCache: settings.autoClearCache,
      lastClearAt,
      period: settings.clearCachePeriod,
      dueAt: testWhen || null,
    });

    if (plan.action === 'disabled' || plan.action === 'none') {
      if (testWhen) await chrome.storage.local.remove(TEST_CACHE_CLEAR_KEY);
      await chrome.alarms.clear(CACHE_ALARM_NAME);
      return;
    }

    if (plan.action === 'clear') {
      // The settings page may be clearing right now (manual button). Do not clear twice: its
      // storage write triggers another sync; if it fails, the next reconciliation trigger retries.
      if (await isCacheClearing()) {
        // TEST ONLY: that manual clear satisfies the injected period too.
        if (testWhen) await chrome.storage.local.remove(TEST_CACHE_CLEAR_KEY);
        return;
      }
      await runCacheClear();
      // TEST ONLY: consume the injected time only after a successful clear; a failure leaves it
      // for the next reconciliation trigger, exactly like a failed production clear.
      if (testWhen) await chrome.storage.local.remove(TEST_CACHE_CLEAR_KEY);
      console.info('[Sturdy: Browser Cleaner] cache cleared');
      continue;
    }

    await ensureCacheAlarm(plan.at);
    return;
  }
  throw new Error('cache clear did not advance the period');
}

async function ensureCacheAlarm(at) {
  const existing = await chrome.alarms.get(CACHE_ALARM_NAME);
  // create() would replace the pending alarm with an identical one; leave it untouched so
  // unrelated events cannot keep postponing the same job.
  if (existing && Math.abs(existing.scheduledTime - at) < 1000) return;
  await chrome.alarms.create(CACHE_ALARM_NAME, { when: at });
}

/* ---------- action popup (cleaning progress) ---------- */

// While a cache clear runs, a real action popup (the panel anchored under the toolbar icon) is
// attached to the icon with chrome.action.setPopup(), and Chrome/Brave 127+ even opens it on its
// own with chrome.action.openPopup() — no user gesture needed. No window.open(), which popup
// blockers and some browsers suppress. The popup shows the cleaning progress, then the result
// with an OK button; when the phase ends it is detached, so a normal icon click keeps opening
// the settings page (while a popup is set, action.onClicked does not fire).
//
// Fully event-driven — an MV3 service worker is suspended between events, so setInterval or
// setTimeout loops would die with it. All state lives in chrome.storage.session and one
// idempotent syncPopup() is re-run by every relevant Chrome event:
//  - storage.onChanged of the clearing marker: a clear started or ended, in any context
//  - windows.onCreated / onFocusChanged: openPopup needs a window to anchor to, so a missed
//    schedule that clears at browser start (device was asleep) fails until the first window
//    appears — these events retry it the moment one does
//  - the phase-end alarm: detaches the popup after the result phase (worker timers cannot)
//  - service-worker start: self-heal after suspension, update or crash
const POPUP_CLEANING_PHASE_MS = 60_000; // re-armed while a clear runs; the remainder is the result phase

async function tryOpenPopup() {
  try {
    await chrome.action.openPopup();
    await chrome.storage.session.set({ [POPUP_OPENED_KEY]: true });
  } catch {
    // No window to anchor to yet (browser start), or the API is missing before Chrome 127.
    // Retried by the next window/focus/storage event while the phase is active.
  }
}

/** Idempotent: attaches the popup and tries to open it while a phase is active, detaches otherwise. */
async function syncPopup() {
  const [clearing, stored] = await Promise.all([
    isCacheClearing(),
    chrome.storage.session.get([POPUP_PHASE_KEY, POPUP_OPENED_KEY]),
  ]);
  let phaseUntil = stored[POPUP_PHASE_KEY] ?? 0;
  if (clearing) phaseUntil = Math.max(phaseUntil, Date.now() + POPUP_CLEANING_PHASE_MS);

  if (clearing || Date.now() < phaseUntil) {
    await Promise.all([
      chrome.storage.session.set({ [POPUP_PHASE_KEY]: phaseUntil }),
      chrome.action.setPopup({ popup: 'popup.html' }).catch(() => {}),
      chrome.action.setTitle({ title: clearing ? ACTION_TITLE_CLEANING : ACTION_TITLE }).catch(() => {}),
      chrome.alarms.create(POPUP_ALARM_NAME, { when: phaseUntil + 1000 }),
    ]);
    if (!stored[POPUP_OPENED_KEY]) await tryOpenPopup();
  } else {
    await Promise.all([
      chrome.storage.session.remove([POPUP_PHASE_KEY, POPUP_OPENED_KEY]),
      chrome.alarms.clear(POPUP_ALARM_NAME).catch(() => {}),
      chrome.action.setPopup({ popup: '' }).catch(() => {}),
      chrome.action.setTitle({ title: ACTION_TITLE }).catch(() => {}),
    ]);
  }
}

/** Light path for window/focus events: only opens, never re-attaches or extends the phase. */
async function retryOpenPopup() {
  const stored = await chrome.storage.session.get([POPUP_PHASE_KEY, POPUP_OPENED_KEY]);
  if ((stored[POPUP_PHASE_KEY] ?? 0) > Date.now() && !stored[POPUP_OPENED_KEY]) await tryOpenPopup();
}

/* ---------- listeners (must be registered synchronously at top level) ---------- */

chrome.runtime.onInstalled.addListener(() => {
  requestReconcile(0);
  void syncCacheAlarm(); // alarms may be dropped by an extension update; recreate the schedule
});
// Browser launch: for a short window, tabs restored from the previous session (last activated
// before the launch) are discarded as they load, so only the active tab of each window stays
// loaded. The sweep never touches tabs opened or switched to during the window - those follow the
// normal rules. Not done on install/update/reload of the extension.
chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.session.set({ [STARTUP_KEY]: Date.now() + STARTUP_WINDOW_MS });
  requestReconcile(0);
  setTimeout(() => requestReconcile(0), STARTUP_WINDOW_MS + 500); // final sweep, then normal rules
  // Fallback path: runs a missed/lost alarm, the first clear, or a retry after a failed sync.
  void syncCacheAlarm();
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) requestReconcile(0);
  else if (alarm.name === CACHE_ALARM_NAME) void syncCacheAlarm();
  else if (alarm.name === POPUP_ALARM_NAME) void syncPopup(); // result phase over: detach
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes[STORAGE_KEY]) {
      requestReconcile(0);
      void syncCacheAlarm(); // enable/disable or period change reschedules immediately
    } else if (changes[CACHE_CLEAR_KEY]) {
      void syncCacheAlarm(); // a manual clear restarts the period
    } else if (changes[TEST_CACHE_CLEAR_KEY]) {
      void syncCacheAlarm(); // TEST ONLY: arming/cancelling the cache-clear test
    }
  } else if (area === 'session' && changes[CACHE_CLEARING_KEY]) {
    // The clearing marker appears while a cache clear runs and disappears when it ends, whichever
    // context started it (alarm, settings page, test card). syncPopup attaches and opens the
    // popup on start; on end the title is restored at once and the phase-end alarm detaches the
    // popup after the result phase.
    void syncPopup();
  }
});

chrome.tabs.onActivated.addListener(() => requestReconcile());
chrome.tabs.onCreated.addListener(() => requestReconcile());
chrome.tabs.onRemoved.addListener(() => requestReconcile());
chrome.tabs.onAttached.addListener(() => requestReconcile());
chrome.tabs.onDetached.addListener(() => requestReconcile());
chrome.tabs.onReplaced.addListener(() => requestReconcile());
// A clear at browser start (missed schedule after sleep) begins before the first window exists
// and its openPopup attempts fail; open the popup as soon as a window appears or regains focus.
chrome.windows.onCreated.addListener(() => void retryOpenPopup());
chrome.windows.onFocusChanged.addListener(() => void retryOpenPopup());
// Chrome's onUpdated does not support event filters (addListener throws), so filter here.
const RELEVANT_UPDATE_KEYS = ['audible', 'autoDiscardable', 'discarded', 'pinned', 'status', 'url'];
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (RELEVANT_UPDATE_KEYS.some((key) => key in changeInfo)) requestReconcile();
});
chrome.windows.onFocusChanged.addListener(() => requestReconcile());

// Self-heal on every service-worker start: Chrome may drop alarms across restarts/updates, and
// this also catches a period that rolled over while the browser was closed. It is the fallback
// when scheduling or clearing failed too, because the failure path never creates a retry alarm.
// If nothing is due it only verifies that the pending alarm still exists, without moving its time.
void syncCacheAlarm();

// Self-heal the popup phase: a worker that was suspended or updated mid-phase re-attaches and
// retries opening; a phase that outlived its alarm (dropped alarm) is detached here.
void syncPopup();
