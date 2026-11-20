// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) OmAr-Kader
//
// Action popup (toolbar popup). While a cache clear runs, the service worker attaches this page to
// the toolbar icon with chrome.action.setPopup() and tries chrome.action.openPopup() so it appears
// on its own — no window.open(), which some browsers block. It shows the cleaning progress, then
// the result with an OK button. Dismissing it detaches the popup again, so a normal icon click
// keeps opening the settings page (while a popup is set, action.onClicked does not fire).

import {
  isCacheClearing,
  loadLastCacheClear,
  CACHE_CLEAR_KEY,
  CACHE_CLEARING_KEY,
  ACTION_TITLE,
  POPUP_PHASE_KEY,
  POPUP_OPENED_KEY,
  POPUP_ALARM_NAME,
} from './shared.js';

// A clear that finished within the last minute still shows its result: openPopup can lose the race
// against a fast clear, and the icon stays clickable for the result after openPopup failed.
const RESULT_WINDOW_MS = 60_000;

const $ = (id) => document.getElementById(id);
const SECTIONS = ['cleaning', 'done'];

function show(name) {
  for (const id of SECTIONS) $(id).hidden = id !== name;
  $('ok').hidden = name === 'cleaning'; // nothing to confirm while the clear is running
}

// Detach the popup, restore the normal title and end the phase in storage.session, so the
// service worker's event-driven syncPopup() does not re-attach the popup the user just closed.
function detach() {
  void chrome.storage.session.remove([POPUP_PHASE_KEY, POPUP_OPENED_KEY]).catch(() => {});
  void chrome.alarms.clear(POPUP_ALARM_NAME).catch(() => {});
  void chrome.action.setPopup({ popup: '' }).catch(() => {});
  void chrome.action.setTitle({ title: ACTION_TITLE }).catch(() => {});
}

function showDone(at) {
  $('done-at').textContent = at
    ? `Finished at ${new Date(at).toLocaleTimeString(undefined, { timeStyle: 'medium' })}`
    : '';
  show('done');
}

async function render() {
  if (await isCacheClearing()) {
    show('cleaning');
    return;
  }
  const last = await loadLastCacheClear();
  if (last && Date.now() - last < RESULT_WINDOW_MS) {
    showDone(last);
    return;
  }
  // Opened with nothing to show (stale attachment): heal the action state and close at once, so
  // an idle "nothing is happening" screen is never shown.
  detach();
  window.close();
}

// The clear can start, finish or fail while this popup is open; the same storage markers that
// drive the live "Cleaning…" state on the settings page drive every transition here.
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'session' && changes[CACHE_CLEARING_KEY]) || (area === 'local' && changes[CACHE_CLEAR_KEY])) {
    void render();
  }
});

$('ok').addEventListener('click', () => {
  detach();
  window.close();
});

// Listeners are registered before the first await, so a clear that ends while the initial state
// is being read is still observed.
await render();
