// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) OmAr-Kader

import { loadSettings, saveSettings, sanitizeSettings, parseSiteUrl, clampInt, LIMITS } from './shared.js';

const $ = (id) => document.getElementById(id);

let settings = null;
let editingId = null;
let focusEditField = false;
let saveChain = Promise.resolve();
let statusTimer = null;

/* ---------- helpers ---------- */

// Builds DOM nodes without innerHTML, so user-entered names/URLs can never inject markup.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function flash(message, { error = false, undo = null } = {}) {
  const status = $('status');
  clearTimeout(statusTimer);
  status.classList.toggle('error', error);
  status.replaceChildren(document.createTextNode(message));
  if (undo) {
    status.append(
      ' ',
      el('button', {
        type: 'button',
        class: 'link',
        onclick: () => {
          status.replaceChildren();
          undo();
        },
      }, 'Undo'),
    );
  }
  statusTimer = setTimeout(() => status.replaceChildren(), undo ? 8000 : 2500);
}

// Writes are serialized and each one saves a snapshot, so the last edit always wins.
function persist(message = 'Saved', options) {
  const snapshot = structuredClone(settings);
  saveChain = saveChain
    .then(() => saveSettings(snapshot))
    .then(() => flash(message, options))
    .catch((err) => flash(`Could not save: ${err.message}`, { error: true }));
  return saveChain;
}

function showError(node, message) {
  node.textContent = message ?? '';
  node.hidden = !message;
}

/* ---------- general settings ---------- */

function fillGeneral() {
  $('limit').value = settings.limit;
  $('delay').value = settings.delaySeconds;
  $('protectPinned').checked = settings.protectPinned;
  $('showBadge').checked = settings.showBadge;
}

function bindGeneral() {
  const numberInputs = { limit: $('limit'), delaySeconds: $('delay') };

  for (const [key, input] of Object.entries(numberInputs)) {
    input.min = LIMITS[key].min;
    input.max = LIMITS[key].max;
    input.addEventListener('change', () => {
      const value = clampInt(input.value, LIMITS[key].min, LIMITS[key].max, settings[key]);
      input.value = value;
      if (value !== settings[key]) {
        settings[key] = value;
        persist();
      }
    });
  }

  for (const key of ['protectPinned', 'showBadge']) {
    const box = $(key);
    box.addEventListener('change', () => {
      settings[key] = box.checked;
      persist();
    });
  }
}

/* ---------- sites ---------- */

function validateSite(name, url, ignoreId = null) {
  const parsed = parseSiteUrl(url);
  if (!parsed.ok) return { ok: false, field: 'url', error: parsed.error };
  const duplicate = settings.sites.find((s) => s.id !== ignoreId && s.url === parsed.value);
  if (duplicate) return { ok: false, field: 'url', error: `Already in the list as “${duplicate.name}”.` };
  return { ok: true, name: name.trim().slice(0, 80) || parsed.host, url: parsed.value };
}

function viewRow(site) {
  const parsed = parseSiteUrl(site.url);
  const exact = parsed.ok && parsed.kind === 'page';
  return el('li', { class: 'site' },
    el('div', { class: 'site-info' },
      el('div', { class: 'site-name', title: site.name }, site.name),
      el('div', { class: 'site-url', title: site.url }, site.url)),
    el('span', {
      class: `badge ${exact ? 'page' : 'domain'}`,
      title: exact ? 'Only this exact page' : 'This site and all its subdomains',
    }, exact ? 'Exact page' : 'Whole site'),
    el('div', { class: 'actions' },
      el('button', { type: 'button', 'aria-label': `Edit ${site.name}`, onclick: () => startEdit(site.id) }, 'Edit'),
      el('button', { type: 'button', class: 'danger', 'aria-label': `Delete ${site.name}`, onclick: () => removeSite(site.id) }, 'Delete')));
}

