// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) OmAr-Kader
//
// Pure decision logic: given a snapshot of all tabs, decide which tabs are over the limit,
// how long each has been over it, and which are due to be discarded. No chrome.* calls here.

import { compileMatcher } from './shared.js';

const tabUrl = (t) => t.url || t.pendingUrl || '';

// A tab the browser refused to discard is left alone for this long (or until it navigates),
// then tried again - refusals can be transient (loading, just-activated, capturing media...).
export const SKIP_TTL_MS = 5 * 60_000;
export const isSkipped = (entry, url, now) => !!entry && entry.url === url && now - entry.at < SKIP_TTL_MS;

/**
 * @param {object} p
 * @param {chrome.tabs.Tab[]} p.tabs        every tab in every window
 * @param {object} p.settings               sanitized settings
 * @param {Record<number, number>} p.pending tabId -> timestamp since which the tab has been over the limit
 * @param {Record<number, {url:string, at:number}>} p.skip  tabs the browser refused to discard
 * @param {number} p.now
 * @param {boolean} [p.startup] true while restoring the session: limit 0, no delay
 * @returns {{loadedCount:number, nextPending:Record<number,number>, due:chrome.tabs.Tab[]}}
 *
 * Rules:
 *  - discarded tabs are ignored (not loaded).
 *  - audible tabs, filtered sites, pinned tabs (if protected) and tabs with autoDiscardable=false
 *    are never discarded and do not use a slot.
 *  - remaining tabs are ranked by lastAccessed; the top N stay. The active tab of every window is
 *    never discarded, even if it ranks below N.
 *  - a tab over the limit only becomes "due" after staying over it for delaySeconds. Any tab that
 *    stops being a candidate is dropped from `nextPending`, which is what cancels its countdown.
 */
export function planDiscards({ tabs, settings, pending = {}, skip = {}, now = Date.now(), startup = false }) {
  const isFiltered = compileMatcher(settings.sites);
  // Startup mode (browser launch / session restore): keep nothing beyond the exempt tabs
  // (active tab per window, audible, filtered, pinned) and discard immediately, no delay.
  const limit = startup ? 0 : settings.limit;
  const delayMs = startup ? 0 : settings.delaySeconds * 1000;

  const loaded = tabs.filter((t) => t.id != null && !t.discarded);

  const counted = loaded.filter(
    (t) =>
      !t.audible &&
      !(settings.protectPinned && t.pinned) &&
      t.autoDiscardable !== false &&
      !isFiltered(tabUrl(t)),
  );
  counted.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));

  const candidates = counted
    .slice(limit)
    .filter((t) => !t.active && !isSkipped(skip[t.id], tabUrl(t), now));

  const nextPending = {};
  const due = [];
  for (const t of candidates) {
    const since = pending[t.id] ?? now;
    nextPending[t.id] = since;
    if (now - since >= delayMs) due.push(t);
  }

  return { loadedCount: loaded.length, nextPending, due };
}
