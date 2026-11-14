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
 * @param {number|null} [p.startupSince] while restoring the session: tabs last activated before this
 *   point in time get the startup treatment; null outside the startup window.
 * @returns {{loadedCount:number, nextPending:Record<number,number>, due:chrome.tabs.Tab[]}}
 *
 * Rules:
 *  - discarded tabs are ignored (not loaded).
 *  - audible tabs, filtered sites, pinned tabs (if protected) and tabs with autoDiscardable=false
 *    are never discarded and do not use a slot.
 *  - the active tab of every window counts toward the limit and is never discarded: it always
 *    occupies one of the N slots, and the remaining slots go to the most recently used inactive
 *    tabs. (More active tabs than the limit is possible with many windows; they all stay.)
 *  - during startup, tabs last activated before `startupSince` (restored from the previous session
 *    and not touched in this one) are discarded immediately once they load, regardless of rank, and
 *    do not use a slot of the normal limit. lastAccessed is refreshed on every activation, so any
 *    tab the user opens or switches to in this session leaves the startup treatment for good and
 *    follows the standard limit and delay from then on.
 *  - a tab over the limit only becomes "due" after staying over it for delaySeconds (startup tabs
 *    skip the delay). Any tab that stops being a candidate is dropped from `nextPending`, which is
 *    what cancels its countdown.
 */
export function planDiscards({ tabs, settings, pending = {}, skip = {}, now = Date.now(), startupSince = null }) {
  const isFiltered = compileMatcher(settings.sites);
  const delayMs = settings.delaySeconds * 1000;

  const loaded = tabs.filter((t) => t.id != null && !t.discarded);

  const counted = loaded.filter(
    (t) =>
      !t.audible &&
      !(settings.protectPinned && t.pinned) &&
      t.autoDiscardable !== false &&
      !isFiltered(tabUrl(t)),
  );

  // The limit includes the current tab: every active tab occupies one of the N slots and is never
  // discarded; the remaining slots go to the most recently used inactive tabs. (More active tabs
  // than the limit can happen with many windows - they all stay, active tabs are never discarded.)
  const activeSlots = counted.filter((t) => t.active).length;
  const remainingSlots = Math.max(0, settings.limit - activeSlots);

  // Startup targets are on their way out: inactive ones are candidates no matter their rank and do
  // not occupy a slot, so restored tabs can never push a tab of this session out of the top N.
  const isStartupTarget = (t) => startupSince != null && (t.lastAccessed ?? 0) < startupSince;
  const inactiveNormal = counted.filter((t) => !t.active && !isStartupTarget(t));
  inactiveNormal.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));

  const candidates = [
    ...counted.filter((t) => isStartupTarget(t) && !t.active),
    ...inactiveNormal.slice(remainingSlots),
  ].filter((t) => !isSkipped(skip[t.id], tabUrl(t), now));

  const nextPending = {};
  const due = [];
  for (const t of candidates) {
    const since = pending[t.id] ?? now;
    nextPending[t.id] = since;
    if (now - since >= (isStartupTarget(t) ? 0 : delayMs)) due.push(t);
  }

  return { loadedCount: loaded.length, nextPending, due };
}
