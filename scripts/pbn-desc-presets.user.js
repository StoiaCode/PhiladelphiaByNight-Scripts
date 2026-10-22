// ==UserScript==
// @name         PbN Description Presets
// @namespace    stoia.red
// @version      1.0.1
// @description  Save /setdesc looks (short/full description, arrive/depart messages) as per-character presets and swap between them in one click.
// @match        https://philadelphiabynight.net/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-desc-presets.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-desc-presets.user.js
// ==/UserScript==

(function () {
  'use strict';

  // PbN Toolkit coexistence: if the toolkit is installed with this feature
  // switched on, it handles it and this script steps aside. The toolkit
  // publishes its active features on <html data-pbn-toolkit> before any
  // other userscript runs; data-pbn-legacy-desc-presets tells its panel what
  // this script did.
  if ((document.documentElement.getAttribute('data-pbn-toolkit') || '').split(' ').includes('desc-presets')) {
    document.documentElement.setAttribute('data-pbn-legacy-desc-presets', 'deferred');
    return;
  }
  document.documentElement.setAttribute('data-pbn-legacy-desc-presets', 'running');

  // Two entry points:
  //  1. Inside the /setdesc dialog ("Define Your Presence"): a Presets row to
  //     save the current fields as a named look and to fill the dialog from
  //     one. The site's own Save button still does the saving.
  //  2. A masks icon next to the command bar's mood icon: pick a look and it
  //     opens /setdesc out of sight, fills it, clicks Save and closes. If the
  //     dialog doesn't close (e.g. the site rejects the input), it's revealed
  //     so the site's error is visible.
  //
  // A look stores any subset of the four fields; applying it only touches
  // the fields it includes. Looks are stored per character in localStorage.

  const STORAGE_KEY = 'pbn-desc-presets';

  const FIELDS = [
    { key: 'short',  label: 'Short description', sel: 'input[aria-label^="Short description"]' },
    { key: 'full',   label: 'Full description',  sel: 'textarea[aria-label^="Full description"]' },
    { key: 'arrive', label: 'Arrive message',    sel: 'input[aria-label^="Arrival message"]' },
    { key: 'depart', label: 'Depart message',    sel: 'input[aria-label^="Departure message"]' },
  ];

  // --------------------------------------------------------------------------
  // Storage: { [characterName]: { presets: [{ name, short?, full?, arrive?, depart? }], last } }
  // --------------------------------------------------------------------------

  function loadAll() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }

  function saveAll(all) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  }

  function charData(all, name) {
    const d = all[name] || (all[name] = { presets: [], last: null });
    if (!Array.isArray(d.presets)) d.presets = [];
    return d;
  }

  // --------------------------------------------------------------------------
  // Active character name. Preferred source is the play page's own Vue state
  // (the same component the Chat Log script reads); the journal sidebar title
  // ("Jane Doe's Journal") is the fallback.
  // --------------------------------------------------------------------------

  function findPlayInstance() {
    const stack = [document.querySelector('#q-app')?._vnode];
    let guard = 0;
    while (stack.length && guard++ < 20000) {
      const v = stack.pop();
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) { stack.push(...v); continue; }
      const c = v.component;
      if (c) {
        const p = c.proxy;
        if (p && !c.isUnmounted && Array.isArray(p.messages) && Array.isArray(p.activityMessages)) return c;
        stack.push(c.subTree);
      }
      if (v.suspense) stack.push(v.suspense.activeBranch);
      if (Array.isArray(v.children)) stack.push(v.children);
    }
    return null;
  }

  function getCharName() {
    try {
      const name = findPlayInstance()?.proxy?.character?.name;
      if (name) return String(name);
    } catch (e) { /* fall through */ }
    const m = document.querySelector('.journal-title')?.textContent.trim().match(/^(.+?)['’]s Journal$/);
    return m ? m[1] : 'default';
  }

  // --------------------------------------------------------------------------
  // Dialog field access. Values are set through the native setter plus an
  // input event so Quasar/Vue's v-model picks them up.
  // --------------------------------------------------------------------------

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function fieldEl(card, f) { return card.querySelector(f.sel); }

  function readCard(card) {
    const out = {};
    FIELDS.forEach(f => { const el = fieldEl(card, f); if (el) out[f.key] = el.value; });
    return out;
  }

  function applyToCard(card, preset) {
    FIELDS.forEach(f => {
      if (typeof preset[f.key] !== 'string') return;
      const el = fieldEl(card, f);
      if (el && el.value !== preset[f.key]) setNativeValue(el, preset[f.key]);
    });
  }

  function presetMatches(card, preset) {
    const cur = readCard(card);
    const keys = FIELDS.map(f => f.key).filter(k => typeof preset[k] === 'string');
    return keys.length > 0 && keys.every(k => cur[k] === preset[k]);
  }

  function presetParts(preset) {
    return FIELDS.filter(f => typeof preset[f.key] === 'string').map(f => f.label).join(', ');
  }

  // --------------------------------------------------------------------------
  // Styles
  // --------------------------------------------------------------------------

  const style = document.createElement('style');
  style.textContent = `
    .pbn-dp-section { padding-top: 0 !important; }
    .pbn-dp-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 8px; }
    .pbn-dp-chips__empty { opacity: .7; font-size: .95rem; font-style: italic; }
    .pbn-dp-chip {
      display: inline-flex; align-items: stretch; overflow: hidden;
      border: 1px solid #ffffff2e; border-radius: 999px; background: #ffffff0d;
    }
    .pbn-dp-chip--active { border-color: #c49a4a; background: #c49a4a26; }
    .pbn-dp-chip button {
      background: none; border: 0; color: #e8ddd0; cursor: pointer;
      font: inherit; font-size: .95rem; line-height: 1.3;
    }
    .pbn-dp-chip__apply { padding: 5px 12px; }
    .pbn-dp-chip--active .pbn-dp-chip__apply { color: #f3e2b8; }
    .pbn-dp-chip__apply:hover { background: #ffffff14; }
    .pbn-dp-chip__del { padding: 5px 10px 5px 8px; opacity: .55; border-left: 1px solid #ffffff1f !important; }
    .pbn-dp-chip__del:hover { opacity: 1; color: #e07062; background: #ffffff0d; }
    .pbn-dp-link {
      background: none; border: 0; padding: 2px 0; cursor: pointer;
      color: #c49a4a; font: inherit; font-size: .95rem; text-decoration: underline dotted;
    }
    .pbn-dp-link:hover { color: #f3e2b8; }
    .pbn-dp-form {
      display: none; margin-top: 8px; padding: 10px 12px;
      border: 1px solid #ffffff1f; border-radius: 6px; background: #0000002e;
    }
    .pbn-dp-form--open { display: block; }
    .pbn-dp-form__name {
      width: 100%; box-sizing: border-box; padding: 6px 9px; margin-bottom: 8px;
      background: #00000040; color: #e8ddd0; border: 1px solid #ffffff2e; border-radius: 4px;
      font: inherit; font-size: 1rem;
    }
    .pbn-dp-form__name:focus { outline: none; border-color: #c49a4a; }
    .pbn-dp-form__parts { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-bottom: 10px; font-size: .95rem; }
    .pbn-dp-form__parts label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
    .pbn-dp-form__row { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
    .pbn-dp-form__msg { flex: 1; color: #e07062; font-size: .95rem; }
    .pbn-dp-btn {
      cursor: pointer; padding: 5px 14px; border-radius: 4px; font: inherit; font-size: .95rem;
      background: #ffffff0d; color: #e8ddd0; border: 1px solid #ffffff2e;
    }
    .pbn-dp-btn:hover { background: #ffffff1a; }
    .pbn-dp-btn--primary { background: #9e2b2b; border-color: #9e2b2b; color: #f3e6cf; }
    .pbn-dp-btn--primary:hover { background: #b33434; }

    /* While a one-click switch runs, the dialog does its work out of sight. */
    body.pbn-dp-auto .q-dialog:has(.desc-card) { visibility: hidden !important; }

    .pbn-dp-menu {
      position: fixed; z-index: 9000; display: flex; flex-direction: column;
      min-width: 220px; max-width: 360px; padding: 4px 0;
      background: #120a0a; border: 1px solid #5a1212; border-radius: 6px;
      box-shadow: 0 8px 28px #000a;
      font-family: Georgia, 'Times New Roman', serif;
    }
    .pbn-dp-menu__head {
      padding: 6px 16px 4px; color: #9a8a7a; font-size: .8rem;
      text-transform: uppercase; letter-spacing: .8px;
    }
    .pbn-dp-menu__item {
      display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
      padding: 9px 16px; border: 0; background: none; cursor: pointer;
      font: inherit; font-size: 1rem; color: #c4b49a;
    }
    .pbn-dp-menu__item:hover:not(:disabled) { color: #e8ddd0; background: #5a121233; }
    .pbn-dp-menu__item:focus-visible { outline: 2px solid #e0b84a; outline-offset: -2px; }
    .pbn-dp-menu__item:disabled { cursor: progress; opacity: .6; }
    .pbn-dp-menu__check { width: 1em; color: #e0b84a; flex: 0 0 auto; }
    .pbn-dp-menu__sep { height: 1px; margin: 4px 0; background: #5a121299; }
    .pbn-dp-menu__note { padding: 8px 16px; color: #9a8a7a; font-size: .95rem; font-style: italic; }
  `;
  document.head.appendChild(style);

  // --------------------------------------------------------------------------
  // Presets row inside the dialog
  // --------------------------------------------------------------------------

  let autoRunning = false;

  function copyScopeAttrs(from, to) {
    if (!from) return;
    for (const a of from.attributes) if (a.name.startsWith('data-v-')) to.setAttribute(a.name, '');
  }

  function enhanceCard(card) {
    if (card.dataset.pbnDp || !card.querySelector(FIELDS[1].sel)) return;
    card.dataset.pbnDp = '1';

    const firstSection = card.querySelector('.q-card__section');
    const section = document.createElement('div');
    section.className = 'q-card__section q-card__section--vert q-pb-sm pbn-dp-section';
    copyScopeAttrs(firstSection, section);

    // Header styled with the dialog's own label classes.
    const siteLabel = card.querySelector('.desc-field-label');
    const head = document.createElement('div');
    head.className = 'desc-field-label';
    copyScopeAttrs(siteLabel, head);
    head.innerHTML = '<i aria-hidden="true" class="q-icon notranslate material-icons q-mr-xs text-grey-5" style="font-size:14px"><span aria-hidden="true">theater_comedy</span></i><span>Presets</span>';
    const hint = document.createElement('span');
    hint.className = 'desc-field-hint';
    copyScopeAttrs(siteLabel?.querySelector('.desc-field-hint'), hint);
    hint.textContent = '— click a look to fill the fields, then Save';
    head.appendChild(hint);
    head.querySelectorAll('*').forEach(el => copyScopeAttrs(siteLabel, el));

    const chips = document.createElement('div');
    chips.className = 'pbn-dp-chips';

    const saveLink = document.createElement('button');
    saveLink.type = 'button';
    saveLink.className = 'pbn-dp-link';
    saveLink.textContent = 'Save current as preset…';

    const form = buildSaveForm(card, () => renderChips());

    saveLink.addEventListener('click', () => form.open());

    function renderChips() {
      const name = getCharName();
      const data = charData(loadAll(), name);
      chips.textContent = '';
      if (!data.presets.length) {
        const empty = document.createElement('span');
        empty.className = 'pbn-dp-chips__empty';
        empty.textContent = `No presets for ${name} yet.`;
        chips.appendChild(empty);
        return;
      }
      data.presets.forEach(p => {
        const chip = document.createElement('span');
        chip.className = 'pbn-dp-chip' + (presetMatches(card, p) ? ' pbn-dp-chip--active' : '');
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'pbn-dp-chip__apply';
        apply.textContent = p.name;
        apply.title = `Fill: ${presetParts(p)}`;
        apply.addEventListener('click', () => {
          applyToCard(card, p);
          const all = loadAll();
          charData(all, name).last = p.name;
          saveAll(all);
          renderChips();
        });
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'pbn-dp-chip__del';
        del.textContent = '×';
        del.title = `Delete preset "${p.name}"`;
        del.setAttribute('aria-label', `Delete preset ${p.name}`);
        del.addEventListener('click', () => {
          if (!confirm(`Delete the preset "${p.name}"? Your current description isn't affected.`)) return;
          const all = loadAll();
          const d = charData(all, name);
          d.presets = d.presets.filter(x => x.name !== p.name);
          if (d.last === p.name) d.last = null;
          saveAll(all);
          renderChips();
        });
        chip.append(apply, del);
        chips.appendChild(chip);
      });
    }

    renderChips();
    // Re-highlight the matching look as the fields are edited.
    card.addEventListener('input', e => { if (!e.target.closest('.pbn-dp-section')) renderChips(); });

    section.append(head, chips, saveLink, form.el);
    firstSection.after(section);
  }

  function buildSaveForm(card, onSaved) {
    const el = document.createElement('div');
    el.className = 'pbn-dp-form';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'pbn-dp-form__name';
    nameInput.placeholder = 'Preset name, e.g. Hooded';
    nameInput.maxLength = 40;

    const parts = document.createElement('div');
    parts.className = 'pbn-dp-form__parts';
    const boxes = FIELDS.map(f => {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.dataset.key = f.key;
      label.append(box, document.createTextNode(f.label));
      parts.appendChild(label);
      return box;
    });

    const row = document.createElement('div');
    row.className = 'pbn-dp-form__row';
    const msg = document.createElement('span');
    msg.className = 'pbn-dp-form__msg';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pbn-dp-btn';
    cancel.textContent = 'Cancel';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'pbn-dp-btn pbn-dp-btn--primary';
    save.textContent = 'Save preset';
    row.append(msg, cancel, save);

    el.append(nameInput, parts, row);

    function close() { el.classList.remove('pbn-dp-form--open'); msg.textContent = ''; }

    function submit() {
      const presetName = nameInput.value.trim();
      const keys = boxes.filter(b => b.checked).map(b => b.dataset.key);
      if (!presetName) { msg.textContent = 'Give the preset a name.'; nameInput.focus(); return; }
      if (!keys.length) { msg.textContent = 'Tick at least one field.'; return; }

      const cur = readCard(card);
      const preset = { name: presetName };
      keys.forEach(k => { if (typeof cur[k] === 'string') preset[k] = cur[k]; });

      const all = loadAll();
      const d = charData(all, getCharName());
      const idx = d.presets.findIndex(p => p.name.toLowerCase() === presetName.toLowerCase());
      if (idx >= 0) {
        if (!confirm(`A preset called "${d.presets[idx].name}" exists. Replace it with the current fields?`)) return;
        d.presets[idx] = preset;
      } else {
        d.presets.push(preset);
      }
      d.last = preset.name;
      saveAll(all);
      close();
      onSaved();
    }

    cancel.addEventListener('click', close);
    save.addEventListener('click', submit);
    // Keep Enter/Escape in the name field from reaching the dialog.
    nameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    // Quasar closes dialogs on Escape keyup, so swallow that too.
    nameInput.addEventListener('keyup', e => { if (e.key === 'Escape') e.stopPropagation(); });

    return {
      el,
      open() {
        el.classList.add('pbn-dp-form--open');
        nameInput.value = '';
        boxes.forEach(b => { b.checked = true; });
        msg.textContent = '';
        nameInput.focus();
      },
    };
  }

  // --------------------------------------------------------------------------
  // One-click switching from the command bar
  // --------------------------------------------------------------------------

  function findCommandInput() {
    return document.querySelector('.command-bar textarea')
      || document.querySelector('.command-bar input[type="text"]');
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function waitFor(fn, timeoutMs, stepMs = 50) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  }

  function openCard() {
    const card = document.querySelector('.q-dialog .desc-card');
    return card && card.querySelector(FIELDS[1].sel) ? card : null;
  }

  // Sends /setdesc, restoring whatever was being typed in the command box.
  async function sendSetdesc() {
    const input = findCommandInput();
    if (!input) return false;
    const draft = input.value;
    setNativeValue(input, '/setdesc');
    await sleep(0);
    pressEnter(input);
    if (draft) {
      await sleep(50);
      setNativeValue(input, draft);
    }
    return true;
  }

  async function applyAndSave(preset) {
    if (autoRunning) return;
    autoRunning = true;
    document.body.classList.add('pbn-dp-auto');
    try {
      let card = openCard();
      if (!card) {
        if (!await sendSetdesc()) return;
        card = await waitFor(openCard, 5000);
        if (!card) return;
        await sleep(150); // let the dialog finish loading its current values
      }
      applyToCard(card, preset);
      await sleep(80);
      card.querySelector('.desc-save-btn')?.click();
      const closed = await waitFor(() => !card.isConnected, 5000);
      if (closed) {
        const all = loadAll();
        charData(all, getCharName()).last = preset.name;
        saveAll(all);
      }
      // If it didn't close, the finally below reveals it with the site's error.
    } finally {
      document.body.classList.remove('pbn-dp-auto');
      autoRunning = false;
    }
  }

  let openMenu = null;

  function closeMenu() {
    if (!openMenu) return;
    openMenu.menu.remove();
    openMenu.trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
    window.removeEventListener('resize', closeMenu);
    openMenu = null;
  }

  function onOutside(e) {
    if (openMenu && !openMenu.menu.contains(e.target) && !openMenu.trigger.contains(e.target)) closeMenu();
  }

  function onMenuKey(e) {
    if (e.key === 'Escape') { const t = openMenu?.trigger; closeMenu(); t?.focus(); }
  }

  function showMenu(trigger) {
    const name = getCharName();
    const data = charData(loadAll(), name);

    const menu = document.createElement('div');
    menu.className = 'pbn-dp-menu';
    menu.setAttribute('role', 'menu');

    const head = document.createElement('div');
    head.className = 'pbn-dp-menu__head';
    head.textContent = `${name} — looks`;
    menu.appendChild(head);

    if (!data.presets.length) {
      const note = document.createElement('div');
      note.className = 'pbn-dp-menu__note';
      note.textContent = 'No presets yet. Open /setdesc and use "Save current as preset…".';
      menu.appendChild(note);
    }
    data.presets.forEach(p => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pbn-dp-menu__item';
      item.setAttribute('role', 'menuitem');
      item.title = `Sets: ${presetParts(p)}`;
      const check = document.createElement('span');
      check.className = 'pbn-dp-menu__check';
      check.textContent = data.last === p.name ? '✓' : '';
      item.append(check, document.createTextNode(p.name));
      item.addEventListener('click', async () => {
        menu.querySelectorAll('button').forEach(b => { b.disabled = true; });
        await applyAndSave(p);
        closeMenu();
      });
      menu.appendChild(item);
    });

    const sep = document.createElement('div');
    sep.className = 'pbn-dp-menu__sep';
    menu.appendChild(sep);
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'pbn-dp-menu__item';
    edit.setAttribute('role', 'menuitem');
    edit.append(Object.assign(document.createElement('span'), { className: 'pbn-dp-menu__check' }),
      document.createTextNode('Open /setdesc…'));
    edit.addEventListener('click', () => { closeMenu(); sendSetdesc(); });
    menu.appendChild(edit);

    document.body.appendChild(menu);

    // The command bar sits at the bottom of the screen: open upward,
    // right-aligned to the icon.
    const r = trigger.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = `${Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8)}px`;
    menu.style.top = `${r.top - 6 - mh >= 8 ? r.top - 6 - mh : r.bottom + 6}px`;

    trigger.setAttribute('aria-expanded', 'true');
    openMenu = { menu, trigger };
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
    window.addEventListener('resize', closeMenu);
    menu.querySelector('.pbn-dp-menu__item')?.focus();
  }

  // Masks icon, built as a copy of the site's own "Set your mood" icon button
  // so it matches the other command-bar icons exactly.
  function ensureQuickButton() {
    if (location.pathname !== '/play' || document.getElementById('pbn-dp-quick')) return;
    const mood = document.querySelector('.command-bar .q-field__append [aria-label="Set your mood"]');
    if (!mood) return;

    const btn = document.createElement('button');
    btn.id = 'pbn-dp-quick';
    btn.type = 'button';
    btn.className = mood.className;
    copyScopeAttrs(mood, btn);
    btn.setAttribute('style', mood.getAttribute('style') || '');
    btn.setAttribute('aria-label', 'Description presets');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.title = 'Description presets';
    btn.innerHTML = '<span class="q-focus-helper"></span><span class="q-btn__content text-center col items-center q-anchor--skip justify-center row"><i aria-hidden="true" class="q-icon notranslate material-icons" role="img"><span aria-hidden="true">theater_comedy</span></i></span>';
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => {
      const wasOpen = openMenu?.trigger === btn;
      closeMenu();
      if (!wasOpen) showMenu(btn);
    });
    mood.before(btn);
  }

  // --------------------------------------------------------------------------
  // Wiring. The dialog is a Quasar portal appended to <body>, so watch for it
  // there; the icon is re-added whenever the command bar re-renders.
  // --------------------------------------------------------------------------

  function scan() {
    const card = openCard();
    if (card && !autoRunning) enhanceCard(card);
    ensureQuickButton();
  }

  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
})();
