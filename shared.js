// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) OmAr-Kader
//
// Settings schema, sanitizing, URL normalization and filter matching.
// Shared by the service worker and the options page. No DOM / no top-level chrome.* access.

export const STORAGE_KEY = 'settings';

export const LIMITS = Object.freeze({
  limit: Object.freeze({ min: 1, max: 999 }),
  delaySeconds: Object.freeze({ min: 0, max: 3600 }),
});

export const DEFAULTS = Object.freeze({
  limit: 4,
  delaySeconds: 10,
  protectPinned: true,
  showBadge: true,
  startupActiveOnly: true,
  sites: [],
});

export function clampInt(value, min, max, fallback) {
  if (value === '' || value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
// "mailto:x", "javascript:x" – a scheme without "//". "localhost:3000" is not matched (digit after colon).
const BARE_SCHEME_RE = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$|^\[/;

/**
 * Canonical form used for both filter entries and tab URLs:
 * scheme, "www.", #hash, ?query and trailing slashes are ignored; host is lowercased.
 * @returns {{host:string, page:string, hasPath:boolean}|{error:string}}
 */
function canonicalize(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { error: 'URL is required.' };

  const hasScheme = SCHEME_RE.test(raw);
  if ((hasScheme && !/^https?:\/\//i.test(raw)) || (!hasScheme && BARE_SCHEME_RE.test(raw))) {
    return { error: 'Only http and https sites are supported.' };
  }

  let url;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return { error: 'Not a valid URL.' };
  }

  const host = url.host.replace(/^www\./, '');
  if (!host) return { error: 'Not a valid URL.' };

  const path = url.pathname.replace(/\/+$/, '');
  return { host, page: host + path, hasPath: path !== '' };
}

/**
 * Parses a user-entered filter URL.
 * kind 'domain': no path → matches the host and all its subdomains, every page.
 * kind 'page'  : has a path → matches only that page; ?query and #hash are ignored.
 */
export function parseSiteUrl(input) {
  const c = canonicalize(input);
  if (c.error) return { ok: false, error: c.error };
  return { ok: true, value: c.page, host: c.host, kind: c.hasPath ? 'page' : 'domain' };
}

function parseTabUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const c = canonicalize(url);
  return c.error ? null : c;
}

/** @returns {(tabUrl: string) => boolean} */
export function compileMatcher(sites) {
  const domains = new Set();
  const pages = new Set();
  for (const site of sites ?? []) {
    const p = parseSiteUrl(site?.url);
    if (p.ok) (p.kind === 'domain' ? domains : pages).add(p.value);
  }
  if (domains.size === 0 && pages.size === 0) return () => false;

  return (tabUrl) => {
    const t = parseTabUrl(tabUrl);
    if (!t) return false;
    if (pages.has(t.page)) return true;

    let host = t.host;
    if (IP_RE.test(host)) return domains.has(host);
    for (;;) {
      if (domains.has(host)) return true;
      const dot = host.indexOf('.');
      if (dot === -1) return false;
      host = host.slice(dot + 1);
    }
  };
}

const cleanName = (n) => String(n ?? '').trim().slice(0, 80);

/** Returns a fully valid settings object; invalid/duplicate sites are dropped. */
export function sanitizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const sites = [];
  for (const s of Array.isArray(r.sites) ? r.sites : []) {
    if (!s || typeof s !== 'object') continue;
    const p = parseSiteUrl(s.url);
    if (!p.ok || seen.has(p.value)) continue;
    seen.add(p.value);
    sites.push({
      id: typeof s.id === 'string' && s.id ? s.id : crypto.randomUUID(),
      name: cleanName(s.name) || p.host,
      url: p.value,
    });
  }
  return {
    limit: clampInt(r.limit, LIMITS.limit.min, LIMITS.limit.max, DEFAULTS.limit),
    delaySeconds: clampInt(r.delaySeconds, LIMITS.delaySeconds.min, LIMITS.delaySeconds.max, DEFAULTS.delaySeconds),
    protectPinned: typeof r.protectPinned === 'boolean' ? r.protectPinned : DEFAULTS.protectPinned,
    showBadge: typeof r.showBadge === 'boolean' ? r.showBadge : DEFAULTS.showBadge,
    startupActiveOnly: typeof r.startupActiveOnly === 'boolean' ? r.startupActiveOnly : DEFAULTS.startupActiveOnly,
    sites,
  };
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return sanitizeSettings(stored[STORAGE_KEY]);
}

export async function saveSettings(settings) {
  const clean = sanitizeSettings(settings);
  await chrome.storage.local.set({ [STORAGE_KEY]: clean });
  return clean;
}