function editRow(site) {
  const nameInput = el('input', { type: 'text', value: site.name, maxlength: 80, placeholder: 'Name', 'aria-label': 'Name' });
  const urlInput = el('input', { type: 'text', value: site.url, spellcheck: 'false', placeholder: 'URL', 'aria-label': 'URL' });
  const error = el('p', { class: 'error', role: 'alert', hidden: true });

  const form = el('form', { class: 'edit-form', novalidate: true },
    nameInput,
    urlInput,
    el('button', { type: 'submit', class: 'primary' }, 'Save'),
    el('button', { type: 'button', onclick: cancelEdit }, 'Cancel'),
    error);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const result = validateSite(nameInput.value, urlInput.value, site.id);
    if (!result.ok) {
      showError(error, result.error);
      urlInput.focus();
      return;
    }
    site.name = result.name;
    site.url = result.url;
    editingId = null;
    renderSites();
    persist(`Updated “${site.name}”.`);
  });
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') cancelEdit();
  });

  if (focusEditField) {
    focusEditField = false;
    queueMicrotask(() => {
      urlInput.focus();
      urlInput.select();
    });
  }
  return el('li', { class: 'site' }, form);
}

function renderSites() {
  const query = $('search').value.trim().toLowerCase();
  const items = settings.sites.filter(
    (s) => !query || s.name.toLowerCase().includes(query) || s.url.toLowerCase().includes(query),
  );

  $('sites').replaceChildren(...items.map((s) => (s.id === editingId ? editRow(s) : viewRow(s))));

  const empty = $('empty');
  empty.hidden = items.length > 0;
  empty.textContent = settings.sites.length ? 'No sites match your search.' : 'No filtered sites yet.';
}

function startEdit(id) {
  editingId = id;
  focusEditField = true;
  renderSites();
}

function cancelEdit() {
  editingId = null;
  renderSites();
}

function removeSite(id) {
  const index = settings.sites.findIndex((s) => s.id === id);
  if (index < 0) return;
  const [removed] = settings.sites.splice(index, 1);
  if (editingId === id) editingId = null;
  renderSites();
  persist(`Removed “${removed.name}”.`, {
    undo: () => {
      settings.sites.splice(Math.min(index, settings.sites.length), 0, removed);
      renderSites();
      persist('Restored.');
    },
  });
}

function bindAddForm() {
  const nameInput = $('add-name');
  const urlInput = $('add-url');
  const error = $('add-error');

  $('add-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const result = validateSite(nameInput.value, urlInput.value);
    if (!result.ok) {
      showError(error, result.error);
      urlInput.focus();
      return;
    }
    showError(error, '');
    settings.sites.unshift({ id: crypto.randomUUID(), name: result.name, url: result.url });
    nameInput.value = '';
    urlInput.value = '';
    $('search').value = '';
    renderSites();
    persist(`Added “${result.name}”.`);
    nameInput.focus();
  });
  urlInput.addEventListener('input', () => showError(error, ''));
  $('search').addEventListener('input', renderSites);
}

/* ---------- import / export ---------- */

function bindImportExport() {
  $('export').addEventListener('click', () => {
    const data = {
      limit: settings.limit,
      delaySeconds: settings.delaySeconds,
      protectPinned: settings.protectPinned,
      showBadge: settings.showBadge,
      sites: settings.sites.map(({ name, url }) => ({ name, url })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = el('a', { href: URL.createObjectURL(blob), download: 'loaded-tabs-limit.json' });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });

  const fileInput = $('import-file');
  $('import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const incoming = JSON.parse(await file.text());
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('Unexpected file format.');

      const before = settings.sites.length;
      // Scalar settings present in the file replace current ones; sites are merged (existing entries win).
      // Incoming ids are dropped so they can never collide with existing ones.
      const scalars = {};
      for (const key of ['limit', 'delaySeconds', 'protectPinned', 'showBadge']) {
        if (key in incoming) scalars[key] = incoming[key];
      }
      const incomingSites = (Array.isArray(incoming.sites) ? incoming.sites : [])
        .filter((s) => s && typeof s === 'object')
        .map(({ name, url }) => ({ name, url }));

      settings = sanitizeSettings({ ...settings, ...scalars, sites: [...settings.sites, ...incomingSites] });
      const added = settings.sites.length - before;

      fillGeneral();
      editingId = null;
      renderSites();
      persist(`Imported ${added} new site${added === 1 ? '' : 's'}.`);
    } catch (err) {
      flash(`Import failed: ${err.message}`, { error: true });
    }
  });
}

/* ---------- init ---------- */

settings = await loadSettings();
fillGeneral();
bindGeneral();
bindAddForm();
bindImportExport();
renderSites();
