// ==UserScript==
// @name         PbN Toolkit
// @namespace    stoia.red
// @version      1.4.1
// @description  All the PbN userscripts in one, each switchable, with a settings panel (in-game Settings tab → Open PbN Toolkit).
// @match        https://philadelphiabynight.net/*
// @match        https://map.stoia.red/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-toolkit.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-toolkit.user.js
// ==/UserScript==

(function () {
  'use strict';

  // On MUSH Mapper the toolkit only leaves a marker saying a userscript
  // manager is installed, so the mapper can offer its add-ons to script
  // users (same as the standalone Compass Tools script does).
  if (location.hostname === 'map.stoia.red') {
    document.documentElement.dataset.pbnScripts = '1';
    return;
  }

  const TK_VERSION = '1.4.1';
  const SETTINGS_KEY = 'pbn-toolkit';
  const LOG = (...a) => console.warn('[PbN Toolkit]', ...a);

  // ==========================================================================
  // CORE
  // ==========================================================================

  // ---- Settings: { enabled: { [moduleId]: bool }, opts: { [moduleId]: {...} } }

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
      return { enabled: s.enabled || {}, opts: s.opts || {} };
    } catch (e) { return { enabled: {}, opts: {} }; }
  }

  function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

  const settings = loadSettings();

  function isEnabled(id) { return settings.enabled[id] !== false; }

  function opt(id, key, fallback) {
    const v = settings.opts[id]?.[key];
    return v === undefined ? fallback : v;
  }

  // ---- DOM helpers

  function addStyle(css, { disabled = false } = {}) {
    const s = document.createElement('style');
    s.textContent = css;
    s.disabled = disabled;
    (document.head || document.documentElement).appendChild(s);
    return s;
  }

  function el(tag, props, ...kids) {
    const n = Object.assign(document.createElement(tag), props || {});
    n.append(...kids.filter(k => k != null));
    return n;
  }

  // Vue's scoped CSS only matches elements carrying the component's data-v-*
  // attribute; copying it lets injected elements inherit the site's styling.
  function copyScopeAttrs(from, to) {
    if (!from) return;
    for (const a of from.attributes) if (a.name.startsWith('data-v-')) to.setAttribute(a.name, '');
  }

  function onDomReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
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

  // ---- Routes. The site's Vue Router changes the URL via pushState without
  // reloading the page, so modules register (isActive, enter, exit) here.
  // pushState/replaceState are wrapped at document-start so a route change is
  // seen in the same tick; popstate and a 500ms poll are backstops.

  const routeWatchers = [];

  function checkRoutes() {
    for (const w of routeWatchers) {
      let on = false;
      try { on = !!w.isActive(); } catch (e) { /* treat as inactive */ }
      if (on === w.active) continue;
      w.active = on;
      try { (on ? w.enter : w.exit)(); } catch (e) { LOG(e); }
    }
  }

  function onRoute(isActive, enter, exit) {
    routeWatchers.push({ isActive, enter, exit, active: null });
    checkRoutes();
  }

  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      try { checkRoutes(); } catch (e) { LOG(e); }
      return r;
    };
  }
  window.addEventListener('popstate', checkRoutes);
  setInterval(checkRoutes, 500);

  const isPlay = () => location.pathname === '/play';

  // ---- Command box

  function setNativeValue(input, value) {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function pressEnter(input) {
    const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    input.dispatchEvent(new KeyboardEvent('keydown', o));
    input.dispatchEvent(new KeyboardEvent('keypress', o));
    input.dispatchEvent(new KeyboardEvent('keyup', o));
  }

  function isVisible(n) {
    if (!n) return false;
    const r = n.getBoundingClientRect();
    const s = getComputedStyle(n);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }

  // The play page's command box; falls back to the lowest visible text field
  // outside dialogs if the site's markup ever changes.
  function findCommandInput() {
    const direct = document.querySelector('.command-bar textarea, .command-bar input[type="text"]');
    if (direct) return direct;
    const pool = Array.from(document.querySelectorAll('textarea, input[type="text"], input:not([type])'))
      .filter(n => isVisible(n) && !n.closest('.q-dialog') && !n.closest('[id^="pbn-"]'));
    pool.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return pool[0] || null;
  }

  // Sends a command; whatever was half-typed in the box is put back after.
  async function sendCommand(cmd, { restoreDraft = true } = {}) {
    const input = findCommandInput();
    if (!input) return false;
    const draft = input.value;
    setNativeValue(input, cmd);
    input.focus();
    await sleep(0);
    pressEnter(input);
    if (restoreDraft && draft) { await sleep(50); setNativeValue(input, draft); }
    return true;
  }

  // ---- Vue state. Walks the live component tree from #q-app (its _vnode is
  // set by Vue's renderer in production builds) to the play page component,
  // the one owning both chat message arrays. Cached until it unmounts.

  let playInstCache = null;

  function findPlayInstance() {
    if (playInstCache && !playInstCache.isUnmounted) return playInstCache;
    playInstCache = null;
    const stack = [document.querySelector('#q-app')?._vnode];
    let guard = 0;
    while (stack.length && guard++ < 20000) {
      const v = stack.pop();
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) { stack.push(...v); continue; }
      const c = v.component;
      if (c) {
        const p = c.proxy;
        if (p && !c.isUnmounted && Array.isArray(p.messages) && Array.isArray(p.activityMessages)) {
          playInstCache = c;
          return c;
        }
        stack.push(c.subTree);
      }
      if (v.suspense) stack.push(v.suspense.activeBranch);
      if (Array.isArray(v.children)) stack.push(v.children);
    }
    return null;
  }

  // Active character: the play page's own state first, then the journal
  // sidebar title ("Vergil's Journal"). null when neither is available.
  function getCharName() {
    try {
      const name = findPlayInstance()?.proxy?.character?.name;
      if (name) return String(name);
    } catch (e) { /* fall through */ }
    const m = document.querySelector('.journal-title')?.textContent.trim().match(/^(.+?)['’]s Journal$/);
    return m ? m[1] : null;
  }

  // ---- Popovers (dropdown menus). One open at a time.

  let currentPop = null;

  function openPopover(trigger, menu, { above = false, closeOnScroll = false } = {}) {
    if (currentPop) currentPop.close();
    document.body.appendChild(menu);

    function place() {
      const r = trigger.getBoundingClientRect();
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      menu.style.left = `${Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8)}px`;
      const below = r.bottom + 4, upTop = r.top - 4 - mh;
      const top = above
        ? (upTop >= 8 ? upTop : below)
        : (below + mh <= window.innerHeight ? below : Math.max(8, upTop));
      menu.style.top = `${top}px`;
    }

    function onDown(e) { if (!menu.contains(e.target) && !trigger.contains(e.target)) api.close(); }
    function onKey(e) { if (e.key === 'Escape') { api.close(); trigger.focus(); } }
    function onScroll(e) { if (!menu.contains(e.target)) api.close(); }

    const api = {
      menu, trigger, place,
      close() {
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', api.close);
        window.removeEventListener('scroll', onScroll, true);
        menu.remove();
        trigger.setAttribute('aria-expanded', 'false');
        if (currentPop === api) currentPop = null;
      },
    };
    place();
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', api.close);
    if (closeOnScroll) window.addEventListener('scroll', onScroll, true);
    currentPop = api;
    return api;
  }

  // Toggle behaviour for a trigger button: open, or close if it's already
  // the one that's open.
  function togglePopover(trigger, build, options) {
    if (currentPop && currentPop.trigger === trigger) { currentPop.close(); return null; }
    const menu = build();
    return menu ? openPopover(trigger, menu, options) : null;
  }

  const core = {
    addStyle, el, copyScopeAttrs, onRoute, isPlay, sleep, waitFor,
    setNativeValue, pressEnter, findCommandInput, sendCommand,
    findPlayInstance, getCharName, openPopover, togglePopover,
  };

  // ==========================================================================
  // MODULE REGISTRY
  //   { id, name, description,
  //     early?(core)  — runs at document-start (styles that must beat first paint)
  //     start(core)   — runs once the page DOM is ready
  //     settings?: [{ key, label, type: 'toggle'|'number'|'select', default, options?, min?, max?, help? }]
  //     actions?:  [{ label, run() }]   — buttons shown in the panel
  //     note?:     string               — extra line in the panel }
  //
  // Coexistence with the standalone scripts: the toolkit lists the modules it
  // runs on <html data-pbn-toolkit="id id …"> before any other script runs.
  // Updated standalone scripts check that, step aside if their feature is
  // listed, and mark themselves data-pbn-legacy-<id>="deferred" (or
  // "running" if they go ahead). A module whose standalone script is already
  // running is left to it.
  // ==========================================================================

  const MODULES = [];
  const status = {}; // id -> 'on' | 'off' | 'legacy' | 'error'
  const errors = {};

  function defineModule(m) { MODULES.push(m); }

  // ==========================================================================
  // MODULE: Layout Lock
  // ==========================================================================

  defineModule({
    id: 'layout-lock',
    name: 'Layout Lock',
    description: 'Locks the play page to the window height: no page scrollbar, the chat shrinks to fit and scrolls on its own.',
    start(c) {
      // Quasar sets min-height inline from content size; !important in a
      // stylesheet beats inline styles without it.
      const style = c.addStyle(`
        body { overflow: hidden !important; }
        #q-app, .q-layout { height: 100vh !important; min-height: 0 !important; overflow: hidden !important; }
        .q-page-container { height: 100% !important; overflow: hidden !important; box-sizing: border-box !important; }
        main.q-page { height: 100% !important; min-height: 0 !important; overflow: hidden !important; align-items: stretch !important; }
        main.q-page > .col-md-8 {
          display: flex !important; flex-direction: column !important;
          height: 100% !important; min-height: 0 !important; overflow: hidden !important;
        }
        .chat-tab-bar, .room-presence-bar { flex: 0 0 auto !important; }
        .chat-container { flex: 1 1 0 !important; min-height: 0 !important; overflow-y: auto !important; }
        main.q-page > .col-md-8 > .q-mt-md { flex: 0 0 auto !important; }
        /* Right column may shrink; only its tab panels scroll. */
        main.q-page > .col-md-4 { min-height: 0 !important; min-width: 0 !important; }
        .opt-container { overflow-y: auto !important; flex: 1 1 0 !important; min-height: 0 !important; }
      `, { disabled: true });
      c.onRoute(c.isPlay, () => { style.disabled = false; }, () => { style.disabled = true; });
    },
  });

  // ==========================================================================
  // MODULE: Typing Indicator De-Shift
  // ==========================================================================

  defineModule({
    id: 'typing-indicator',
    name: 'Typing Indicator De-Shift',
    description: 'Stops the "X is typing…" line from pushing the command box around.',
    settings: [
      { key: 'mode', label: 'Indicator', type: 'select', default: 'float',
        options: [['float', 'Float it above the command box'], ['hide', 'Hide it completely']] },
      { key: 'gap', label: 'Gap above the box (px)', type: 'number', default: 4, min: 0, max: 40 },
    ],
    start(c) {
      const SEL = '.typing-indicator';
      if (opt('typing-indicator', 'mode', 'float') === 'hide') {
        const s = c.addStyle(`${SEL} { display: none !important; }`, { disabled: true });
        c.onRoute(c.isPlay, () => { s.disabled = false; }, () => { s.disabled = true; });
        return;
      }
      const GAP = Number(opt('typing-indicator', 'gap', 4)) || 0;

      // Inline styles on the element and every descendant, because Vue's
      // scoped CSS targets the inner spans directly.
      function applyStyles(tip) {
        const shared = {
          fontFamily: 'system-ui, ui-sans-serif, sans-serif', fontStyle: 'normal', fontSize: '13px',
          fontWeight: '600', lineHeight: '1.4', letterSpacing: '0.01em',
        };
        Object.assign(tip.style, shared, {
          position: 'fixed',
          // Floats over the chat/command area only; Quasar's header (2000),
          // drawers (3000), dialogs/menus (6000+) and tooltips stay above it.
          zIndex: '10',
          pointerEvents: 'none', whiteSpace: 'nowrap', color: '#ffffff',
          textShadow: '0 1px 3px rgba(0,0,0,0.9)', background: 'rgba(0,0,0,0.55)',
          padding: '2px 8px', borderRadius: '4px', opacity: '1',
        });
        tip.querySelectorAll('*').forEach(n => Object.assign(n.style, shared));
      }

      function reposition() {
        const tip = document.querySelector(SEL);
        const input = c.findCommandInput();
        if (!tip || !input) return;
        applyStyles(tip);
        const r = (input.closest('.q-field__control') || input).getBoundingClientRect();
        tip.style.left = 'auto';
        tip.style.top = 'auto';
        tip.style.right = `${Math.round(window.innerWidth - r.right)}px`;
        tip.style.bottom = `${Math.round(window.innerHeight - r.top + GAP)}px`;
      }

      const observer = new MutationObserver(reposition);
      let interval = null;
      c.onRoute(c.isPlay, () => {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        interval = setInterval(reposition, 250);
        reposition();
      }, () => {
        observer.disconnect();
        window.removeEventListener('scroll', reposition, true);
        window.removeEventListener('resize', reposition);
        clearInterval(interval);
      });
    },
  });

  // ==========================================================================
  // MODULE: Chat Timestamps
  // ==========================================================================

  defineModule({
    id: 'chat-timestamps',
    name: 'Chat Timestamps',
    description: 'Shows an HH:MM time in front of every chat message.',
    start(c) {
      const TS_ATTR = 'data-pbn-ts';
      // A ::before on the message's <p>: inherits the chat font, and isn't
      // part of the text, so it never ends up inside a saved log.
      const style = c.addStyle(`
        .chat-container [role="article"] > p[${TS_ATTR}]::before {
          content: "[" attr(${TS_ATTR}) "] "; opacity: 0.55;
        }
      `, { disabled: true });

      const pad = n => String(n).padStart(2, '0');
      function stamp(row, ts) {
        const p = row.querySelector(':scope > p');
        if (!p || p.hasAttribute(TS_ATTR)) return;
        const d = ts || new Date();
        p.setAttribute(TS_ATTR, `${pad(d.getHours())}:${pad(d.getMinutes())}`);
      }

      let observer = null, container = null, tick = null;
      function sync() {
        const cont = document.querySelector('.chat-container');
        if (!cont || cont === container) return;
        if (observer) observer.disconnect();
        container = cont;
        // Rows already on screen get "now": their real arrival is unknown.
        const now = new Date();
        cont.querySelectorAll('[role="article"]').forEach(r => stamp(r, now));
        observer = new MutationObserver(ms => {
          for (const m of ms) for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.matches('[role="article"]')) stamp(n);
            else n.querySelectorAll('[role="article"]').forEach(r => stamp(r));
          }
        });
        observer.observe(cont, { childList: true, subtree: true });
      }
      c.onRoute(c.isPlay, () => {
        style.disabled = false;
        sync();
        tick = setInterval(sync, 1000); // re-attach if the chat element is replaced
      }, () => {
        style.disabled = true;
        clearInterval(tick);
        if (observer) observer.disconnect();
        observer = null; container = null;
      });
    },
  });

  // ==========================================================================
  // MODULE: Command Buttons
  // ==========================================================================

  const CMD = {
    BAR_ID: 'pbn-cmd-bar',
    EDITOR_ID: 'pbn-cmd-editor',
    SHARED_KEY: 'pbn-commands',          // shared list (copied over from the standalone script)
    BY_CHAR_KEY: 'pbn-commands-by-char', // { [character]: list }
    DEFAULTS: [
      { label: 'OOC', cmd: '/ooc' }, { label: 'LOOC', cmd: '/looc' }, { label: 'Say', cmd: '/say' },
      { label: 'Emote', cmd: '/emote' }, { label: 'Hide', cmd: '/hide', submit: true },
      { label: 'Look', cmd: '/look', expand: true }, { label: 'Auspex', cmd: '/auspex heighten', submit: true },
      { label: 'News', cmd: '/news', expand: true }, { label: 'SetDesc', cmd: '/setdesc', submit: true },
      { label: 'Char', cmd: '/char', submit: true }, { label: 'Roll', cmd: '/roll', submit: true },
      { label: 'Journal', cmd: '/journal', submit: true },
    ],
    openEditor: null,
  };

  defineModule({
    id: 'command-buttons',
    name: 'Command Buttons',
    description: 'Quick-command buttons above the command box. Each character can have its own set.',
    settings: [
      { key: 'swap', label: 'Switching commands replaces the previous one (/say hi → /emote hi)', type: 'toggle', default: true },
    ],
    actions: [{ label: 'Edit buttons…', run: () => CMD.openEditor && CMD.openEditor() }],
    start(c) {
      const SWAP = opt('command-buttons', 'swap', true);

      function validate(arr) {
        if (!Array.isArray(arr) || arr.length === 0) return false;
        return arr.every(x => x && typeof x === 'object' &&
          typeof x.label === 'string' && x.label.trim() !== '' &&
          typeof x.cmd === 'string' && x.cmd.trim() !== '' &&
          (x.submit === undefined || typeof x.submit === 'boolean') &&
          (x.expand === undefined || typeof x.expand === 'boolean'));
      }
      const defaultsCopy = () => CMD.DEFAULTS.map(x => Object.assign({}, x));
      function loadShared() {
        try { const v = JSON.parse(localStorage.getItem(CMD.SHARED_KEY) || 'null'); if (validate(v)) return v; } catch (e) { /* defaults */ }
        return defaultsCopy();
      }
      const saveShared = arr => localStorage.setItem(CMD.SHARED_KEY, JSON.stringify(arr));
      function loadByChar() {
        try { return JSON.parse(localStorage.getItem(CMD.BY_CHAR_KEY) || '{}') || {}; } catch (e) { return {}; }
      }
      const saveByChar = map => localStorage.setItem(CMD.BY_CHAR_KEY, JSON.stringify(map));
      function ownList(name) { const own = name ? loadByChar()[name] : null; return validate(own) ? own : null; }
      const commandsFor = name => ownList(name) || loadShared();

      let commands = loadShared();
      let knownCmds = commands.map(x => x.cmd);

      c.addStyle(`
        #${CMD.BAR_ID} { display: flex; flex-wrap: wrap; gap: 5px; padding: 6px 4px; align-items: center; }
        .pbn-cmd-btn {
          flex: 0 0 auto; cursor: pointer; padding: 4px 10px;
          background: #120a0a; border: 1px solid #9e2b2b80; border-radius: 5px;
          font-family: Georgia, 'Times New Roman', serif; font-size: .95rem; line-height: 1.3;
          color: #c4b49a; transition: background .12s, color .12s;
        }
        .pbn-cmd-btn:hover { color: #e8dcc0; background: #5a121233; }
        .pbn-cmd-btn:focus-visible { outline: 2px solid #e0b84a; outline-offset: -2px; }
        .pbn-cmd-btn:active, .pbn-cmd-btn--open { color: #f3e6cf; background: #9e2b2b; }
        .pbn-cmd-btn--primary { color: #f3e6cf; background: #9e2b2b; border-color: #9e2b2b; }
        .pbn-cmd-btn--primary:hover { color: #fff; background: #b33434; }
        .pbn-cmd-expand { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; }
        .pbn-cmd-field {
          width: 200px; padding: 4px 8px; background: #0d0707; border: 1px solid #9e2b2b80; border-radius: 5px;
          font-family: Georgia, 'Times New Roman', serif; font-size: .95rem; line-height: 1.3; color: #e8dcc0;
        }
        .pbn-cmd-field:focus { outline: none; border-color: #e0b84a; }
        #${CMD.EDITOR_ID} {
          position: fixed; inset: 0; z-index: 2147483600; display: flex; align-items: center; justify-content: center;
          background: rgba(0,0,0,0.65); font: 15px/1.5 Georgia, 'Times New Roman', serif;
        }
        .pbn-cmd-editor__panel {
          width: min(600px, 92vw); max-height: 85vh; overflow: auto; box-sizing: border-box; padding: 20px 22px;
          background: #120a0a; color: #e8ddd0; border: 1px solid #5a1212; border-radius: 6px; box-shadow: 0 8px 40px rgba(0,0,0,0.6);
        }
        .pbn-cmd-editor__heading { font-family: TMUnicorn, serif; font-size: 1.3rem; letter-spacing: .5px; color: #e8ddd0; margin-bottom: 10px; }
        .pbn-cmd-editor__scope { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px; margin-bottom: 6px; font-size: 1rem; }
        .pbn-cmd-editor__scope label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: #c4b49a; }
        .pbn-cmd-editor__scope label:has(input:checked) { color: #f3e6cf; }
        .pbn-cmd-editor__scope input { accent-color: #9e2b2b; width: 16px; height: 16px; margin: 0; }
        .pbn-cmd-editor__note { color: #9a8a7a; font-style: italic; font-size: .95rem; margin-bottom: 12px; }
        .pbn-cmd-editor__help { color: #c4b49a; margin-bottom: 12px; }
        .pbn-cmd-editor__help code { color: #e0b84a; }
        .pbn-cmd-editor__json {
          width: 100%; box-sizing: border-box; height: 300px; resize: vertical; padding: 10px; white-space: pre;
          font: 14px/1.45 'Courier New', monospace; color: #e8dcc0; background: #0d0707; border: 1px solid #5a1212; border-radius: 4px;
        }
        .pbn-cmd-editor__json:focus { outline: none; border-color: #9e2b2b; }
        .pbn-cmd-editor__msg { min-height: 20px; margin: 8px 0; white-space: pre-wrap; }
        .pbn-cmd-editor__row { display: flex; gap: 8px; align-items: center; }
      `);

      function applyCommand(input, cmd, submit, arg) {
        let text;
        if (arg !== undefined) {
          text = arg.trim();
        } else {
          text = input.value;
          if (SWAP) {
            for (const k of knownCmds) {
              if (text === k || text.startsWith(k + ' ')) { text = text.slice(k.length).replace(/^\s+/, ''); break; }
            }
          }
        }
        const next = text ? `${cmd} ${text}` : `${cmd} `;
        c.setNativeValue(input, next);
        input.focus();
        try { input.setSelectionRange(next.length, next.length); } catch (e) { /* ignore */ }
        if (submit) setTimeout(() => c.pressEnter(input), 0);
      }

      function makeButton(label, cmd) {
        const b = c.el('button', { type: 'button', className: 'pbn-cmd-btn', textContent: label, title: cmd });
        b.addEventListener('mousedown', e => e.preventDefault());
        return b;
      }

      // One delegated outside-click handler collapses any open expand field.
      let openExpand = null;
      document.addEventListener('mousedown', e => {
        if (openExpand && !openExpand.wrap.contains(e.target)) openExpand.collapse();
      });

      function makeExpandButton(input, label, cmd) {
        const wrap = c.el('span', { className: 'pbn-cmd-expand' });
        const btn = makeButton(label, cmd);
        const field = c.el('input', { type: 'text', className: 'pbn-cmd-field', placeholder: `${cmd} …` });
        field.style.display = 'none';
        const self = {
          wrap,
          collapse() { btn.classList.remove('pbn-cmd-btn--open'); field.style.display = 'none'; field.value = ''; if (openExpand === self) openExpand = null; },
          expand() { if (openExpand) openExpand.collapse(); btn.classList.add('pbn-cmd-btn--open'); field.style.display = ''; field.focus(); openExpand = self; },
        };
        const send = () => { applyCommand(input, cmd, true, field.value); self.collapse(); };
        btn.addEventListener('click', () => (openExpand === self ? send() : self.expand()));
        field.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); send(); }
          else if (e.key === 'Escape') { e.preventDefault(); self.collapse(); input.focus(); }
        });
        wrap.append(btn, field);
        return wrap;
      }

      // Rebuilt when the character changes or the stored lists do — the
      // standalone script copies its lists over at document-idle, which can
      // land after the bar's first build on the first load after migrating.
      let barSig;
      function mount() {
        const input = c.findCommandInput();
        if (!input) return;
        const name = c.getCharName();
        const sig = `${name}|${localStorage.getItem(CMD.SHARED_KEY) || ''}|${localStorage.getItem(CMD.BY_CHAR_KEY) || ''}`;
        const existing = document.getElementById(CMD.BAR_ID);
        if (existing && existing.isConnected && sig === barSig) return;
        existing?.remove();
        barSig = sig;
        commands = commandsFor(name);
        knownCmds = commands.map(x => x.cmd);
        const bar = c.el('div', { id: CMD.BAR_ID });
        for (const { label, cmd, submit, expand } of commands) {
          if (expand) bar.append(makeExpandButton(input, label, cmd));
          else {
            const b = makeButton(label, cmd);
            b.addEventListener('click', () => applyCommand(input, cmd, submit));
            bar.append(b);
          }
        }
        const anchor = input.closest('.q-field') || input.parentElement || input;
        anchor.parentElement.insertBefore(bar, anchor);
      }
      const rerender = () => { document.getElementById(CMD.BAR_ID)?.remove(); mount(); };

      // Editor: edits the list the current character uses (own or shared).
      CMD.openEditor = function openEditor() {
        if (document.getElementById(CMD.EDITOR_ID)) return;
        const name = c.getCharName();
        const hadOwn = !!ownList(name);
        let scope = hadOwn ? 'own' : 'shared';
        const drafts = {
          shared: JSON.stringify(loadShared(), null, 2),
          own: JSON.stringify(ownList(name) || loadShared(), null, 2),
        };

        const overlay = c.el('div', { id: CMD.EDITOR_ID });
        const panel = c.el('div', { className: 'pbn-cmd-editor__panel' });
        const heading = c.el('div', { className: 'pbn-cmd-editor__heading', textContent: name ? `Edit command buttons — ${name}` : 'Edit command buttons' });
        const note = c.el('div', { className: 'pbn-cmd-editor__note' });
        const ta = c.el('textarea', { className: 'pbn-cmd-editor__json', spellcheck: false, value: drafts[scope] });
        const renderNote = () => {
          if (!name) note.textContent = 'No character detected, so this edits the shared list used by every character. Open it from the play page to give a character its own buttons.';
          else if (scope === 'shared') note.textContent = hadOwn
            ? `Saving deletes ${name}'s own list, and ${name} goes back to the shared list. Edits apply to every character using the shared list.`
            : 'Edits apply to every character using the shared list.';
          else note.textContent = hadOwn ? `Only ${name} sees these buttons.` : `Starts as a copy of the shared list. Only ${name} will see these buttons.`;
        };
        panel.append(heading);
        if (name) {
          const scopeRow = c.el('div', { className: 'pbn-cmd-editor__scope' }, `${name} uses:`);
          [['shared', 'the shared list'], ['own', 'its own list']].forEach(([value, text]) => {
            const radio = c.el('input', { type: 'radio', name: 'pbn-cmd-scope', value, checked: value === scope });
            radio.addEventListener('change', () => { drafts[scope] = ta.value; scope = value; ta.value = drafts[scope]; renderNote(); });
            scopeRow.append(c.el('label', {}, radio, text));
          });
          panel.append(scopeRow);
        }
        renderNote();
        const help = c.el('div', { className: 'pbn-cmd-editor__help' });
        help.innerHTML = 'One entry per button. Each needs <code>"label"</code> (button text) and <code>"cmd"</code> (what gets pasted). ' +
          'Optional: <code>"submit": true</code> sends immediately, or <code>"expand": true</code> opens an input field first.';
        const msg = c.el('div', { className: 'pbn-cmd-editor__msg' });
        const showError = t => { msg.style.color = '#f0906a'; msg.textContent = t; };
        const btn = (t, primary) => c.el('button', { type: 'button', className: primary ? 'pbn-cmd-btn pbn-cmd-btn--primary' : 'pbn-cmd-btn', textContent: t });
        const resetBtn = btn('Reset to defaults'), cancelBtn = btn('Cancel'), saveBtn = btn('Save', true);
        const row = c.el('div', { className: 'pbn-cmd-editor__row' }, resetBtn, c.el('div', { style: 'flex:1 1 auto' }), cancelBtn, saveBtn);
        panel.append(note, help, ta, msg, row);
        overlay.append(panel);

        function close() { document.removeEventListener('keydown', onKey, true); overlay.remove(); }
        function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
        resetBtn.addEventListener('click', () => { ta.value = JSON.stringify(defaultsCopy(), null, 2); msg.style.color = '#6bdb7e'; msg.textContent = 'Defaults loaded — click Save to apply.'; });
        cancelBtn.addEventListener('click', close);
        overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
        saveBtn.addEventListener('click', () => {
          let parsed;
          try { parsed = JSON.parse(ta.value); } catch (e) { showError('Invalid JSON: ' + e.message); return; }
          if (!validate(parsed)) { showError('Each entry needs a non-empty "label" and "cmd". "submit"/"expand" must be true or false if present.'); return; }
          if (name && scope === 'own') { const map = loadByChar(); map[name] = parsed; saveByChar(map); }
          else {
            saveShared(parsed);
            if (name && hadOwn) { const map = loadByChar(); delete map[name]; saveByChar(map); }
          }
          rerender();
          close();
        });
        document.addEventListener('keydown', onKey, true);
        document.body.append(overlay);
        ta.focus();
      };

      let observer = null;
      c.onRoute(c.isPlay, () => {
        if (observer) return;
        observer = new MutationObserver(mount);
        observer.observe(document.body, { childList: true, subtree: true });
        mount();
      }, () => {
        if (observer) { observer.disconnect(); observer = null; }
        document.getElementById(CMD.BAR_ID)?.remove();
      });
    },
  });

  // ==========================================================================
  // MODULE: Chat Log (recording, Save Log, Search, Hide)
  // ==========================================================================

  defineModule({
    id: 'chat-log',
    name: 'Chat Log',
    description: 'Save Log records the RP chat for download, plus Search and Hide in the chat tab bar.',
    settings: [
      { key: 'search', label: 'Search button', type: 'toggle', default: true },
      { key: 'hide', label: 'Hide button', type: 'toggle', default: true },
    ],
    start(c) {
      const WITH_SEARCH = opt('chat-log', 'search', true);
      const WITH_HIDE = opt('chat-log', 'hide', true);
      const CHAT = '.chat-container';
      const ROW = '[role="article"]';
      const BTN_ID = 'pbn-log-btn', SEARCH_ID = 'pbn-log-search', HIDE_ID = 'pbn-log-hide';
      const FALLBACK_AFTER_MS = 5000;

      // ---- Recording: primarily from the play component's RP `messages`
      // array (activityMessages is ignored), with a DOM-observer fallback.
      const sessionStart = new Date();
      const entries = [];
      const loggedMsgs = new WeakSet();
      const seenKeys = new Set();
      const seenEls = new WeakSet();

      const pad = n => String(n).padStart(2, '0');
      const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const fmtTs = d => `${fmtDate(d)} ${fmtTime(d)}`;

      // The site separates name/"says," etc. with CSS margins, not spaces.
      // Personal Names spans go back to the game's text; withNames puts your
      // names in instead.
      function htmlToText(html, withNames = false) {
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        const root = tpl.content;
        namesApi?.prepareLogCopy(root, withNames);
        root.querySelectorAll('[class*="q-ml-"], [class*="q-mx-"], [class*="q-px-"], [class*="q-pl-"]').forEach(n => n.before(' '));
        root.querySelectorAll('[class*="q-mr-"], [class*="q-mx-"], [class*="q-px-"], [class*="q-pr-"]').forEach(n => n.after(' '));
        root.querySelectorAll('br, p, div, li, tr').forEach(n => { n.before(' '); n.after(' '); });
        return root.textContent.replace(/\s+/g, ' ').trim();
      }

      const record = (text, ts, html) => { if (text) entries.push({ ts, text, html }); };

      function msgTimestamp(m) {
        const t = m.timestamp;
        if (t == null) return null;
        const d = new Date(typeof t === 'string' && /^\d+$/.test(t) ? Number(t) : t);
        return isNaN(d) ? null : d;
      }

      function logMessage(m) {
        const raw = m.__v_raw || m;
        if (loggedMsgs.has(raw)) return;
        loggedMsgs.add(raw);
        if (m.isHistory && /^--.*--$/.test((m.text || '').trim())) return; // replay markers
        const html = m.html || m.text || '';
        const text = htmlToText(html);
        const serverTs = msgTimestamp(m);
        if (serverTs) {
          const key = `${serverTs.getTime()}|${text}`; // skip history replays already logged
          if (seenKeys.has(key)) return;
          seenKeys.add(key);
        }
        record(text, serverTs || new Date(), html);
      }

      function drain(list) {
        let i = list.length;
        while (i > 0 && !loggedMsgs.has(list[i - 1].__v_raw || list[i - 1])) i--;
        for (; i < list.length; i++) logMessage(list[i]);
      }

      let hooked = null;
      function hookInstance(inst, { backfill }) {
        const p = inst.proxy;
        if (backfill) drain(p.messages);
        else p.messages.forEach(m => loggedMsgs.add(m.__v_raw || m));
        const stop = p.$watch(() => { const a = p.messages; return a.length ? a[a.length - 1] : null; }, () => drain(p.messages), { flush: 'sync' });
        hooked = { inst, stop };
      }
      function unhook() { if (hooked) { hooked.stop(); hooked = null; } }

      let chatObserver = null, observedContainer = null;
      function captureEl(row, ts) { if (seenEls.has(row)) return; seenEls.add(row); const html = row.innerHTML; record(htmlToText(html), ts || new Date(), html); }
      function startDomFallback() {
        const cont = document.querySelector(CHAT);
        if (!cont || cont === observedContainer) return;
        stopDomFallback();
        observedContainer = cont;
        cont.querySelectorAll(ROW).forEach(r => captureEl(r, sessionStart));
        chatObserver = new MutationObserver(ms => {
          for (const m of ms) for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.matches(ROW)) captureEl(n); else n.querySelectorAll(ROW).forEach(r => captureEl(r));
          }
        });
        chatObserver.observe(cont, { childList: true, subtree: true });
      }
      function stopDomFallback() { if (chatObserver) { chatObserver.disconnect(); chatObserver = null; } observedContainer = null; }

      function saveLog() {
        if (!entries.length) return;
        // Lines are kept as recorded (game text); with Personal Names set to
        // "my names" they're rebuilt from their HTML with the current names.
        const mine = !!namesApi?.writesMine();
        const header = [
          'Philadelphia by Night — Chat Log',
          `Session started : ${fmtTs(sessionStart)}`,
          `Saved           : ${fmtTs(new Date())}`,
          `Messages        : ${entries.length}`,
          mine ? 'Names           : your own (Personal Names)' : null,
          '─'.repeat(64), '',
        ].filter(l => l != null).join('\n');
        const body = entries.map(e => `[${fmtTs(e.ts)}] ${mine && e.html ? htmlToText(e.html, true) : e.text}`).join('\n');
        const url = URL.createObjectURL(new Blob([header + body], { type: 'text/plain' }));
        const a = c.el('a', { href: url, download: `pbn-log-${fmtDate(sessionStart)}-${fmtTime(sessionStart).replace(/:/g, '')}.txt` });
        a.click();
        URL.revokeObjectURL(url);
      }

      c.addStyle(`
        #${BTN_ID} {
          margin-left: auto; flex: 0 0 auto; cursor: pointer; padding: 6px 16px; background: none; border: none;
          border-left: 1px solid #5a1212; font-family: TMUnicorn, serif; font-size: .85rem; letter-spacing: .5px;
          color: #c4b49a; transition: color .15s, background .15s;
        }
        #${BTN_ID}:hover { color: #e8ddd0; background: #5a121233; }
        #${BTN_ID}:focus-visible { outline: 2px solid #e8ddd0; outline-offset: -2px; }
        #${HIDE_ID}, #${SEARCH_ID} {
          margin-left: auto; flex: 0 1 auto; min-width: 0; display: flex; align-items: stretch; border-left: 1px solid #5a1212;
        }
        #${HIDE_ID} + #${SEARCH_ID}, #${SEARCH_ID} + #${BTN_ID}, #${HIDE_ID} + #${BTN_ID} { margin-left: 0; }
        .pbn-lh-btn--active { color: #e0b84a !important; }
        body:not(.pbn-hide-picking) .chat-container [role="article"].pbn-hidden,
        body.pbn-hide-cat-whisper:not(.pbn-hide-picking) .chat-container [role="article"]:is(.pbn-cat-whisper, :has(.whisper-line, .auspex-whisper-line)),
        body.pbn-hide-cat-system:not(.pbn-hide-picking) .chat-container [role="article"]:has(> p > span.text-orange-9:first-child),
        body.pbn-hide-cat-ooc:not(.pbn-hide-picking) .chat-container [role="article"]:has(> p > span.text-blue:first-child) { display: none !important; }
        body.pbn-hide-picking .chat-container [role="article"] { cursor: pointer; }
        body.pbn-hide-picking .chat-container [role="article"]:hover { outline: 1px dashed #e0b84a99; outline-offset: -1px; }
        body.pbn-hide-picking .chat-container [role="article"].pbn-hidden,
        body.pbn-hide-picking.pbn-hide-cat-whisper .chat-container [role="article"]:is(.pbn-cat-whisper, :has(.whisper-line, .auspex-whisper-line)),
        body.pbn-hide-picking.pbn-hide-cat-system .chat-container [role="article"]:has(> p > span.text-orange-9:first-child),
        body.pbn-hide-picking.pbn-hide-cat-ooc .chat-container [role="article"]:has(> p > span.text-blue:first-child) { opacity: .3; text-decoration: line-through; }
        .pbn-ls-btn {
          flex: 0 0 auto; cursor: pointer; padding: 6px 12px; background: none; border: none;
          font-family: TMUnicorn, serif; font-size: .85rem; letter-spacing: .5px; color: #c4b49a; transition: color .15s, background .15s;
        }
        .pbn-ls-btn:hover:not(:disabled) { color: #e8ddd0; background: #5a121233; }
        .pbn-ls-btn:disabled { opacity: .35; cursor: default; }
        .pbn-ls-btn:focus-visible { outline: 2px solid #e8ddd0; outline-offset: -2px; }
        .pbn-ls-toggle { padding: 6px 16px; }
        .pbn-ls-box { display: none; align-items: center; min-width: 0; }
        #${SEARCH_ID}.pbn-ls--open .pbn-ls-box { display: flex; }
        #${SEARCH_ID}.pbn-ls--open .pbn-ls-toggle { display: none; }
        .pbn-ls-input {
          width: 190px; min-width: 80px; margin: 3px 4px 3px 8px; padding: 3px 8px;
          background: #0d0707; color: #e8ddd0; border: 1px solid #5a1212; border-radius: 4px;
          font-family: Georgia, 'Times New Roman', serif; font-size: .95rem;
        }
        .pbn-ls-input:focus { outline: none; border-color: #9a2020; }
        .pbn-ls-count { min-width: 4.5em; padding: 0 4px; text-align: center; white-space: nowrap; font-family: Georgia, 'Times New Roman', serif; font-size: .9rem; color: #9a8a7a; }
        ::highlight(pbn-log-search) { background-color: #e0b84a40; }
        ::highlight(pbn-log-search-current) { background-color: #e0b84a; color: #120a0a; }
        .chat-container .pbn-log-hit { outline: 1px solid #e0b84a99; outline-offset: -1px; background: #e0b84a14; border-radius: 3px; }
      `);

      function ensureButton() {
        if (document.getElementById(BTN_ID)) return;
        const tabBar = document.querySelector('.chat-tab-bar');
        if (!tabBar) return;
        const b = c.el('button', { type: 'button', id: BTN_ID, textContent: 'Save Log', title: "Download this session's chat as a text file" });
        b.addEventListener('mousedown', e => e.preventDefault());
        b.addEventListener('click', saveLog);
        tabBar.append(b);
      }

      // ---- Search (messages currently on the page; whitespace-insensitive;
      // highlights via the CSS Custom Highlight API, no DOM changes).
      const canHighlight = typeof Highlight === 'function' && !!(window.CSS && CSS.highlights);
      let searchState = null;
      const chatRows = () => {
        const cont = document.querySelector(CHAT);
        return cont ? Array.from(cont.querySelectorAll(ROW)).filter(r => r.getClientRects().length) : [];
      };
      function matchRanges(row, needle) {
        const chars = [];
        let hay = '';
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const t = n.nodeValue;
          for (let i = 0; i < t.length; i++) { if (/\s/.test(t[i])) continue; chars.push([n, i]); hay += t[i]; }
        }
        hay = hay.toLowerCase();
        const ranges = [];
        for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
          const [sn, so] = chars[at], [en, eo] = chars[at + needle.length - 1];
          const r = document.createRange();
          r.setStart(sn, so); r.setEnd(en, eo + 1);
          ranges.push(r);
        }
        // Personal Names: a name shown as yours also matches the game's text.
        row.querySelectorAll('.pbn-nm[data-pbn-nm-orig]').forEach(s => {
          const orig = s.dataset.pbnNmOrig.replace(/\s+/g, '').toLowerCase();
          if (!orig.includes(needle) || s.textContent.replace(/\s+/g, '').toLowerCase().includes(needle)) return;
          const r = document.createRange();
          r.selectNodeContents(s);
          ranges.push(r);
        });
        return ranges;
      }
      function clearHits() {
        if (canHighlight) { CSS.highlights.delete('pbn-log-search'); CSS.highlights.delete('pbn-log-search-current'); }
        document.querySelectorAll('.pbn-log-hit').forEach(r => r.classList.remove('pbn-log-hit'));
      }
      function scrollRowIntoView(row) {
        const cont = document.querySelector(CHAT);
        if (!cont) return;
        const offset = () => { const cr = cont.getBoundingClientRect(), rr = row.getBoundingClientRect(); return rr.top - cr.top - (cr.height - rr.height) / 2; };
        cont.scrollBy({ top: offset(), behavior: 'smooth' });
        setTimeout(() => { if (row.isConnected && Math.abs(offset()) > cont.clientHeight / 2) cont.scrollTop += offset(); }, 700);
      }
      const setNav = (box, any, older = false, newer = false) => { box.older.disabled = !any || !older; box.newer.disabled = !any || !newer; };
      function runSearch(box, dir) {
        const needle = box.input.value.replace(/\s+/g, '').toLowerCase();
        clearHits();
        if (!needle) { searchState = null; box.count.textContent = ''; setNav(box, false); return; }
        const hits = [];
        chatRows().forEach(row => { const ranges = matchRanges(row, needle); if (ranges.length) hits.push({ row, ranges }); });
        if (!hits.length) {
          searchState = null;
          box.count.textContent = 'none';
          box.count.title = 'No matches among the messages on screen. The site only keeps the last 500; older lines are in Save Log.';
          setNav(box, false);
          return;
        }
        let idx = hits.length - 1;
        const prevIdx = searchState?.current ? hits.findIndex(h => h.row === searchState.current) : -1;
        if (dir && prevIdx !== -1) idx = Math.min(hits.length - 1, Math.max(0, prevIdx + dir));
        const cur = hits[idx];
        searchState = { current: cur.row };
        if (canHighlight) {
          CSS.highlights.set('pbn-log-search', new Highlight(...hits.flatMap(h => h.ranges)));
          CSS.highlights.set('pbn-log-search-current', new Highlight(...cur.ranges));
        }
        cur.row.classList.add('pbn-log-hit');
        scrollRowIntoView(cur.row);
        box.count.textContent = `${hits.length - idx} / ${hits.length}`;
        box.count.title = 'Enter: older match · Shift+Enter: newer match · Esc: close';
        setNav(box, true, idx > 0, idx < hits.length - 1);
      }
      function ensureSearch() {
        if (!WITH_SEARCH || document.getElementById(SEARCH_ID)) return;
        const logBtn = document.getElementById(BTN_ID);
        if (!logBtn) return;
        const wrap = c.el('div', { id: SEARCH_ID });
        const toggle = c.el('button', { type: 'button', className: 'pbn-ls-btn pbn-ls-toggle', textContent: 'Search', title: 'Search the chat' });
        const input = c.el('input', { type: 'text', className: 'pbn-ls-input', placeholder: 'Search chat…', spellcheck: false });
        input.setAttribute('aria-label', 'Search the chat');
        const count = c.el('span', { className: 'pbn-ls-count' });
        count.setAttribute('aria-live', 'polite');
        const older = c.el('button', { type: 'button', className: 'pbn-ls-btn', textContent: '▲', title: 'Older match (Enter)' });
        const newer = c.el('button', { type: 'button', className: 'pbn-ls-btn', textContent: '▼', title: 'Newer match (Shift+Enter)' });
        const close = c.el('button', { type: 'button', className: 'pbn-ls-btn', textContent: '✕', title: 'Close search (Esc)' });
        older.setAttribute('aria-label', 'Older match'); newer.setAttribute('aria-label', 'Newer match'); close.setAttribute('aria-label', 'Close search');
        wrap.append(toggle, c.el('span', { className: 'pbn-ls-box' }, input, count, older, newer, close));
        const box = { input, count, older, newer };
        setNav(box, false);
        const open = () => { wrap.classList.add('pbn-ls--open'); input.focus(); input.select(); };
        const shut = () => { wrap.classList.remove('pbn-ls--open'); clearHits(); searchState = null; count.textContent = ''; toggle.focus(); };
        let debounce = null;
        toggle.addEventListener('click', open);
        input.addEventListener('input', () => { clearTimeout(debounce); searchState = null; debounce = setTimeout(() => runSearch(box, 0), 150); });
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); clearTimeout(debounce); runSearch(box, searchState ? (e.shiftKey ? 1 : -1) : 0); }
          else if (e.key === 'Escape') { e.preventDefault(); shut(); }
        });
        older.addEventListener('click', () => runSearch(box, -1));
        newer.addEventListener('click', () => runSearch(box, 1));
        close.addEventListener('click', shut);
        [toggle, older, newer, close].forEach(b => b.addEventListener('mousedown', e => e.preventDefault()));
        logBtn.before(wrap);
      }

      // ---- Hide (display only, temporary).
      const HIDE_CATS = [['whisper', 'Whispers'], ['system', 'System messages'], ['ooc', 'OOC & LOOC']];
      const WHISPER_RE = /\bwhispers to\b|A whisper brushes the edge of your awareness|catch the words meant only for another/i;
      const tagged = new WeakSet();
      let tagObserver = null, tagContainer = null;
      function tagWhispers() {
        const cont = document.querySelector(CHAT);
        if (!cont) return;
        cont.querySelectorAll(ROW).forEach(row => {
          if (tagged.has(row)) return;
          tagged.add(row);
          if (WHISPER_RE.test(row.textContent)) row.classList.add('pbn-cat-whisper');
        });
        if (cont !== tagContainer) {
          if (tagObserver) tagObserver.disconnect();
          tagContainer = cont;
          tagObserver = new MutationObserver(tagWhispers);
          tagObserver.observe(cont, { childList: true });
        }
      }
      const picking = () => document.body.classList.contains('pbn-hide-picking');
      const hiddenCount = () => document.querySelectorAll(`${CHAT} .pbn-hidden`).length;
      const catOn = k => document.body.classList.contains(`pbn-hide-cat-${k}`);
      function refreshHideButton() {
        const b = document.querySelector(`#${HIDE_ID} .pbn-lh-toggle`);
        if (!b) return;
        const n = hiddenCount();
        const text = picking() ? 'Done' : n ? `Hide · ${n}` : 'Hide';
        if (b.textContent !== text) b.textContent = text;
        b.classList.toggle('pbn-lh-btn--active', picking() || n > 0 || HIDE_CATS.some(([k]) => catOn(k)));
        b.title = picking() ? 'Click messages to hide or bring them back; click Done (or Esc) to finish' : 'Temporarily hide chat messages';
      }
      function onPickClick(e) {
        const row = e.target.closest(`${CHAT} ${ROW}`);
        if (!row) return;
        e.preventDefault(); e.stopPropagation();
        row.classList.toggle('pbn-hidden');
        refreshHideButton();
      }
      function onPickKey(e) { if (e.key === 'Escape') stopPicking(); }
      function startPicking() {
        document.body.classList.add('pbn-hide-picking');
        document.addEventListener('click', onPickClick, true);
        document.addEventListener('keydown', onPickKey, true);
        refreshHideButton();
      }
      function stopPicking() {
        document.body.classList.remove('pbn-hide-picking');
        document.removeEventListener('click', onPickClick, true);
        document.removeEventListener('keydown', onPickKey, true);
        refreshHideButton();
      }
      function buildHideMenu() {
        const menu = c.el('div', { className: 'pbn-tk-menu' }, c.el('div', { className: 'pbn-tk-menu__head', textContent: 'Hide messages' }));
        menu.setAttribute('role', 'menu');
        HIDE_CATS.forEach(([key, label]) => {
          const box = c.el('input', { type: 'checkbox', checked: catOn(key) });
          box.addEventListener('change', () => { document.body.classList.toggle(`pbn-hide-cat-${key}`, box.checked); refreshHideButton(); });
          menu.append(c.el('label', { className: 'pbn-tk-menu__check' }, box, label));
        });
        menu.append(c.el('div', { className: 'pbn-tk-menu__sep' }));
        const pick = c.el('button', { type: 'button', className: 'pbn-tk-menu__item', textContent: 'Pick messages to hide…' });
        pick.addEventListener('click', () => { currentPop?.close(); startPicking(); });
        const n = hiddenCount();
        const anyCat = HIDE_CATS.some(([k]) => catOn(k));
        const showAll = c.el('button', {
          type: 'button', className: 'pbn-tk-menu__item', title: 'Also turns the filters above off',
          textContent: n || !anyCat ? `Show all hidden (${n})` : 'Show everything', disabled: !n && !anyCat,
        });
        showAll.addEventListener('click', () => {
          document.querySelectorAll(`${CHAT} .pbn-hidden`).forEach(r => r.classList.remove('pbn-hidden'));
          HIDE_CATS.forEach(([k]) => document.body.classList.remove(`pbn-hide-cat-${k}`));
          currentPop?.close();
          refreshHideButton();
        });
        menu.append(pick, showAll);
        return menu;
      }
      function ensureHide() {
        if (!WITH_HIDE || document.getElementById(HIDE_ID)) return;
        const after = document.getElementById(SEARCH_ID) || document.getElementById(BTN_ID);
        if (!after) return;
        const toggle = c.el('button', { type: 'button', className: 'pbn-ls-btn pbn-ls-toggle pbn-lh-toggle', textContent: 'Hide' });
        toggle.setAttribute('aria-haspopup', 'menu');
        toggle.addEventListener('mousedown', e => e.preventDefault());
        toggle.addEventListener('click', () => { if (picking()) { stopPicking(); return; } c.togglePopover(toggle, buildHideMenu); });
        after.before(c.el('div', { id: HIDE_ID }, toggle));
        refreshHideButton();
      }
      function resetHide() {
        if (tagObserver) { tagObserver.disconnect(); tagObserver = null; tagContainer = null; }
        stopPicking();
        HIDE_CATS.forEach(([k]) => document.body.classList.remove(`pbn-hide-cat-${k}`));
      }

      // ---- Lifecycle: a 1s tick keeps the hook, buttons and tags current.
      let tick = null, enteredAt = 0;
      function sync() {
        ensureButton();
        ensureSearch();
        ensureHide();
        if (WITH_HIDE) { tagWhispers(); refreshHideButton(); }
        if (hooked && hooked.inst.isUnmounted) unhook();
        if (!hooked) {
          const inst = c.findPlayInstance();
          if (inst) { const wasFallback = !!observedContainer; stopDomFallback(); hookInstance(inst, { backfill: !wasFallback }); }
        }
        if (!hooked && Date.now() - enteredAt > FALLBACK_AFTER_MS) startDomFallback();
        const b = document.getElementById(BTN_ID);
        if (b) {
          const how = hooked ? "recording from the game's RP message list" : observedContainer ? 'FALLBACK: recording from the chat on screen' : 'starting…';
          const title = `Download this session's chat as a text file (${entries.length} messages, ${how})`;
          if (b.title !== title) b.title = title;
        }
      }
      c.onRoute(c.isPlay, () => { enteredAt = Date.now(); sync(); tick = setInterval(sync, 1000); }, () => {
        clearInterval(tick); tick = null;
        unhook(); stopDomFallback(); clearHits(); searchState = null; resetHide();
      });
    },
  });

  // ==========================================================================
  // MODULE: Compass Tools
  // ==========================================================================

  defineModule({
    id: 'compass-tools',
    name: 'Compass Tools',
    description: 'Room names on compass hover, a Walk / Look / Search switch, and an always-there Up / Down bar.',
    start(c) {
      const DIR = { N: 'north', NE: 'northeast', E: 'east', SE: 'southeast', S: 'south', SW: 'southwest', W: 'west', NW: 'northwest' };
      const MODES = ['walk', 'look', 'search'];
      let mode = 'walk';

      c.addStyle(`
        .pbn-compass-toggle {
          display: flex; margin-bottom: 6px; overflow: hidden; width: 100%; max-width: 230px; box-sizing: border-box;
          border: 1px solid #9e2b2b80; border-radius: 6px;
        }
        .pbn-compass-toggle__btn {
          flex: 1; cursor: pointer; padding: 5px 8px; background: none; border: none;
          font-family: 'Courier New', monospace; font-size: .9rem; letter-spacing: .04em; color: #b0a489; transition: background .12s, color .12s;
        }
        .pbn-compass-toggle__btn + .pbn-compass-toggle__btn { border-left: 1px solid #9e2b2b59; }
        .pbn-compass-toggle__btn:hover { color: #e8dcc0; }
        .pbn-compass-toggle__btn:focus-visible { outline: 2px solid #e0b84a; outline-offset: -2px; }
        .pbn-compass-toggle__btn--active, .pbn-compass-toggle__btn--active:hover { color: #f3e6cf; background: #9e2b2b; }
        .vertical-exits { display: none !important; }
        .pbn-compass-vertical { margin: 6px 0 0; }
        .pbn-compass-toggle__btn:disabled, .pbn-compass-toggle__btn:disabled:hover { color: #b0a489; opacity: .35; cursor: not-allowed; }
        .pbn-compass-vertical .pbn-vx--locked { color: #d4a34b; }
        .pbn-compass-vertical .pbn-vx--broken { color: #e07062; }
        .pbn-compass-vertical .pbn-vx--aerial-open { color: #aaaa5a; }
        .pbn-compass-vertical .pbn-vx--aerial-locked { color: #4a4a2a; cursor: not-allowed; }
      `);

      function applyTooltips(compass) {
        compass.querySelectorAll('.compass__cell--open').forEach(btn => {
          const m = (btn.getAttribute('aria-label') || '').match(/^Go \w+ to (.+)$/i);
          if (m) btn.title = m[1];
        });
      }

      const setPressed = (b, on) => { b.classList.toggle('pbn-compass-toggle__btn--active', on); b.setAttribute('aria-pressed', String(on)); };

      function makeToggle(compass) {
        if (compass.previousElementSibling?.id === 'pbn-compass-toggle') return;
        const bar = c.el('div', { id: 'pbn-compass-toggle', className: 'pbn-compass-toggle' });
        bar.setAttribute('role', 'group');
        bar.setAttribute('aria-label', 'Compass click mode');
        MODES.forEach(m => {
          const b = c.el('button', { type: 'button', className: 'pbn-compass-toggle__btn', textContent: m[0].toUpperCase() + m.slice(1) });
          b.dataset.mode = m;
          setPressed(b, m === mode);
          b.addEventListener('mousedown', e => e.preventDefault());
          b.addEventListener('click', () => {
            mode = m;
            bar.querySelectorAll('button').forEach(x => setPressed(x, x.dataset.mode === mode));
            refreshVertical();
          });
          bar.append(b);
        });
        compass.parentElement.insertBefore(bar, compass);
      }

      const VERTICAL = [{ dir: 'up', label: '↑ Up' }, { dir: 'down', label: '↓ Down' }];
      const VX_STATES = ['locked', 'broken', 'aerial-open', 'aerial-locked'];
      function nativeVertical(dir) {
        const re = new RegExp(`\\b${dir}\\b`, 'i');
        return Array.from(document.querySelectorAll('.vertical-exit-btn'))
          .find(b => re.test(`${b.getAttribute('aria-label') || ''} ${b.textContent}`)) || null;
      }
      function makeVertical(compass) {
        if (compass.nextElementSibling?.classList.contains('pbn-compass-vertical')) return;
        const bar = c.el('div', { className: 'pbn-compass-toggle pbn-compass-vertical' });
        bar.setAttribute('role', 'group');
        bar.setAttribute('aria-label', 'Vertical exits');
        VERTICAL.forEach(({ dir, label }) => {
          const b = c.el('button', { type: 'button', className: 'pbn-compass-toggle__btn', textContent: label });
          b.dataset.dir = dir;
          b.dataset.label = label;
          b.addEventListener('mousedown', e => e.preventDefault());
          b.addEventListener('click', () => {
            if (mode !== 'walk') { c.sendCommand(`/${mode} ${dir}`); return; }
            const native = nativeVertical(dir);
            if (native && !native.disabled) native.click();
          });
          bar.append(b);
        });
        compass.after(bar);
        refreshVertical();
      }
      function refreshVertical() {
        document.querySelectorAll('.pbn-compass-vertical button').forEach(b => {
          const native = nativeVertical(b.dataset.dir);
          b.disabled = mode === 'walk' && (!native || native.disabled);
          // Always the plain label; state markers show as colours instead.
          // Only write on change (a text write would re-trigger the observer).
          if (b.textContent !== b.dataset.label) b.textContent = b.dataset.label;
          VX_STATES.forEach(s => b.classList.toggle(`pbn-vx--${s}`, !!native?.classList.contains(`vertical-exit-btn--${s}`)));
          const m = (native?.getAttribute('aria-label') || '').match(/^Go \w+ to (.+)$/i);
          b.title = m ? m[1] : (native?.title || '');
        });
      }

      // A cell's direction regardless of state markers (locked "=", flight,
      // broken door…): aria-label words first, then the N/NE/… letters.
      const DIR_WORD_RE = /\b(?:north|south)(?:east|west)?\b|\b(?:east|west)\b/i;
      const DIR_ABBR_RE = /(?:^|[^A-Z])(NW|NE|SW|SE|N|E|S|W)(?=[^A-Z]|$)/;
      function cellDirection(cell) {
        const w = (cell.getAttribute('aria-label') || '').match(DIR_WORD_RE);
        if (w) return w[0].toLowerCase();
        const a = cell.textContent.toUpperCase().match(DIR_ABBR_RE);
        return a ? DIR[a[1]] : null;
      }

      function attachIntercept(compass) {
        if (compass.dataset.pbnIntercepted) return;
        compass.dataset.pbnIntercepted = '1';
        // pointerdown fires even on disabled cells; capture runs before Vue.
        compass.addEventListener('pointerdown', e => {
          if (mode === 'walk') return;
          const cell = e.target.closest('.compass__cell');
          const dir = cell && cellDirection(cell);
          if (dir) c.sendCommand(`/${mode} ${dir}`);
        }, true);
        compass.addEventListener('click', e => {
          if (mode !== 'walk' && e.target.closest('.compass__cell')) { e.preventDefault(); e.stopPropagation(); }
        }, true);
      }

      const wired = new WeakSet();
      function mountAll() {
        document.querySelectorAll('.compass').forEach(compass => {
          if (wired.has(compass)) return;
          wired.add(compass);
          applyTooltips(compass);
          makeToggle(compass);
          makeVertical(compass);
          attachIntercept(compass);
        });
      }

      let observer = null;
      c.onRoute(c.isPlay, () => {
        if (observer) return;
        observer = new MutationObserver(ms => {
          refreshVertical();
          const toUpdate = new Set();
          for (const m of ms) {
            if (m.type === 'attributes') { const cp = m.target.closest?.('.compass'); if (cp) toUpdate.add(cp); continue; }
            for (const n of m.addedNodes) {
              if (n.nodeType !== 1) continue;
              if (n.classList?.contains('compass') || n.querySelector?.('.compass')) { mountAll(); return; }
              if (n.classList?.contains('compass__cell')) { const cp = n.closest('.compass'); if (cp) toUpdate.add(cp); }
            }
          }
          toUpdate.forEach(applyTooltips);
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-label'] });
        mountAll();
      }, () => { if (observer) { observer.disconnect(); observer = null; } });
    },
  });

  // ==========================================================================
  // MODULE: Character Cards
  // ==========================================================================

  const CC = {
    KEY: 'pbn-character-cards', DEFAULT_COLS: 3, MIN_COLS: 1, MAX_COLS: 6, COLS_VAR: '--pbn-cc-cols', READY: 'data-pbn-cc-ready',
    load() {
      try {
        const raw = JSON.parse(localStorage.getItem(CC.KEY) || '{}');
        return {
          order: Array.isArray(raw.order) ? raw.order : [],
          cols: Math.min(CC.MAX_COLS, Math.max(CC.MIN_COLS, parseInt(raw.cols, 10) || CC.DEFAULT_COLS)),
        };
      } catch (e) { return { order: [], cols: CC.DEFAULT_COLS }; }
    },
    save(state) { localStorage.setItem(CC.KEY, JSON.stringify(state)); },
    setCols(n) { document.documentElement.style.setProperty(CC.COLS_VAR, String(n)); },
  };

  defineModule({
    id: 'character-cards',
    name: 'Character Cards',
    description: 'My Characters page: reorder cards, choose cards per row, and an Options menu for recast / leave / delete.',
    // Before first paint: column count, and the grid stays invisible until
    // arranged (a CSS-only timer reveals it after 1.5s regardless).
    early(c) {
      c.addStyle(`
        .mc-grid { grid-template-columns: repeat(var(${CC.COLS_VAR}, ${CC.DEFAULT_COLS}), 1fr) !important; }
        .mc-grid:not([${CC.READY}]) { visibility: hidden; animation: pbn-cc-failsafe 0s 1.5s forwards; }
        @keyframes pbn-cc-failsafe { to { visibility: visible; } }
      `);
      CC.setCols(CC.load().cols);
    },
    start(c) {
      const getCardKey = a => a.getAttribute('aria-label') || a.querySelector('.mc-card__name')?.textContent.trim() || '';
      function currentOrderedCards(grid) {
        return Array.from(grid.querySelectorAll(':scope > .mc-card'))
          .map((x, i) => ({ x, o: x.style.order !== '' ? parseInt(x.style.order, 10) : i }))
          .sort((a, b) => a.o - b.o).map(z => z.x);
      }
      function applyOrderAndPrune(grid, state) {
        const keyed = Array.from(grid.querySelectorAll(':scope > .mc-card')).map(x => ({ x, key: getCardKey(x) }));
        if (!keyed.length) return; // never prune against a grid whose cards haven't loaded
        const present = new Set(keyed.map(k => k.key));
        const known = state.order.filter(k => present.has(k));
        const knownSet = new Set(known);
        const finalOrder = known.concat(keyed.filter(k => !knownSet.has(k.key)).map(k => k.key));
        finalOrder.forEach((key, i) => { const e = keyed.find(k => k.key === key); if (e) e.x.style.order = String(i); });
        if (finalOrder.join('') !== state.order.join('')) { state.order = finalOrder; CC.save(state); }
      }
      function refreshButtons(grid) {
        const cards = currentOrderedCards(grid);
        cards.forEach((x, i) => {
          const up = x.querySelector('.pbn-cc-up'), down = x.querySelector('.pbn-cc-down');
          if (up) up.disabled = i === 0;
          if (down) down.disabled = i === cards.length - 1;
        });
      }
      function moveCard(grid, state, key, dir) {
        const cards = currentOrderedCards(grid);
        const idx = cards.findIndex(x => getCardKey(x) === key), swap = idx + dir;
        if (idx < 0 || swap < 0 || swap >= cards.length) return;
        [cards[idx], cards[swap]] = [cards[swap], cards[idx]];
        cards.forEach((x, i) => { x.style.order = String(i); });
        state.order = cards.map(getCardKey);
        CC.save(state);
        refreshButtons(grid);
      }
      function reveal(grid) {
        if (grid.hasAttribute(CC.READY) || !grid.querySelector(':scope > .mc-card')) return;
        const cards = currentOrderedCards(grid);
        cards.forEach((x, i) => { x.style.animationDelay = `${i * 80}ms`; x.style.animationName = 'none'; });
        void grid.offsetWidth;
        cards.forEach(x => { x.style.animationName = ''; });
        grid.setAttribute(CC.READY, '');
      }
      function makeBtn(label, className) {
        const b = c.el('button', { type: 'button', textContent: label, className });
        b.addEventListener('mousedown', e => e.preventDefault());
        return b;
      }

      const uiStyle = c.addStyle(`
        .mc-card__respec button, .mc-card__leave button, .mc-grid .mc-card__action--delete { display: none !important; }
        .mc-card__respec:not(:has(> :not(button))), .mc-card__leave:not(:has(> :not(button))) { display: none !important; }
        .pbn-cc-menu {
          position: fixed; z-index: 9000; display: flex; flex-direction: column; min-width: 200px; padding: 4px 0;
          background: linear-gradient(175deg, #161a28 0%, #111520 60%, #0f1118 100%);
          border: 1px solid #ffffff1a; border-radius: 6px; box-shadow: 0 4px 12px #0006, 0 12px 40px #00000040;
        }
        .pbn-cc-menu__item {
          display: block; width: 100%; text-align: left; white-space: nowrap; padding: .7rem 1.1rem; border: 0; background: none; cursor: pointer;
          font-family: Georgia, 'Times New Roman', serif; font-size: .95rem; text-transform: uppercase; letter-spacing: .8px; color: #9a8e7e;
          transition: color .2s, background .2s;
        }
        .pbn-cc-menu__item:hover:not(:disabled) { background: #ffffff0a; color: #e8ddd0; }
        .pbn-cc-menu__item:focus-visible { outline: 2px solid #e31c2580; outline-offset: -2px; }
        .pbn-cc-menu__item:disabled { cursor: default; opacity: .45; }
        .pbn-cc-menu__item--recast { color: #e0c48a; }
        .pbn-cc-menu__item--recast:hover:not(:disabled) { color: #f3e2b8; }
        .pbn-cc-menu__item--leave { color: #c8d6f5; }
        .pbn-cc-menu__item--return { color: #e6c27a; }
        .pbn-cc-menu__item--delete { border-top: 1px solid #ffffff14; }
        .pbn-cc-menu__item--delete:hover:not(:disabled) { color: #c44040; }
        .mc-card__actions .pbn-cc-move { flex: 0 0 auto !important; padding: .75rem .85rem !important; }
        .mc-card__actions .pbn-cc-move:disabled { opacity: .3; }
        .mc-card__actions .pbn-cc-move:disabled:hover { color: #9a8e7e; background: none; }
        #pbn-cc-stepper { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; font-family: Georgia, 'Times New Roman', serif; }
        .pbn-cc-stepper__label { color: #9a8e7e; font-size: .95rem; text-transform: uppercase; letter-spacing: .8px; margin-right: 4px; }
        .pbn-cc-stepper__btn {
          width: 2rem; height: 2rem; padding: 0; cursor: pointer; font-family: inherit; font-size: 1.1rem; line-height: 1; color: #9a8e7e;
          background: linear-gradient(175deg, #161a28 0%, #111520 60%, #0f1118 100%); border: 1px solid #ffffff1a; border-radius: 4px;
          transition: color .2s, border-color .2s;
        }
        .pbn-cc-stepper__btn:hover { color: #e8ddd0; border-color: #e31c2566; }
        .pbn-cc-stepper__btn:focus-visible { outline: 2px solid #e31c2580; outline-offset: 2px; }
        .pbn-cc-stepper__count { min-width: 1.6em; text-align: center; color: #e8ddd0; font-size: 1.05rem; }
      `, { disabled: true });

      function wireCard(grid, state, article) {
        const actions = article.querySelector('.mc-card__actions');
        if (!actions || actions.querySelector('.pbn-cc-up')) return;
        const up = makeBtn('▲', 'mc-card__action pbn-cc-move pbn-cc-up');
        const down = makeBtn('▼', 'mc-card__action pbn-cc-move pbn-cc-down');
        up.setAttribute('aria-label', 'Move card earlier');
        down.setAttribute('aria-label', 'Move card later');
        const sib = actions.querySelector('.mc-card__action');
        c.copyScopeAttrs(sib, up);
        c.copyScopeAttrs(sib, down);
        up.addEventListener('click', () => moveCard(grid, state, getCardKey(article), -1));
        down.addEventListener('click', () => moveCard(grid, state, getCardKey(article), 1));
        actions.append(up, down);
      }

      // Options menu: recast / leave / delete. Originals stay (hidden) and
      // are clicked, so the site's own handlers and confirm dialogs run.
      function itemKind(orig) {
        if (orig.matches('.mc-card__action--delete')) return 'delete';
        if (orig.matches('.mc-card__leave-btn--return')) return 'return';
        if (orig.closest('.mc-card__respec')) return 'recast';
        return 'leave';
      }
      function menuEntries(article) {
        const out = [];
        article.querySelectorAll('.mc-card__respec button, .mc-card__leave button').forEach(b => out.push({ orig: b, label: b.textContent.trim() }));
        const del = article.querySelector('.mc-card__action--delete');
        if (del) out.push({ orig: del, label: del.textContent.trim() || 'Delete' });
        return out;
      }
      function buildMenu(article) {
        const entries = menuEntries(article);
        if (!entries.length) return null;
        const menu = c.el('div', { className: 'pbn-cc-menu' });
        menu.setAttribute('role', 'menu');
        entries.forEach(({ orig, label }) => {
          const item = c.el('button', { type: 'button', className: `pbn-cc-menu__item pbn-cc-menu__item--${itemKind(orig)}`, textContent: label, disabled: orig.disabled });
          item.setAttribute('role', 'menuitem');
          if (orig.title) item.title = orig.title;
          item.addEventListener('click', () => { currentPop?.close(); orig.click(); });
          menu.append(item);
        });
        return menu;
      }
      function wireOptions(article) {
        const actions = article.querySelector('.mc-card__actions');
        if (!actions || actions.querySelector('.pbn-cc-options') || !menuEntries(article).length) return;
        const optsBtn = c.el('button', { type: 'button', className: 'mc-card__action mc-card__action--options pbn-cc-options', textContent: 'Options ▾' });
        optsBtn.setAttribute('aria-haspopup', 'menu');
        optsBtn.setAttribute('aria-expanded', 'false');
        optsBtn.setAttribute('aria-label', 'More options');
        c.copyScopeAttrs(actions.querySelector('.mc-card__action'), optsBtn);
        optsBtn.addEventListener('click', () => {
          const pop = c.togglePopover(optsBtn, () => buildMenu(article), { closeOnScroll: true });
          pop?.menu.querySelector('button:not(:disabled)')?.focus();
        });
        const del = actions.querySelector('.mc-card__action--delete');
        if (del) del.after(optsBtn); else actions.append(optsBtn);
      }

      function buildStepperBar(grid, state) {
        if (grid.previousElementSibling?.id === 'pbn-cc-stepper') return;
        const countEl = c.el('span', { className: 'pbn-cc-stepper__count', textContent: String(state.cols) });
        const minus = makeBtn('–', 'pbn-cc-stepper__btn'), plus = makeBtn('+', 'pbn-cc-stepper__btn');
        minus.setAttribute('aria-label', 'Fewer cards per row');
        plus.setAttribute('aria-label', 'More cards per row');
        const step = d => {
          state.cols = Math.min(CC.MAX_COLS, Math.max(CC.MIN_COLS, state.cols + d));
          CC.setCols(state.cols); CC.save(state); countEl.textContent = String(state.cols);
        };
        minus.addEventListener('click', () => step(-1));
        plus.addEventListener('click', () => step(1));
        grid.parentElement.insertBefore(
          c.el('div', { id: 'pbn-cc-stepper' }, c.el('span', { className: 'pbn-cc-stepper__label', textContent: 'Cards per row' }), minus, countEl, plus),
          grid);
      }

      const wired = new WeakSet();
      let gridObserver = null, mountedGrid = null, docObserver = null;
      function mount() {
        const grid = document.querySelector('.mc-grid');
        if (!grid) return;
        if (gridObserver) gridObserver.disconnect();
        mountedGrid = grid;
        const state = CC.load();
        CC.setCols(state.cols);
        uiStyle.disabled = false;
        buildStepperBar(grid, state);
        // Observer callbacks run before paint, so the unarranged state is never drawn.
        function arrange(s) {
          applyOrderAndPrune(grid, s);
          grid.querySelectorAll(':scope > .mc-card').forEach(x => { if (!wired.has(x)) { wired.add(x); wireCard(grid, s, x); } wireOptions(x); });
          refreshButtons(grid);
          reveal(grid);
        }
        arrange(state);
        gridObserver = new MutationObserver(() => arrange(CC.load()));
        gridObserver.observe(grid, { childList: true });
      }
      function syncGrid() { const g = document.querySelector('.mc-grid'); if (g && g !== mountedGrid) mount(); }

      c.onRoute(() => /\/my_characters\/?$/.test(location.pathname) || !!document.querySelector('.mc-grid'), () => {
        syncGrid();
        docObserver = new MutationObserver(syncGrid);
        docObserver.observe(document.documentElement, { childList: true, subtree: true });
      }, () => {
        if (docObserver) { docObserver.disconnect(); docObserver = null; }
        if (gridObserver) { gridObserver.disconnect(); gridObserver = null; }
        mountedGrid = null;
        uiStyle.disabled = true;
        document.getElementById('pbn-cc-stepper')?.remove();
      });
    },
  });

  // ==========================================================================
  // MODULE: Description Presets
  // ==========================================================================

  defineModule({
    id: 'desc-presets',
    name: 'Description Presets',
    description: 'Save /setdesc looks per character and switch between them with the masks icon by the command box.',
    note: 'Presets are saved from the Presets row inside the /setdesc dialog.',
    start(c) {
      const KEY = 'pbn-desc-presets';
      const FIELDS = [
        { key: 'short', label: 'Short description', sel: 'input[aria-label^="Short description"]' },
        { key: 'full', label: 'Full description', sel: 'textarea[aria-label^="Full description"]' },
        { key: 'arrive', label: 'Arrive message', sel: 'input[aria-label^="Arrival message"]' },
        { key: 'depart', label: 'Depart message', sel: 'input[aria-label^="Departure message"]' },
      ];
      const loadAll = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } };
      const saveAll = all => localStorage.setItem(KEY, JSON.stringify(all));
      function charData(all, name) {
        const d = all[name] || (all[name] = { presets: [], last: null });
        if (!Array.isArray(d.presets)) d.presets = [];
        return d;
      }
      const charName = () => c.getCharName() || 'default';

      const fieldEl = (card, f) => card.querySelector(f.sel);
      function readCard(card) { const o = {}; FIELDS.forEach(f => { const n = fieldEl(card, f); if (n) o[f.key] = n.value; }); return o; }
      function applyToCard(card, preset) {
        FIELDS.forEach(f => {
          if (typeof preset[f.key] !== 'string') return;
          const n = fieldEl(card, f);
          if (n && n.value !== preset[f.key]) c.setNativeValue(n, preset[f.key]);
        });
      }
      function presetMatches(card, p) {
        const cur = readCard(card);
        const keys = FIELDS.map(f => f.key).filter(k => typeof p[k] === 'string');
        return keys.length > 0 && keys.every(k => cur[k] === p[k]);
      }
      const presetParts = p => FIELDS.filter(f => typeof p[f.key] === 'string').map(f => f.label).join(', ');

      c.addStyle(`
        .pbn-dp-section { padding-top: 0 !important; }
        .pbn-dp-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 8px; }
        .pbn-dp-chips__empty { opacity: .7; font-size: .95rem; font-style: italic; }
        .pbn-dp-chip { display: inline-flex; align-items: stretch; overflow: hidden; border: 1px solid #ffffff2e; border-radius: 999px; background: #ffffff0d; }
        .pbn-dp-chip--active { border-color: #c49a4a; background: #c49a4a26; }
        .pbn-dp-chip button { background: none; border: 0; color: #e8ddd0; cursor: pointer; font: inherit; font-size: .95rem; line-height: 1.3; }
        .pbn-dp-chip__apply { padding: 5px 12px; }
        .pbn-dp-chip--active .pbn-dp-chip__apply { color: #f3e2b8; }
        .pbn-dp-chip__apply:hover { background: #ffffff14; }
        .pbn-dp-chip__del { padding: 5px 10px 5px 8px; opacity: .55; border-left: 1px solid #ffffff1f !important; }
        .pbn-dp-chip__del:hover { opacity: 1; color: #e07062; background: #ffffff0d; }
        .pbn-dp-link { background: none; border: 0; padding: 2px 0; cursor: pointer; color: #c49a4a; font: inherit; font-size: .95rem; text-decoration: underline dotted; }
        .pbn-dp-link:hover { color: #f3e2b8; }
        .pbn-dp-form { display: none; margin-top: 8px; padding: 10px 12px; border: 1px solid #ffffff1f; border-radius: 6px; background: #0000002e; }
        .pbn-dp-form--open { display: block; }
        .pbn-dp-form__name {
          width: 100%; box-sizing: border-box; padding: 6px 9px; margin-bottom: 8px; background: #00000040; color: #e8ddd0;
          border: 1px solid #ffffff2e; border-radius: 4px; font: inherit; font-size: 1rem;
        }
        .pbn-dp-form__name:focus { outline: none; border-color: #c49a4a; }
        .pbn-dp-form__parts { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-bottom: 10px; font-size: .95rem; }
        .pbn-dp-form__parts label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
        .pbn-dp-form__row { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
        .pbn-dp-form__msg { flex: 1; color: #e07062; font-size: .95rem; }
        .pbn-dp-btn { cursor: pointer; padding: 5px 14px; border-radius: 4px; font: inherit; font-size: .95rem; background: #ffffff0d; color: #e8ddd0; border: 1px solid #ffffff2e; }
        .pbn-dp-btn:hover { background: #ffffff1a; }
        .pbn-dp-btn--primary { background: #9e2b2b; border-color: #9e2b2b; color: #f3e6cf; }
        .pbn-dp-btn--primary:hover { background: #b33434; }
        body.pbn-dp-auto .q-dialog:has(.desc-card) { visibility: hidden !important; }
      `);

      let autoRunning = false;

      function buildSaveForm(card, onSaved) {
        const nameInput = c.el('input', { type: 'text', className: 'pbn-dp-form__name', placeholder: 'Preset name, e.g. Hooded', maxLength: 40 });
        const boxes = FIELDS.map(f => { const b = c.el('input', { type: 'checkbox', checked: true }); b.dataset.key = f.key; return { b, f }; });
        const parts = c.el('div', { className: 'pbn-dp-form__parts' }, ...boxes.map(({ b, f }) => c.el('label', {}, b, f.label)));
        const msg = c.el('span', { className: 'pbn-dp-form__msg' });
        const cancel = c.el('button', { type: 'button', className: 'pbn-dp-btn', textContent: 'Cancel' });
        const save = c.el('button', { type: 'button', className: 'pbn-dp-btn pbn-dp-btn--primary', textContent: 'Save preset' });
        const form = c.el('div', { className: 'pbn-dp-form' }, nameInput, parts, c.el('div', { className: 'pbn-dp-form__row' }, msg, cancel, save));
        const close = () => { form.classList.remove('pbn-dp-form--open'); msg.textContent = ''; };
        function submit() {
          const presetName = nameInput.value.trim();
          const keys = boxes.filter(x => x.b.checked).map(x => x.b.dataset.key);
          if (!presetName) { msg.textContent = 'Give the preset a name.'; nameInput.focus(); return; }
          if (!keys.length) { msg.textContent = 'Tick at least one field.'; return; }
          const cur = readCard(card);
          const preset = { name: presetName };
          keys.forEach(k => { if (typeof cur[k] === 'string') preset[k] = cur[k]; });
          const all = loadAll();
          const d = charData(all, charName());
          const idx = d.presets.findIndex(p => p.name.toLowerCase() === presetName.toLowerCase());
          if (idx >= 0) {
            if (!confirm(`A preset called "${d.presets[idx].name}" exists. Replace it with the current fields?`)) return;
            d.presets[idx] = preset;
          } else d.presets.push(preset);
          d.last = preset.name;
          saveAll(all);
          close();
          onSaved();
        }
        cancel.addEventListener('click', close);
        save.addEventListener('click', submit);
        nameInput.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        });
        nameInput.addEventListener('keyup', e => { if (e.key === 'Escape') e.stopPropagation(); }); // Quasar closes on Escape keyup
        return {
          form,
          open() { form.classList.add('pbn-dp-form--open'); nameInput.value = ''; boxes.forEach(x => { x.b.checked = true; }); msg.textContent = ''; nameInput.focus(); },
        };
      }

      function enhanceCard(card) {
        if (card.dataset.pbnDp || !card.querySelector(FIELDS[1].sel)) return;
        card.dataset.pbnDp = '1';
        const first = card.querySelector('.q-card__section');
        const section = c.el('div', { className: 'q-card__section q-card__section--vert q-pb-sm pbn-dp-section' });
        c.copyScopeAttrs(first, section);
        const siteLabel = card.querySelector('.desc-field-label');
        const head = c.el('div', { className: 'desc-field-label' });
        head.innerHTML = '<i aria-hidden="true" class="q-icon notranslate material-icons q-mr-xs text-grey-5" style="font-size:14px"><span aria-hidden="true">theater_comedy</span></i><span>Presets</span>';
        head.append(c.el('span', { className: 'desc-field-hint', textContent: '— click a look to fill the fields, then Save' }));
        c.copyScopeAttrs(siteLabel, head);
        head.querySelectorAll('*').forEach(n => c.copyScopeAttrs(siteLabel, n));
        const chips = c.el('div', { className: 'pbn-dp-chips' });
        const link = c.el('button', { type: 'button', className: 'pbn-dp-link', textContent: 'Save current as preset…' });
        const saveForm = buildSaveForm(card, () => render());
        link.addEventListener('click', () => saveForm.open());
        function render() {
          const name = charName();
          const d = charData(loadAll(), name);
          chips.textContent = '';
          if (!d.presets.length) { chips.append(c.el('span', { className: 'pbn-dp-chips__empty', textContent: `No presets for ${name} yet.` })); return; }
          d.presets.forEach(p => {
            const apply = c.el('button', { type: 'button', className: 'pbn-dp-chip__apply', textContent: p.name, title: `Fill: ${presetParts(p)}` });
            apply.addEventListener('click', () => {
              applyToCard(card, p);
              const all = loadAll(); charData(all, name).last = p.name; saveAll(all);
              render();
            });
            const del = c.el('button', { type: 'button', className: 'pbn-dp-chip__del', textContent: '×', title: `Delete preset "${p.name}"` });
            del.setAttribute('aria-label', `Delete preset ${p.name}`);
            del.addEventListener('click', () => {
              if (!confirm(`Delete the preset "${p.name}"? Your current description isn't affected.`)) return;
              const all = loadAll(); const dd = charData(all, name);
              dd.presets = dd.presets.filter(x => x.name !== p.name);
              if (dd.last === p.name) dd.last = null;
              saveAll(all);
              render();
            });
            chips.append(c.el('span', { className: 'pbn-dp-chip' + (presetMatches(card, p) ? ' pbn-dp-chip--active' : '') }, apply, del));
          });
        }
        render();
        card.addEventListener('input', e => { if (!e.target.closest('.pbn-dp-section')) render(); });
        section.append(head, chips, link, saveForm.form);
        first.after(section);
      }

      function openCard() {
        const card = document.querySelector('.q-dialog .desc-card');
        return card && card.querySelector(FIELDS[1].sel) ? card : null;
      }

      async function applyAndSave(preset) {
        if (autoRunning) return;
        autoRunning = true;
        document.body.classList.add('pbn-dp-auto');
        try {
          let card = openCard();
          if (!card) {
            if (!await c.sendCommand('/setdesc')) return;
            card = await c.waitFor(openCard, 5000);
            if (!card) return;
            await c.sleep(150); // let the dialog load its current values
          }
          applyToCard(card, preset);
          await c.sleep(80);
          card.querySelector('.desc-save-btn')?.click();
          if (await c.waitFor(() => !card.isConnected, 5000)) {
            const all = loadAll(); charData(all, charName()).last = preset.name; saveAll(all);
          }
          // If it didn't close, the finally reveals it with the site's error.
        } finally {
          document.body.classList.remove('pbn-dp-auto');
          autoRunning = false;
        }
      }

      function buildQuickMenu() {
        const name = charName();
        const d = charData(loadAll(), name);
        const menu = c.el('div', { className: 'pbn-tk-menu' }, c.el('div', { className: 'pbn-tk-menu__head', textContent: `${name} — looks` }));
        menu.setAttribute('role', 'menu');
        if (!d.presets.length) menu.append(c.el('div', { className: 'pbn-tk-menu__note', textContent: 'No presets yet. Open /setdesc and use "Save current as preset…".' }));
        d.presets.forEach(p => {
          const item = c.el('button', { type: 'button', className: 'pbn-tk-menu__item', title: `Sets: ${presetParts(p)}` },
            c.el('span', { className: 'pbn-tk-menu__check', textContent: d.last === p.name ? '✓' : '' }), p.name);
          item.setAttribute('role', 'menuitem');
          item.addEventListener('click', async () => {
            menu.querySelectorAll('button').forEach(b => { b.disabled = true; });
            await applyAndSave(p);
            currentPop?.close();
          });
          menu.append(item);
        });
        const edit = c.el('button', { type: 'button', className: 'pbn-tk-menu__item' }, c.el('span', { className: 'pbn-tk-menu__check' }), 'Open /setdesc…');
        edit.addEventListener('click', () => { currentPop?.close(); c.sendCommand('/setdesc'); });
        menu.append(c.el('div', { className: 'pbn-tk-menu__sep' }), edit);
        return menu;
      }

      function ensureQuickButton() {
        if (!c.isPlay() || document.getElementById('pbn-dp-quick')) return;
        const btn = makeIconButton('pbn-dp-quick', 'theater_comedy', 'Description presets');
        if (!btn) return;
        btn.addEventListener('click', () => {
          const pop = c.togglePopover(btn, buildQuickMenu, { above: true });
          pop?.menu.querySelector('.pbn-tk-menu__item')?.focus();
        });
      }

      new MutationObserver(() => {
        const card = openCard();
        if (card && !autoRunning) enhanceCard(card);
        ensureQuickButton();
      }).observe(document.body, { childList: true, subtree: true });
      ensureQuickButton();
    },
  });

  // Icon button in the command box's icon row, copied from the site's own
  // "Set your mood" button so it matches; inserted just before it.
  function makeIconButton(id, icon, label) {
    const mood = document.querySelector('.command-bar .q-field__append [aria-label="Set your mood"]');
    if (!mood) return null;
    const btn = el('button', { id, type: 'button', className: mood.className, title: label });
    copyScopeAttrs(mood, btn);
    btn.setAttribute('style', mood.getAttribute('style') || '');
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span class="q-focus-helper"></span><span class="q-btn__content text-center col items-center q-anchor--skip justify-center row no-wrap">' +
      `<i aria-hidden="true" class="q-icon notranslate material-icons" role="img"><span aria-hidden="true">${icon}</span></i></span>`;
    btn.addEventListener('mousedown', e => e.preventDefault());
    mood.before(btn);
    return btn;
  }

  // ==========================================================================
  // MODULE: Language Switcher
  // ==========================================================================

  defineModule({
    id: 'speak',
    name: 'Language Switcher',
    description: 'Per-character known languages with one-click /speak and a "next line only" [language] tag, by the command box.',
    note: 'Languages are ticked under Manage languages… in its menu; the game\'s own "learned" and "now speak in" lines keep it up to date.',
    start(c) {
      const KEY = 'pbn-speak';
      const ENGLISH = 'English';
      const CATALOG = [
        ['Ancient Greek', ['greek']], ['Arabic', []], ['Bengali', []], ['Danish', ['dansk']], ['Dutch', []], ['Farsi', ['persian']],
        ['French', []], ['Gaelic', ['irish', 'gaeilge', 'scottish gaelic']], ['German', []],
        ['Hebrew', ['ivrit', 'modern hebrew', 'biblical hebrew']], ['Hindi', []], ['Italian', []], ['Japanese', []], ['Korean', []],
        ['Latin', []], ['Mandarin', []], ['Norwegian', ['norsk']], ['Polish', []], ['Portuguese', []], ['Romanian', []], ['Russian', []],
        ['Spanish', []], ['Swahili', []], ['Swedish', ['svenska']], ['Tagalog', ['filipino']], ['Turkish', []], ['Ukrainian', []],
        ['Urdu', []], ['Vietnamese', []], ['Yiddish', ['yidish', 'mameloshn', 'mameloshen']],
      ];
      function canonical(name) {
        const n = String(name || '').trim().toLowerCase();
        if (!n) return null;
        if (n === 'english') return ENGLISH;
        for (const [lang, aliases] of CATALOG) if (lang.toLowerCase() === n || aliases.includes(n)) return lang;
        return null;
      }
      const cmdName = lang => lang.toLowerCase();
      const loadAll = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } };
      const saveAll = all => localStorage.setItem(KEY, JSON.stringify(all));
      function charData(all, name) {
        const d = all[name] || (all[name] = { known: [], current: ENGLISH });
        if (!Array.isArray(d.known)) d.known = [];
        if (!d.current) d.current = ENGLISH;
        return d;
      }
      const charName = () => c.getCharName() || 'default';
      function update(fn) {
        const all = loadAll();
        const d = charData(all, charName());
        fn(d);
        d.known = CATALOG.map(([l]) => l).filter(l => d.known.includes(l));
        saveAll(all);
        refreshBadge();
      }

      // The game's own [SYSTEM] confirmations keep the list current. Only
      // system lines count, so a player quoting them can't change anything.
      const SPEAK_RE = /You will now speak in ([A-Za-z][A-Za-z ']*?)\./;
      const ENGLISH_RE = /You go back to speaking plain English/;
      const LEARNED_RE = /You have learned ([A-Za-z][A-Za-z ']*?)\./;
      const isSystemLine = m => m.type === 'system' || /\[SYSTEM\]/.test(m.html || '');
      function onGameText(text) {
        let m;
        if (ENGLISH_RE.test(text)) update(d => { d.current = ENGLISH; });
        else if ((m = text.match(SPEAK_RE))) {
          const lang = canonical(m[1]);
          if (lang) update(d => { d.current = lang; if (lang !== ENGLISH && !d.known.includes(lang)) d.known.push(lang); });
        } else if ((m = text.match(LEARNED_RE))) {
          const lang = canonical(m[1]);
          if (lang && lang !== ENGLISH) update(d => { if (!d.known.includes(lang)) d.known.push(lang); });
        }
      }
      const seen = new WeakSet();
      function drain(list) {
        let i = list.length;
        while (i > 0 && !seen.has(list[i - 1].__v_raw || list[i - 1])) i--;
        for (; i < list.length; i++) {
          const m = list[i];
          seen.add(m.__v_raw || m);
          if (m.isHistory || !isSystemLine(m)) continue;
          if (typeof m.text === 'string') onGameText(m.text);
        }
      }
      let hooked = null;
      function syncHook() {
        if (hooked && hooked.inst.isUnmounted) { hooked.stops.forEach(s => s()); hooked = null; }
        if (hooked) return;
        const inst = c.findPlayInstance();
        if (!inst) return;
        const p = inst.proxy;
        const stops = ['messages', 'activityMessages'].map(k => {
          drain(p[k]);
          return p.$watch(() => { const a = p[k]; return a.length ? a[a.length - 1] : null; }, () => drain(p[k]), { flush: 'sync' });
        });
        hooked = { inst, stops };
        refreshBadge();
      }

      function addLinePrefix(lang) {
        const input = c.findCommandInput();
        if (!input) return;
        const tag = `[${cmdName(lang)}]`;
        let v = input.value;
        if (!v.trim()) v = `/say ${tag} `;
        else if (/^\//.test(v)) v = v.replace(/^(\/\S+)\s*(\[[^\]]*\]\s*)?/, `$1 ${tag} `);
        else v = v.replace(/^\s*(\[[^\]]*\]\s*)?/, `${tag} `);
        c.setNativeValue(input, v);
        input.focus();
        try { input.setSelectionRange(v.length, v.length); } catch (e) { /* ignore */ }
      }

      c.addStyle(`
        #pbn-sp-quick .pbn-sp-badge { margin-left: 3px; font: 700 11px/1 Georgia, 'Times New Roman', serif; letter-spacing: .5px; color: #e0b84a; }
        #pbn-sp-quick.pbn-sp-quick--foreign { color: #e0b84a !important; }
        .pbn-sp-row { display: flex; align-items: stretch; }
        .pbn-sp-row .pbn-tk-menu__item { flex: 1; }
        .pbn-sp-once {
          flex: 0 0 auto; padding: 0 14px; border: 0; border-left: 1px solid #5a121266; background: none; cursor: pointer;
          font: inherit; font-size: .9rem; color: #9a8a7a;
        }
        .pbn-sp-once:hover { color: #e0b84a; background: #5a121233; }
        .pbn-sp-once:focus-visible { outline: 2px solid #e0b84a; outline-offset: -2px; }
        .pbn-sp-manage { max-height: min(60vh, 460px); overflow-y: auto; padding: 2px 0 4px; }
        .pbn-sp-done {
          margin: 6px 16px 8px; padding: 6px 14px; cursor: pointer; align-self: flex-end; background: #9e2b2b; color: #f3e6cf;
          border: 1px solid #9e2b2b; border-radius: 4px; font: inherit; font-size: .95rem;
        }
        .pbn-sp-done:hover { background: #b33434; }
      `);

      function renderMain(menu) {
        const name = charName();
        const d = charData(loadAll(), name);
        menu.textContent = '';
        menu.append(c.el('div', { className: 'pbn-tk-menu__head', textContent: `Speaking — ${name}` }));
        [ENGLISH, ...d.known].forEach(lang => {
          const isCur = d.current === lang;
          const item = c.el('button', {
            type: 'button', className: 'pbn-tk-menu__item' + (isCur ? ' pbn-tk-menu__item--current' : ''),
            title: lang === ENGLISH ? 'Go back to plain English' : `Speak ${lang} until you change it`,
          }, c.el('span', { className: 'pbn-tk-menu__check', textContent: isCur ? '✓' : '' }), lang);
          item.setAttribute('role', 'menuitem');
          // Current language changes on the game's confirmation, not here.
          item.addEventListener('click', () => { currentPop?.close(); c.sendCommand(`/speak ${cmdName(lang)}`); });
          const row = c.el('div', { className: 'pbn-sp-row' }, item);
          if (lang !== ENGLISH) {
            const once = c.el('button', { type: 'button', className: 'pbn-sp-once', textContent: '1×', title: `Next line only: add [${cmdName(lang)}] to the line you're typing` });
            once.setAttribute('aria-label', `${lang} for the next line only`);
            once.addEventListener('click', () => { currentPop?.close(); addLinePrefix(lang); });
            row.append(once);
          }
          menu.append(row);
        });
        if (!d.known.length) menu.append(c.el('div', { className: 'pbn-tk-menu__note', textContent: `No languages saved for ${name} yet. Add the ones you've claimed with /speak learn below.` }));
        const manage = c.el('button', { type: 'button', className: 'pbn-tk-menu__item' }, c.el('span', { className: 'pbn-tk-menu__check' }), 'Manage languages…');
        manage.addEventListener('click', () => { renderManage(menu); currentPop?.place(); });
        menu.append(c.el('div', { className: 'pbn-tk-menu__sep' }), manage);
      }
      function renderManage(menu) {
        const name = charName();
        const d = charData(loadAll(), name);
        menu.textContent = '';
        menu.append(
          c.el('div', { className: 'pbn-tk-menu__head', textContent: `Languages — ${name}` }),
          c.el('div', { className: 'pbn-tk-menu__note', textContent: `Tick the languages ${name} has claimed with /speak learn. The game can't list them, so this list is kept here.` }));
        const list = c.el('div', { className: 'pbn-sp-manage' });
        CATALOG.forEach(([lang]) => {
          const box = c.el('input', { type: 'checkbox', checked: d.known.includes(lang) });
          box.addEventListener('change', () => update(x => {
            if (box.checked) { if (!x.known.includes(lang)) x.known.push(lang); }
            else { x.known = x.known.filter(k => k !== lang); if (x.current === lang) x.current = ENGLISH; }
          }));
          list.append(c.el('label', { className: 'pbn-tk-menu__check' }, box, lang));
        });
        const done = c.el('button', { type: 'button', className: 'pbn-sp-done', textContent: 'Done' });
        done.addEventListener('click', () => { renderMain(menu); currentPop?.place(); menu.querySelector('.pbn-tk-menu__item')?.focus(); });
        menu.append(list, done);
        list.querySelector('input')?.focus();
      }

      function refreshBadge() {
        const btn = document.getElementById('pbn-sp-quick');
        if (!btn) return;
        const cur = charData(loadAll(), charName()).current;
        const foreign = cur !== ENGLISH;
        btn.classList.toggle('pbn-sp-quick--foreign', foreign);
        const badge = btn.querySelector('.pbn-sp-badge');
        const text = foreign ? cur.slice(0, 3).toUpperCase() : '';
        if (badge && badge.textContent !== text) badge.textContent = text;
        const title = `Language: speaking ${cur}`;
        if (btn.title !== title) btn.title = title;
      }

      function ensureQuickButton() {
        if (document.getElementById('pbn-sp-quick')) return;
        const btn = makeIconButton('pbn-sp-quick', 'translate', 'Language');
        if (!btn) return;
        btn.querySelector('.q-btn__content').append(c.el('span', { className: 'pbn-sp-badge' }));
        // Leftmost of the toolkit's icons.
        const presets = document.getElementById('pbn-dp-quick');
        if (presets) presets.before(btn);
        btn.addEventListener('click', () => {
          const pop = c.togglePopover(btn, () => {
            const menu = c.el('div', { className: 'pbn-tk-menu' });
            menu.setAttribute('role', 'menu');
            renderMain(menu);
            return menu;
          }, { above: true });
          pop?.menu.querySelector('.pbn-tk-menu__item')?.focus();
        });
        refreshBadge();
      }

      let tick = null;
      c.onRoute(c.isPlay, () => {
        const run = () => { ensureQuickButton(); syncHook(); };
        run();
        tick = setInterval(run, 1000);
      }, () => {
        clearInterval(tick);
        if (hooked) { hooked.stops.forEach(s => s()); hooked = null; }
      });
    },
  });

  // ==========================================================================
  // MODULE: Personal Names
  // ==========================================================================

  // Set while Personal Names runs; Chat Log asks it whether (and how) to put
  // your names into a saved log.
  let namesApi = null;

  defineModule({
    id: 'names',
    name: 'Personal Names, Notes & Dossiers',
    description: "Click a name or short desc in the chat for that person's dossier: your own name for them, your notes (Markdown) and their last /look. Exact matches only, kept per character.",
    note: "Your names get a dotted gold underline and a ✦, people you only have notes on a grey dotted underline. The badge icon by the command box flips between your names and the game's text; right-click it to find anyone you've named or noted.",
    settings: [
      { key: 'cards', label: 'Dossiers: clicking a name opens their dossier window (right-click for the quick menu)', type: 'toggle', default: true },
      { key: 'autoOpen', label: 'Open the dossier when you /look at someone', type: 'toggle', default: true },
      { key: 'fold', label: 'Fold /look descriptions in the chat into one line', type: 'toggle', default: true },
      { key: 'log', label: 'Save Log writes', type: 'select', default: 'game',
        options: [['game', "the game's text"], ['mine', 'my names']] },
    ],
    actions: [{ label: 'People & notes…', run: () => namesApi?.openList() }],
    start(c) {
      // { [character]: { [personId]: { looks: [game text…], name, was[], off, notes? } } }
      // A person can have several looks (short descs, or their real name once
      // the game shows it); the name and notes belong to the person.
      const KEY = 'pbn-names';
      const VIEW_KEY = 'pbn-names-view'; // 'mine' | 'game'
      const MAX_WAS = 5;
      const CHAT = '.chat-container';
      const ROW = '[role="article"]';
      const NM = 'pbn-nm';
      const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
      const keyOf = s => norm(s).toLowerCase();
      const loadAll = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } };
      const loadView = () => (localStorage.getItem(VIEW_KEY) === 'game' ? 'game' : 'mine');
      const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      // 1.1/1.2 stored one entry per game text, keyed by it; each becomes a
      // person with a single look.
      function migrate(b) {
        for (const [id, e] of Object.entries(b)) {
          if (!e || Array.isArray(e.looks)) continue;
          b[id] = { looks: [norm(e.orig || id)], name: e.name || '', was: e.was || [], off: !!e.off, ...(e.notes ? { notes: e.notes } : {}) };
        }
        return b;
      }
      const findId = (b, orig) => Object.keys(b).find(id => b[id].looks.some(l => keyOf(l) === keyOf(orig)));
      const uniqLooks = looks => looks.filter((l, i, a) => a.findIndex(x => keyOf(x) === keyOf(l)) === i);

      let book = {}, index = new Map(), bookChar = null, view = loadView();
      function reindex() {
        index = new Map();
        for (const [id, person] of Object.entries(book)) for (const l of person.looks) index.set(keyOf(l), id);
      }
      const personOf = orig => book[index.get(keyOf(orig))] || null;
      function loadBook() { bookChar = c.getCharName() || 'default'; book = migrate(loadAll()[bookChar] || {}); reindex(); }
      function write(all, b) {
        for (const [id, person] of Object.entries(b)) if (!person.looks.length || (!person.name && !person.notes)) delete b[id];
        if (Object.keys(b).length) all[bookChar] = b; else delete all[bookChar];
        localStorage.setItem(KEY, JSON.stringify(all));
        book = b;
        reindex();
      }
      function update(fn) {
        const all = loadAll();
        const b = migrate(all[bookChar] || {});
        fn(b);
        write(all, b);
        refreshAll();
      }
      const pastNames = (names, except) => names.filter(w => w && w !== except).filter((w, i, a) => a.indexOf(w) === i).slice(0, MAX_WAS);
      // Clearing the name keeps the person if there are notes on them.
      function setName(orig, name) {
        name = norm(name);
        update(b => {
          const id = findId(b, orig), person = id && b[id];
          if (!person) { if (name) b[newId()] = { looks: [norm(orig)], name, was: [], off: false }; return; }
          if (person.name === name) { person.off = false; return; }
          person.was = pastNames([person.name, ...(person.was || [])], name);
          person.name = name;
          person.off = false;
        });
      }
      // Called on every keystroke; the chat is only re-rendered when someone
      // gains or loses notes (that changes their marker).
      function saveNotes(orig, text) {
        const all = loadAll();
        const b = migrate(all[bookChar] || {});
        let id = findId(b, orig);
        const had = !!(id && b[id].notes);
        if (text.trim()) {
          if (!id) b[id = newId()] = { looks: [norm(orig)], name: '', was: [], off: false };
          b[id].notes = text;
        } else if (id) delete b[id].notes;
        write(all, b);
        if (had !== !!text.trim()) refreshAll();
      }
      // "Same person as…": this look joins the target. If it already belonged
      // to someone, the two are merged: notes appended, names kept in "was".
      function linkTo(orig, targetId) {
        update(b => {
          const target = b[targetId];
          const srcId = findId(b, orig);
          if (!target || srcId === targetId) return;
          if (!srcId) { target.looks.push(norm(orig)); return; }
          const src = b[srcId];
          target.looks = uniqLooks([...target.looks, ...src.looks]);
          if (src.notes) target.notes = target.notes ? target.notes + '\n\n---\n\n' + src.notes : src.notes;
          if (!target.name && src.name) target.name = src.name;
          target.was = pastNames([...(target.was || []), src.name, ...(src.was || [])], target.name);
          delete b[srcId];
        });
      }
      // "Not them": this look leaves its person and is a stranger again.
      function detach(orig) {
        update(b => {
          const person = b[findId(b, orig)];
          if (person && person.looks.length > 1) person.looks = person.looks.filter(l => keyOf(l) !== keyOf(orig));
        });
      }
      function toggleView() {
        view = view === 'mine' ? 'game' : 'mine';
        localStorage.setItem(VIEW_KEY, view);
        refreshAll();
      }

      // Small, safe Markdown for notes: everything is escaped first, then
      // headings, lists, quotes, rules, **bold**, *italic*, ~~strike~~,
      // `code` and [links](https://…) are turned into tags.
      function markdown(src) {
        const esc = s => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
        const inline = s => esc(s)
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
          .replace(/(^|[\s(])_(?!\s)(.+?)_(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>')
          .replace(/~~(.+?)~~/g, '<del>$1</del>')
          .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        const out = [];
        let para = [], list = null;
        const flushPara = () => { if (para.length) out.push(`<p>${para.join('<br>')}</p>`); para = []; };
        const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${i}</li>`).join('')}</${list.tag}>`); list = null; };
        for (const line of String(src).split(/\r?\n/)) {
          let m;
          if (!line.trim()) { flushPara(); flushList(); }
          else if ((m = line.match(/^\s*(#{1,3})\s+(.*)$/))) { flushPara(); flushList(); out.push(`<h${m[1].length + 3}>${inline(m[2])}</h${m[1].length + 3}>`); }
          else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); }
          else if ((m = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/))) {
            const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
            flushPara();
            if (list && list.tag !== tag) flushList();
            (list || (list = { tag, items: [] })).items.push(inline(m[2]));
          } else if ((m = line.match(/^\s*>\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
          else { flushList(); para.push(inline(line)); }
        }
        flushPara(); flushList();
        return out.join('');
      }
      function toggleView() {
        view = view === 'mine' ? 'game' : 'mine';
        localStorage.setItem(VIEW_KEY, view);
        refreshAll();
      }

      // ---- Finding names. Only places the game puts a name are touched, never
      // what people say. Each one is wrapped in <span class="pbn-nm"
      // data-pbn-nm-orig="game text">, which is then shown as the game text or
      // your name. Short descs can carry colour spans (A <span>tired man</span>
      // wearing…), so a name is a run of nodes, read as one whitespace-collapsed
      // string with a position map back into the DOM.
      const OBJ = '￼'; // stands in for an already-wrapped name
      function mapText(nodes) {
        let text = '';
        const pos = [];
        const add = (ch, at) => {
          if (ch === ' ' && (!text || text.endsWith(' '))) return;
          text += ch;
          pos.push(at);
        };
        const walk = n => {
          if (n.nodeType === 3) {
            const t = n.nodeValue;
            for (let i = 0; i < t.length; i++) add(/\s/.test(t[i]) ? ' ' : t[i], [n, i]);
          } else if (n.nodeType === 1) {
            if (n.classList.contains(NM)) add(OBJ, null);
            else if (n.getAttribute('role') !== 'img') n.childNodes.forEach(walk); // 🥀 new-player marker etc.
          }
        };
        nodes.forEach(walk);
        return { text, pos, root: nodes[0]?.parentNode };
      }
      const runUntil = (first, stop) => {
        const nodes = [];
        for (let n = first; n && !(n.nodeType === 1 && stop.test(n.tagName)); n = n.nextSibling) nodes.push(n);
        return nodes;
      };
      // Wraps text[s, e) of a mapped run. Several wraps in one run must go
      // last-to-first so earlier positions stay valid.
      function wrapAt(map, s, e) {
        while (s < e && map.text[s] === ' ') s++;
        while (e > s && map.text[e - 1] === ' ') e--;
        const orig = map.text.slice(s, e);
        if (!orig || orig.includes(OBJ)) return;
        const [sn, so] = map.pos[s], [en, eo] = map.pos[e - 1];
        const doc = sn.ownerDocument;
        const r = doc.createRange();
        // A name starting/ending at the edge of a colour span takes the whole
        // span, so splitting doesn't leave an empty copy of it behind.
        const root = map.root;
        let a = sn, b = en;
        if (so === 0) { while (a.parentNode !== root && a === a.parentNode.firstChild) a = a.parentNode; r.setStartBefore(a); }
        else r.setStart(sn, so);
        if (eo + 1 === en.nodeValue.length) { while (b.parentNode !== root && b === b.parentNode.lastChild) b = b.parentNode; r.setEndAfter(b); }
        else r.setEnd(en, eo + 1);
        const span = doc.createElement('span');
        span.className = NM;
        span.dataset.pbnNmOrig = orig;
        span.append(r.extractContents());
        if (span.children.length) span.dataset.pbnNmHtml = span.innerHTML; // keeps the game's colours for switching back
        r.insertNode(span);
      }
      const NAME_END = /[\s,.!?;:'’]/;
      function savedKeyAt(low, at, keys) {
        return keys.find(k => low.startsWith(k, at) && (low.length === at + k.length || NAME_END.test(low[at + k.length])));
      }
      function process(root) {
        const keys = [...index.keys()].sort((a, b) => b.length - a.length);
        // Speakers: <span class="chat-name-…">Name</span>, "Name Rolls..." on roll cards.
        root.querySelectorAll('[class*="chat-name"]').forEach(n => {
          const map = mapText(Array.from(n.childNodes));
          const roll = map.text.match(/^(.*?) ?Rolls\.\.\. ?$/);
          wrapAt(map, 0, roll ? roll[1].length : map.text.length);
        });
        // [SYSTEM] lines: "X arrives…", "X heads south", "X looks at Y." Where a
        // desc ends can't be told there, so only saved names match.
        if (keys.length) root.querySelectorAll('p > span.text-orange-9:first-child').forEach(label => {
          if (label.textContent.trim() !== '[SYSTEM]') return;
          const map = mapText(runUntil(label.nextSibling, /^(BR|DIV)$/));
          const low = map.text.toLowerCase();
          const spans = [];
          const k = savedKeyAt(low, 0, keys);
          if (k) spans.push([0, k.length]);
          const at = low.match(/ looks at (.+?)\.$/);
          if (at && index.has(at[1])) { const end = at.index + at[0].length - 1; spans.push([end - at[1].length, end]); }
          spans.sort((a, b) => b[0] - a[0]).forEach(([s, e]) => wrapAt(map, s, e));
        });
        // look output: "• Name <em>(breathing)</em>", "You look at Name <em>…" /
        // "<br>", and <em>Among them, Name.</em> when peering into a room.
        root.querySelectorAll('p.look-output').forEach(p => {
          for (const node of Array.from(p.childNodes)) {
            if (node.nodeType !== 3) continue;
            const lead = node.nodeValue.match(/^\s*(•|You look at)\s/);
            if (!lead) continue;
            const map = mapText(runUntil(node, /^(EM|BR|DIV|STRONG)$/));
            wrapAt(map, map.text.indexOf(lead[1]) + lead[1].length, map.text.length);
          }
          p.querySelectorAll(':scope > em').forEach(em => {
            const map = mapText(Array.from(em.childNodes));
            const m = map.text.match(/^(Among them, )(.+?)\.?$/);
            if (m && index.has(keyOf(m[2]))) wrapAt(map, m[1].length, m[1].length + m[2].length);
          });
        });
      }
      function render(span, forLog = false) {
        const orig = span.dataset.pbnNmOrig;
        const e = personOf(orig);
        const mine = !!e?.name && (forLog || (view === 'mine' && !e.off));
        const html = span.dataset.pbnNmHtml;
        if (mine || !html) {
          const text = mine ? e.name : orig;
          if (span.textContent !== text || span.children.length) span.textContent = text;
        } else if (span.innerHTML !== html) span.innerHTML = html;
        if (forLog) return;
        const notes = !!e?.notes;
        span.classList.toggle(`${NM}--mine`, mine);
        span.classList.toggle(`${NM}--noted`, notes && !mine && view === 'mine');
        span.title = (mine ? `Your name for them. The game shows: ${orig}`
          : e?.name ? `You call them ${e.name} (showing the game's text)`
          : notes ? 'You have notes on them' : 'Click to name them or take notes')
          + (notes ? ' · click to read your notes' : '');
      }

      // Typing indicator ("X is typing", "X and Y are typing"). Vue replaces
      // the whole text when it changes, so swapping it doesn't confuse Vue;
      // the game's version is kept to tell its updates apart from ours.
      function syncTyping() {
        const el = document.querySelector('.typing-indicator .typing-text');
        if (!el) return;
        const cur = el.textContent;
        if (el.dataset.pbnNmGame === undefined || cur !== el.dataset.pbnNmShown) el.dataset.pbnNmGame = cur;
        const game = el.dataset.pbnNmGame;
        const swap = who => { const e = personOf(who); return e?.name && view === 'mine' && !e.off ? e.name : who; };
        let out = game;
        const m = game.match(/^(.+?) (is|are) typing(.*)$/);
        if (m) {
          let who = swap(m[1]);
          const and = m[1].lastIndexOf(' and ');
          if (who === m[1] && and > 0) who = `${swap(m[1].slice(0, and))} and ${swap(m[1].slice(and + 5))}`;
          out = `${who} ${m[2]} typing${m[3]}`;
        }
        el.dataset.pbnNmShown = out;
        if (cur !== out) el.textContent = out;
      }
      function processRow(row, live = false) {
        process(row);
        row.querySelectorAll('.' + NM).forEach(s => render(s));
        dossierScan(row, live);
      }

      // ---- Keeping the chat current. Observer callbacks run before paint, so
      // a new line never flashes the game text first.
      let observer = null, container = null;
      function refreshAll() {
        const cont = document.querySelector(CHAT);
        if (cont) processRow(cont);
        syncTyping();
        refreshButton();
        renderDossier(false);
      }
      let typingObserver = null, column = null;
      function syncColumn() {
        const col = document.querySelector(CHAT)?.parentElement;
        if (!col || col === column) return;
        if (typingObserver) typingObserver.disconnect();
        column = col;
        typingObserver = new MutationObserver(syncTyping);
        typingObserver.observe(col, { childList: true, subtree: true, characterData: true });
        syncTyping();
      }
      function syncContainer() {
        syncColumn();
        const cont = document.querySelector(CHAT);
        if (!cont || cont === container) return;
        if (observer) observer.disconnect();
        container = cont;
        processRow(cont);
        observer = new MutationObserver(ms => {
          const rows = new Set();
          for (const m of ms) for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            const row = n.closest(ROW);
            if (row) rows.add(row); else n.querySelectorAll(ROW).forEach(r => rows.add(r));
          }
          rows.forEach(r => processRow(r, true)); // re-runs on our own spans find nothing new, so this settles
        });
        observer.observe(cont, { childList: true, subtree: true });
      }

      c.addStyle(`
        .${NM} { cursor: pointer; border-radius: 2px; }
        .${NM}:hover { background: #e0b84a24; }
        .${NM}--mine { text-decoration: underline dotted #e0b84acc; text-decoration-thickness: 1px; text-underline-offset: 3px; }
        .${NM}--mine::after {
          content: '✦'; display: inline-block; margin-left: 2px; font-size: .7em; line-height: 0; vertical-align: super;
          color: #e0b84a; font-style: normal; font-weight: normal; text-decoration: none;
        }
        #pbn-nm-quick.pbn-nm-quick--on { color: #e0b84a !important; }
        .pbn-nm-orig { padding: 0 16px 8px; color: #e8ddd0; font-size: 1rem; font-style: italic; line-height: 1.35; overflow-wrap: anywhere; }
        .pbn-nm-form { display: flex; gap: 6px; padding: 2px 16px 8px; }
        .pbn-nm-input {
          flex: 1; min-width: 0; padding: 6px 9px; background: #0d0707; color: #e8ddd0; border: 1px solid #5a1212; border-radius: 4px;
          font: inherit; font-size: 1rem;
        }
        .pbn-nm-input:focus { outline: none; border-color: #e0b84a; }
        .pbn-nm-save {
          flex: 0 0 auto; padding: 5px 14px; cursor: pointer; background: #9e2b2b; color: #f3e6cf; border: 1px solid #9e2b2b; border-radius: 4px;
          font: inherit; font-size: .95rem;
        }
        .pbn-nm-save:hover { background: #b33434; }
        .pbn-nm-list { max-height: min(55vh, 420px); overflow-y: auto; }
        .pbn-nm-list .pbn-tk-menu__item { flex-direction: column; align-items: flex-start; gap: 1px; }
        .pbn-nm-list__orig { color: #9a8a7a; font-size: .9rem; font-style: italic; }
        .pbn-nm-menu .pbn-nm-forget:hover:not(:disabled) { color: #e07062; }
        .${NM}--noted { text-decoration: underline dotted #9a8a7a; text-decoration-thickness: 1px; text-underline-offset: 3px; }
        .pbn-tk-menu.pbn-nm-menu { width: min(460px, 94vw); max-width: none; max-height: calc(100vh - 16px); overflow-y: auto; }
        .pbn-nm-notes {
          margin: 0 16px 8px; padding: 8px 12px; max-height: 38vh; overflow-y: auto; cursor: text;
          background: #0d0707; border: 1px solid #5a121266; border-radius: 4px;
          color: #e8ddd0; font-size: 1rem; line-height: 1.45; overflow-wrap: anywhere;
        }
        .pbn-nm-notes:hover { border-color: #5a1212; }
        .pbn-nm-notes--empty { color: #9a8a7a; font-style: italic; }
        .pbn-nm-notes > :first-child { margin-top: 0; }
        .pbn-nm-notes > :last-child { margin-bottom: 0; }
        .pbn-nm-notes p, .pbn-nm-notes ul, .pbn-nm-notes ol, .pbn-nm-notes blockquote { margin: 0 0 .6em; }
        .pbn-nm-notes ul, .pbn-nm-notes ol { padding-left: 1.4em; }
        .pbn-nm-notes h4, .pbn-nm-notes h5, .pbn-nm-notes h6 { margin: .2em 0 .4em; color: #f3e6cf; font-weight: bold; line-height: 1.3; }
        .pbn-nm-notes h4 { font-size: 1.2rem; } .pbn-nm-notes h5 { font-size: 1.08rem; } .pbn-nm-notes h6 { font-size: 1rem; }
        .pbn-nm-notes blockquote { padding-left: 10px; border-left: 3px solid #5a1212; color: #c4b49a; font-style: italic; }
        .pbn-nm-notes code { padding: 0 4px; background: #5a121240; border-radius: 3px; font-family: 'Courier New', monospace; font-size: .95em; }
        .pbn-nm-notes hr { border: 0; border-top: 1px solid #5a1212; margin: .6em 0; }
        .pbn-nm-notes a { color: #e0b84a; }
        .pbn-nm-notes strong { color: #f3e6cf; }
        .pbn-nm-notes-edit {
          display: block; width: calc(100% - 32px); box-sizing: border-box; margin: 0 16px 6px; min-height: 180px; resize: vertical; padding: 8px 10px;
          background: #0d0707; color: #e8ddd0; border: 1px solid #5a1212; border-radius: 4px;
          font: 1rem/1.45 Georgia, 'Times New Roman', serif;
        }
        .pbn-nm-notes-edit:focus { outline: none; border-color: #e0b84a; }
        .pbn-nm-notes-bar { display: flex; align-items: center; gap: 10px; padding: 0 16px 8px; }
        .pbn-nm-notes-hint { flex: 1; color: #9a8a7a; font-size: .9rem; font-style: italic; line-height: 1.35; }
        .pbn-nm-filter { display: block; width: calc(100% - 32px); box-sizing: border-box; margin: 2px 16px 6px; }
        .pbn-nm-list__mark { color: #9a8a7a; font-size: .9rem; }
        .pbn-nm-look { display: flex; align-items: center; gap: 8px; padding: 2px 8px 2px 16px; color: #c4b49a; font-style: italic; line-height: 1.35; }
        .pbn-nm-look span { flex: 1; overflow-wrap: anywhere; }
        .pbn-nm-look button {
          flex: 0 0 auto; padding: 4px 9px; border: 0; border-radius: 4px; background: none; cursor: pointer;
          color: #9a8a7a; font: inherit; font-style: normal; font-size: .95rem;
        }
        .pbn-nm-look button:hover { color: #e07062; background: #5a121233; }
      `);

      // ---- Menus
      function item(label, fn, cls = '') {
        const b = c.el('button', { type: 'button', className: `pbn-tk-menu__item ${cls}`, textContent: label });
        b.setAttribute('role', 'menuitem');
        b.addEventListener('click', fn);
        return b;
      }
      const sep = () => c.el('div', { className: 'pbn-tk-menu__sep' });
      const close = () => currentPop?.close();

      // Notes: shown rendered; clicking them (or "Write notes") switches to a
      // textarea that saves on every keystroke, so closing never loses text.
      function notesSection(menu, orig) {
        const box = c.el('div');
        const showView = () => {
          const notes = personOf(orig)?.notes || '';
          box.textContent = '';
          if (!notes) {
            box.append(item('✎ Write notes…', showEdit));
            return;
          }
          const shown = c.el('div', { className: 'pbn-nm-notes', title: 'Click to edit' });
          shown.innerHTML = markdown(notes);
          shown.addEventListener('click', ev => { if (!ev.target.closest('a')) showEdit(); });
          box.append(shown);
        };
        const showEdit = () => {
          const ta = c.el('textarea', { className: 'pbn-nm-notes-edit', value: personOf(orig)?.notes || '', spellcheck: true,
            placeholder: 'Who they are, where you met, what they want, what they owe you…' });
          ta.setAttribute('aria-label', 'Notes');
          ta.addEventListener('input', () => saveNotes(orig, ta.value));
          const done = c.el('button', { type: 'button', className: 'pbn-nm-save', textContent: 'Done' });
          const finish = () => { showView(); currentPop?.place(); };
          done.addEventListener('click', finish);
          ta.addEventListener('keydown', ev => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); finish(); } });
          box.textContent = '';
          box.append(ta, c.el('div', { className: 'pbn-nm-notes-bar' },
            c.el('span', { className: 'pbn-nm-notes-hint', textContent: 'Saved as you type. Markdown: **bold**, *italic*, # heading, - list, > quote, [link](https://…)' }),
            done));
          currentPop?.place();
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        };
        showView();
        menu.append(c.el('div', { className: 'pbn-tk-menu__head', textContent: 'Notes' }), box);
      }

      function renderEditor(menu, orig, fromList) {
        const e = personOf(orig);
        const again = () => { renderEditor(menu, orig, fromList); currentPop?.place(); };
        menu.textContent = '';
        const input = c.el('input', { type: 'text', className: 'pbn-nm-input', value: e?.name || '', placeholder: 'Your name for them…', spellcheck: false });
        input.setAttribute('aria-label', 'Your name for them');
        const save = c.el('button', { type: 'button', className: 'pbn-nm-save', textContent: 'Save' });
        const commit = () => { setName(orig, input.value); close(); };
        save.addEventListener('click', commit);
        input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); commit(); } });
        menu.append(
          c.el('div', { className: 'pbn-tk-menu__head', textContent: 'The game shows' }),
          c.el('div', { className: 'pbn-nm-orig', textContent: orig }));
        const others = (e?.looks || []).filter(l => keyOf(l) !== keyOf(orig));
        if (others.length) {
          menu.append(c.el('div', { className: 'pbn-tk-menu__head', textContent: 'Also seen as' }));
          others.forEach(l => {
            const x = c.el('button', { type: 'button', textContent: '✕', title: 'Not the same person: split this one off' });
            x.setAttribute('aria-label', 'Split off ' + l);
            x.addEventListener('click', () => { detach(l); again(); });
            menu.append(c.el('div', { className: 'pbn-nm-look' }, c.el('span', { textContent: l }), x));
          });
        }
        menu.append(
          c.el('div', { className: 'pbn-tk-menu__head', textContent: e?.name ? 'You call them' : 'Name this person' }),
          c.el('div', { className: 'pbn-nm-form' }, input, save));
        notesSection(menu, orig);
        menu.append(sep());
        if (CARDS && !menu.closest('#pbn-dossier')) menu.append(item('Open their dossier', () => { close(); openDossier(orig); }));
        const known = Object.values(book).filter(x => x !== e).length;
        const same = item(e ? 'Same person as… (merge with someone you know)' : 'Same person as… (someone you know)', () => {
          renderList(menu, { pickFor: orig, back: again });
          currentPop?.place();
        });
        same.disabled = !known;
        if (!known) same.title = 'You have nobody else saved yet';
        menu.append(same);
        if (others.length) menu.append(item('Not them: split “' + orig + '” off', () => { detach(orig); again(); }));
        if (e) {
          (e.was || []).forEach(w => menu.append(item('↺ Back to “' + w + '”', () => { setName(orig, w); close(); })));
          if (e.name) menu.append(item(e.off ? 'Show my name for them again' : "Show the game's text for them", () => {
            update(b => { const x = b[findId(b, orig)]; if (x) x.off = !x.off; });
            close();
          }));
          menu.append(item('Forget this person', () => {
            if (personOf(orig)?.notes && !confirm('Delete your name and notes for “' + (e.name || orig) + '”? This can\'t be undone.')) return;
            update(b => { delete b[findId(b, orig)]; });
            close();
          }, 'pbn-nm-forget'));
        }
        if (fromList) menu.append(sep(), item('‹ Everyone', () => { renderList(menu); currentPop?.place(); }));
        menu.append(c.el('div', { className: 'pbn-tk-menu__note', textContent: 'Saved for ' + bookChar + ' only. It matches this exact text; if they turn up with a new desc or name, click that one and use “Same person as…”.' }));
        if (!e?.notes || e.name) setTimeout(() => { input.focus(); input.select(); }, 0);
      }
      // Everyone saved for this character, searchable. With pickFor it's the
      // "Same person as…" chooser for that look.
      function renderList(menu, { pickFor = null, back = null } = {}) {
        menu.textContent = '';
        const self = pickFor ? personOf(pickFor) : null;
        menu.append(c.el('div', { className: 'pbn-tk-menu__head', textContent: pickFor ? 'Who is this?' : 'People — ' + bookChar }));
        if (pickFor) menu.append(c.el('div', { className: 'pbn-nm-orig', textContent: pickFor }));
        const entries = Object.entries(book).filter(([, x]) => x !== self)
          .sort(([, a], [, b]) => (a.name || a.looks[0]).localeCompare(b.name || b.looks[0]));
        if (!entries.length) {
          menu.append(c.el('div', { className: 'pbn-tk-menu__note', textContent: 'Nobody yet. Click a name or short desc in the chat to name that person or take notes on them.' }));
        } else {
          const filter = c.el('input', { type: 'text', className: 'pbn-nm-input pbn-nm-filter', placeholder: 'Find someone (name, desc or notes)…', spellcheck: false });
          filter.setAttribute('aria-label', 'Find someone');
          const list = c.el('div', { className: 'pbn-nm-list' });
          const rows = entries.map(([id, x]) => {
            const marks = [x.notes ? '✎ notes' : '', x.off ? 'showing game text' : ''].filter(Boolean).join(' · ');
            const looks = x.name ? x.looks : x.looks.slice(1);
            const b = c.el('button', { type: 'button', className: 'pbn-tk-menu__item' },
              c.el('span', { textContent: x.name || x.looks[0] }, marks ? c.el('span', { className: 'pbn-nm-list__mark', textContent: '  ' + marks }) : null),
              looks.length ? c.el('span', { className: 'pbn-nm-list__orig', textContent: looks.join(' · ') }) : null);
            b.addEventListener('click', () => {
              if (pickFor) { linkTo(pickFor, id); back(); }
              else if (CARDS) { close(); openDossier(x.looks[0]); }
              else { renderEditor(menu, x.looks[0], true); currentPop?.place(); }
            });
            list.append(b);
            return [b, [x.name, ...x.looks, ...(x.was || []), x.notes || ''].join(' ').toLowerCase()];
          });
          filter.addEventListener('input', () => {
            const q = filter.value.trim().toLowerCase();
            rows.forEach(([b, text]) => { b.style.display = !q || text.includes(q) ? '' : 'none'; });
          });
          filter.addEventListener('keydown', ev => {
            if (ev.key !== 'Enter') return;
            ev.preventDefault();
            rows.find(([b]) => b.style.display !== 'none')?.[0].click();
          });
          menu.append(filter, list);
          setTimeout(() => filter.focus(), 0);
        }
        if (pickFor) {
          if (self && (self.name || self.notes)) menu.append(c.el('div', { className: 'pbn-tk-menu__note', textContent: 'Your name and notes for this one are merged into theirs.' }));
          menu.append(sep(), item('‹ Back', back));
        } else {
          menu.append(sep(), item(view === 'mine' ? "Show the game's text everywhere" : 'Show my names again', () => { toggleView(); close(); }));
        }
      }
      function newMenu() {
        const menu = c.el('div', { className: 'pbn-tk-menu pbn-nm-menu' });
        menu.setAttribute('role', 'menu');
        return menu;
      }
      function openEditor(trigger, orig) {
        const menu = newMenu();
        renderEditor(menu, orig, false);
        c.openPopover(trigger, menu);
      }
      function openList() {
        const btn = document.getElementById('pbn-nm-quick');
        if (!btn) { alert('Your names are listed from the play page (the badge icon by the command box).'); return; }
        const menu = newMenu();
        renderList(menu);
        c.openPopover(btn, menu, { above: true });
        if (!menu.querySelector('.pbn-nm-filter')) menu.querySelector('.pbn-tk-menu__item')?.focus();
      }

      function onChatClick(e) {
        const span = e.target.closest?.(`${CHAT} .${NM}`);
        if (!span || !window.getSelection()?.isCollapsed) return; // let text selection through
        e.preventDefault();
        e.stopPropagation();
        if (CARDS && !e.altKey && !e.shiftKey) openDossier(span.dataset.pbnNmOrig);
        else openEditor(span, span.dataset.pbnNmOrig);
      }
      function onChatContext(e) {
        const span = e.target.closest?.(`${CHAT} .${NM}`);
        if (!span || !CARDS) return;
        e.preventDefault();
        openEditor(span, span.dataset.pbnNmOrig);
      }

      // ---- Toolbar badge: click flips your names / the game's text,
      // right-click lists the names.
      function refreshButton() {
        const btn = document.getElementById('pbn-nm-quick');
        if (!btn) return;
        const n = Object.values(book).filter(e => e.name).length;
        const mine = view === 'mine';
        btn.classList.toggle('pbn-nm-quick--on', mine && n > 0);
        btn.setAttribute('aria-pressed', String(mine));
        const title = mine
          ? `Showing your names (${n} for ${bookChar}). Click to show the game's text; right-click for everyone you've named or noted.`
          : "Showing the game's text. Click to show your names again; right-click for everyone you've named or noted.";
        if (btn.title !== title) btn.title = title;
      }
      function ensureButton() {
        if (document.getElementById('pbn-nm-quick')) return;
        const btn = makeIconButton('pbn-nm-quick', 'badge', 'Personal names');
        if (!btn) return;
        btn.removeAttribute('aria-haspopup');
        btn.removeAttribute('aria-expanded');
        btn.addEventListener('click', () => { close(); toggleView(); });
        btn.addEventListener('contextmenu', e => { e.preventDefault(); openList(); });
        refreshButton();
      }

      function onStorage(e) {
        if (e.key !== KEY && e.key !== VIEW_KEY) return;
        view = loadView();
        loadBook();
        refreshAll();
      }

      // ---- Dossiers: one floating window with a tab per person: your name and
      // notes for them, plus the last /look you did on them (saved, and
      // replaced by the next one). A /look in the chat folds to one line.
      const CARDS = opt('names', 'cards', true);
      const AUTO_OPEN = CARDS && opt('names', 'autoOpen', true);
      const FOLD = CARDS && opt('names', 'fold', true);
      const DOS_KEY = 'pbn-dossier';         // window: { x, y, w, h, font, size, folded }
      const LOOKS_KEY = 'pbn-dossier-looks'; // { [character]: { [lowercased game text]: { html, sub, at } } }
      const MAX_LOOKS = 200;                 // per character, oldest dropped first
      const loadJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } };
      const dos = Object.assign({ x: null, y: 80, w: 460, h: 560, font: 'sans', size: 16, folded: false }, loadJSON(DOS_KEY, {}));
      const saveDos = () => localStorage.setItem(DOS_KEY, JSON.stringify(dos));
      const tabs = [];                 // look keys, in tab order
      const tabOrig = new Map();       // look key -> game text as shown
      let activeTab = null, win = null, dragAt = 0, looksCache = null;

      const looksAll = () => looksCache || (looksCache = loadJSON(LOOKS_KEY, {}));
      const looksFor = () => looksAll()[bookChar] || {};
      function saveLook(key, data, onlyIfMissing) {
        const all = looksAll();
        const store = all[bookChar] || (all[bookChar] = {});
        if (onlyIfMissing && store[key]) return false;
        store[key] = data;
        const keys = Object.keys(store);
        if (keys.length > MAX_LOOKS) keys.sort((a, b) => store[a].at - store[b].at).slice(0, keys.length - MAX_LOOKS).forEach(k => delete store[k]);
        try { localStorage.setItem(LOOKS_KEY, JSON.stringify(all)); } catch (e) { LOG('names: could not save a look', e); }
        return true;
      }
      // The newest /look among all of a person's appearances.
      function latestLook(orig) {
        const store = looksFor();
        return (personOf(orig)?.looks || [orig]).map(l => store[keyOf(l)] && { ...store[keyOf(l)], as: l })
          .filter(Boolean).sort((a, b) => b.at - a.at)[0] || null;
      }

      // "You look at <name>" rows. /look only ever targets characters (PCs or
      // NPCs), so every one is a person.
      function lookOf(row) {
        const p = row.querySelector(':scope > p.look-output');
        const first = p?.firstChild;
        if (!first || first.nodeType !== 3 || !/^\s*You look at\s*$/.test(first.nodeValue)) return null;
        const span = first.nextSibling;
        if (!span?.classList?.contains(NM)) return null;
        return { p, span, orig: span.dataset.pbnNmOrig, key: keyOf(span.dataset.pbnNmOrig) };
      }
      function extractLook(row) {
        const box = document.createElement('div');
        for (const n of row.childNodes) if (!n.classList?.contains('pbn-dos-stub')) box.append(n.cloneNode(true));
        const p = box.querySelector('p.look-output');
        let sub = '';
        // the "You look at <name> <em>(short desc)</em>" line goes; its short desc is kept
        while (p.firstChild && p.firstChild.nodeName !== 'BR') {
          if (p.firstChild.nodeName === 'EM') sub = norm(p.firstChild.textContent).replace(/^\((.*)\)$/, '$1');
          p.firstChild.remove();
        }
        p.firstChild?.remove();
        p.removeAttribute('data-pbn-ts');
        box.querySelectorAll('.' + NM).forEach(sp => {
          if (sp.dataset.pbnNmHtml) sp.outerHTML = sp.dataset.pbnNmHtml; else sp.replaceWith(sp.dataset.pbnNmOrig);
        });
        for (const n of Array.from(box.childNodes)) if (n.nodeName === 'BR' || (n.nodeType === 3 && !n.nodeValue.trim())) n.remove();
        box.querySelectorAll('p').forEach(el => {
          while (el.lastChild && (el.lastChild.nodeName === 'BR' || (el.lastChild.nodeType === 3 && !el.lastChild.nodeValue.trim()))) el.lastChild.remove();
          if (!el.childNodes.length) el.remove();
        });
        return { html: box.innerHTML.trim(), sub };
      }
      function fold(row, l) {
        if (row.querySelector(':scope > .pbn-dos-stub')) return;
        const stub = c.el('p', { className: 'pbn-dos-stub' });
        if (l.p.dataset.pbnTs) stub.dataset.pbnTs = l.p.dataset.pbnTs;
        const open = c.el('button', { type: 'button', className: 'pbn-dos-stub__btn', textContent: 'Dossier', title: 'Open their dossier' });
        open.addEventListener('click', () => openDossier(l.orig));
        const show = c.el('button', { type: 'button', className: 'pbn-dos-stub__btn', textContent: 'Show here', title: 'Unfold this look in the chat' });
        show.addEventListener('click', () => { row.classList.remove('pbn-dos-folded'); stub.remove(); });
        stub.append('You look at ', l.span.cloneNode(true), open, show);
        row.classList.add('pbn-dos-folded');
        row.append(stub);
      }
      // Rows are scanned once. live = arrived just now (not already on the
      // page), so it may replace a saved look and open the dossier.
      function dossierScan(root, live) {
        if (!CARDS) return;
        const rows = root.matches?.(ROW) ? [root] : Array.from(root.querySelectorAll(ROW));
        for (const row of rows) {
          if (row.dataset.pbnDos) continue;
          row.dataset.pbnDos = '1';
          const l = lookOf(row);
          if (!l) continue;
          const saved = saveLook(l.key, { ...extractLook(row), at: Date.now() }, !live);
          if (FOLD) fold(row, l);
          if (live && AUTO_OPEN) openDossier(l.orig, { quiet: true });
          else if (saved) renderDossier(false);
        }
      }

      // Look text is the game's own (already sanitised) HTML; this is a second
      // line of defence before it goes back on the page.
      function cleanHtml(html) {
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        tpl.content.querySelectorAll('script, style, iframe, object, embed, link, meta').forEach(n => n.remove());
        tpl.content.querySelectorAll('*').forEach(n => {
          for (const a of Array.from(n.attributes)) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
        });
        return tpl.content;
      }
      // Bare http(s) URLs (image links in descs) become links; existing links
      // open in a new tab, and anything that isn't http(s) stops being one.
      function linkify(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement?.closest('a') && /https?:\/\//i.test(n.nodeValue)) nodes.push(n);
        for (const n of nodes) {
          const t = n.nodeValue, frag = document.createDocumentFragment();
          let last = 0;
          for (const m of t.matchAll(/https?:\/\/[^\s<>"'\])]*[^\s<>"'\]).,;:!?]/gi)) {
            frag.append(t.slice(last, m.index), c.el('a', { href: m[0], textContent: m[0] }));
            last = m.index + m[0].length;
          }
          frag.append(t.slice(last));
          n.replaceWith(frag);
        }
        root.querySelectorAll('a').forEach(a => {
          if (!/^https?:\/\//i.test(a.getAttribute('href') || '')) { a.removeAttribute('href'); return; }
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        });
      }
      const when = at => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

      function placeDossier() {
        if (!win) return;
        const w = win.offsetWidth;
        const x = Math.min(Math.max(dos.x ?? (window.innerWidth - w - 24), 80 - w), window.innerWidth - 80);
        const y = Math.min(Math.max(dos.y, 0), window.innerHeight - 40);
        win.style.left = x + 'px';
        win.style.top = y + 'px';
      }
      function applyLook() {
        win.classList.toggle('pbn-dos--serif', dos.font === 'serif');
        win.classList.toggle('pbn-dos--folded', !!dos.folded);
        win.style.setProperty('--pbn-dos-size', dos.size + 'px');
        win.style.width = dos.w + 'px';
        win.style.height = dos.folded ? '' : dos.h + 'px';
        const f = win.querySelector('.pbn-dos__fold');
        f.textContent = dos.folded ? '▸' : '▾';
        f.title = dos.folded ? 'Expand' : 'Collapse';
        placeDossier();
      }
      function ensureWin() {
        if (win) return win;
        const tool = (text, title, fn, cls = '') => {
          const b = c.el('button', { type: 'button', className: 'pbn-dos__tool ' + cls, textContent: text, title });
          b.setAttribute('aria-label', title);
          b.addEventListener('click', fn);
          return b;
        };
        const size = d => () => { dos.size = Math.min(26, Math.max(12, dos.size + d)); saveDos(); applyLook(); };
        const tabsBar = c.el('div', { className: 'pbn-dos__tabs' });
        tabsBar.setAttribute('role', 'tablist');
        const head = c.el('div', { className: 'pbn-dos__head', title: 'Drag to move · double-click to collapse' }, tabsBar,
          c.el('div', { className: 'pbn-dos__tools' },
            tool('A−', 'Smaller text', size(-1)),
            tool('A+', 'Larger text', size(1)),
            tool('Aa', 'Switch between sans-serif and serif', () => { dos.font = dos.font === 'serif' ? 'sans' : 'serif'; saveDos(); applyLook(); }),
            tool('▾', 'Collapse', () => { dos.folded = !dos.folded; saveDos(); applyLook(); }, 'pbn-dos__fold'),
            tool('✕', 'Close the dossier window', closeDossier)));
        win = c.el('div', { id: 'pbn-dossier' }, head, c.el('div', { className: 'pbn-dos__body' }));
        win.setAttribute('role', 'dialog');
        win.setAttribute('aria-label', 'Dossiers');
        head.addEventListener('dblclick', e => { if (e.target.closest('button')) return; dos.folded = !dos.folded; saveDos(); applyLook(); });
        // Drag by the header (tabs included, once the pointer has moved a bit).
        head.addEventListener('pointerdown', ev => {
          if (ev.button !== 0 || ev.target.closest('.pbn-dos__tool, .pbn-dos__tab-x')) return;
          const sx = ev.clientX, sy = ev.clientY, r = win.getBoundingClientRect();
          let moved = false;
          const move = e => {
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moved && Math.hypot(dx, dy) < 5) return;
            if (!moved) { moved = true; head.setPointerCapture(ev.pointerId); }
            dos.x = r.left + dx;
            dos.y = r.top + dy;
            placeDossier();
          };
          const up = () => {
            head.removeEventListener('pointermove', move);
            head.removeEventListener('pointerup', up);
            head.removeEventListener('pointercancel', up);
            if (moved) { dragAt = Date.now(); saveDos(); }
          };
          head.addEventListener('pointermove', move);
          head.addEventListener('pointerup', up);
          head.addEventListener('pointercancel', up);
        });
        // Resizing (bottom-right corner) is remembered.
        let resizeT = null;
        new ResizeObserver(() => {
          if (dos.folded || win.hidden) return;
          clearTimeout(resizeT);
          resizeT = setTimeout(() => {
            if (dos.folded || win.hidden) return;
            dos.w = win.offsetWidth;
            dos.h = win.offsetHeight;
            saveDos();
          }, 300);
        }).observe(win);
        document.body.append(win);
        applyLook();
        return win;
      }
      function openDossier(orig, { quiet = false } = {}) {
        orig = norm(orig);
        const k = keyOf(orig);
        const person = personOf(orig);
        let t = tabs.find(x => x === k || (person && personOf(tabOrig.get(x)) === person));
        if (!t) { t = k; tabs.push(k); tabOrig.set(k, orig); }
        activeTab = t;
        ensureWin();
        win.hidden = false;
        if (!quiet && dos.folded) { dos.folded = false; saveDos(); applyLook(); }
        renderDossier(true);
      }
      function closeTab(t) {
        const i = tabs.indexOf(t);
        if (i < 0) return;
        tabs.splice(i, 1);
        if (activeTab === t) activeTab = tabs[Math.min(i, tabs.length - 1)] || null;
        renderDossier(true);
      }
      function closeDossier() {
        tabs.length = 0;
        activeTab = null;
        if (win) { win.hidden = true; win._parts = null; }
      }
      function renderDossier(full) {
        if (!win || win.hidden) return;
        // Tabs that turned out to be the same person ("Same person as…") merge.
        const seen = new Set(), keep = [];
        for (const t of tabs) {
          const id = index.get(t) || 'look:' + t;
          if (seen.has(id)) { if (activeTab === t) activeTab = keep.find(k => (index.get(k) || 'look:' + k) === id); continue; }
          seen.add(id);
          keep.push(t);
        }
        tabs.splice(0, tabs.length, ...keep);
        if (!tabs.length) { closeDossier(); return; }
        if (!tabs.includes(activeTab)) activeTab = tabs[tabs.length - 1];

        const bar = win.querySelector('.pbn-dos__tabs');
        bar.textContent = '';
        for (const t of tabs) {
          const orig = tabOrig.get(t), name = personOf(orig)?.name || orig;
          const b = c.el('button', { type: 'button', className: 'pbn-dos__tab-btn', textContent: name, title: name === orig ? orig : name + ' — ' + orig });
          b.setAttribute('role', 'tab');
          b.setAttribute('aria-selected', String(t === activeTab));
          b.addEventListener('click', () => {
            if (Date.now() - dragAt < 300) return;
            activeTab = t;
            if (dos.folded) { dos.folded = false; saveDos(); applyLook(); }
            renderDossier(true);
          });
          const x = c.el('button', { type: 'button', className: 'pbn-dos__tab-x', textContent: '×', title: 'Close this tab' });
          x.setAttribute('aria-label', 'Close ' + name);
          x.addEventListener('click', () => closeTab(t));
          bar.append(c.el('div', { className: 'pbn-dos__tab' + (t === activeTab ? ' pbn-dos__tab--on' : '') }, b, x));
        }
        bar.querySelector('.pbn-dos__tab--on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

        const body = win.querySelector('.pbn-dos__body');
        const orig = tabOrig.get(activeTab);
        let P = win._parts;
        const sameTab = !full && P && P.tab === activeTab;
        if (!sameTab) {
          body.textContent = '';
          P = win._parts = { tab: activeTab, who: c.el('div'), notes: c.el('div', { className: 'pbn-dos__notes' }), look: c.el('div'), html: null };
          body.append(P.who, P.notes, P.look);
          body.scrollTop = 0;
        }
        // who
        const person = personOf(orig);
        const look = latestLook(orig);
        const looks = person ? person.looks : [orig];
        const edit = c.el('button', { type: 'button', className: 'pbn-dos__btn', textContent: person?.name ? 'Rename · link…' : 'Name · link…',
          title: 'Your name for them, "Same person as…", their other appearances' });
        edit.addEventListener('click', () => openEditor(edit, orig));
        const aliases = person?.name ? looks : looks.filter(l => keyOf(l) !== keyOf(orig));
        P.who.textContent = '';
        P.who.append(...[
          c.el('div', { className: 'pbn-dos__top' }, c.el('div', { className: 'pbn-dos__name', textContent: person?.name || orig }), edit),
          aliases.length ? c.el('div', { className: 'pbn-dos__alias', textContent: (person?.name ? 'Seen as: ' : 'Also seen as: ') + aliases.join(' · ') }) : null,
          look?.sub ? c.el('div', { className: 'pbn-dos__alias', textContent: look.sub }) : null,
        ].filter(Boolean));
        // notes (left alone while you're typing in them)
        if (!sameTab || !P.notes.querySelector('textarea')) { P.notes.textContent = ''; notesSection(P.notes, orig); }
        // appearance
        const stamp = look ? look.at + '|' + look.as : 'none';
        if (P.html !== stamp) {
          P.html = stamp;
          P.look.textContent = '';
          P.look.append(c.el('div', { className: 'pbn-tk-menu__head pbn-dos__lookhead' }, 'Their look',
            look ? c.el('span', { className: 'pbn-dos__when', textContent: 'seen ' + when(look.at) + (looks.length > 1 ? ' · as ' + look.as : '') }) : null));
          if (!look) {
            P.look.append(c.el('div', { className: 'pbn-dos__empty', textContent: 'No look saved yet. /look at them and it lands here, replacing the last one.' }));
          } else {
            const box = c.el('div', { className: 'pbn-dos__look' });
            box.append(cleanHtml(look.html));
            linkify(box);
            P.look.append(box);
          }
        }
      }

      if (CARDS) c.addStyle(String.raw`
        .chat-container [role="article"].pbn-dos-folded > :not(.pbn-dos-stub) { display: none !important; }
        .pbn-dos-stub { margin: 0; }
        .pbn-dos-stub__btn {
          margin-left: 8px; padding: 1px 9px; cursor: pointer; vertical-align: baseline;
          background: none; color: #c4b49a; border: 1px solid #5a1212; border-radius: 4px; font: inherit; font-size: .85em;
        }
        .pbn-dos-stub__btn:hover { color: #e8ddd0; background: #5a121233; }
        #pbn-dossier {
          position: fixed; z-index: 2500; display: flex; flex-direction: column; box-sizing: border-box;
          min-width: 300px; min-height: 160px; max-width: 96vw; max-height: 94vh; overflow: hidden; resize: both;
          background: #120a0a; color: #e8ddd0; border: 1px solid #5a1212; border-radius: 6px; box-shadow: 0 10px 36px #000c;
          font-family: system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: var(--pbn-dos-size, 16px);
        }
        #pbn-dossier[hidden] { display: none; }
        #pbn-dossier.pbn-dos--serif { font-family: Georgia, 'Palatino Linotype', 'Book Antiqua', serif; }
        #pbn-dossier.pbn-dos--folded { resize: none; min-height: 0; height: auto; }
        #pbn-dossier.pbn-dos--folded .pbn-dos__body { display: none; }
        .pbn-dos__head {
          display: flex; align-items: stretch; flex: 0 0 auto; cursor: move; user-select: none; touch-action: none;
          background: #1a0d0d; border-bottom: 1px solid #5a1212;
        }
        .pbn-dos__tabs { display: flex; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: thin; }
        .pbn-dos__tab { display: flex; align-items: stretch; flex: 0 1 auto; min-width: 90px; max-width: 220px; border-right: 1px solid #5a121266; }
        .pbn-dos__tab--on { flex-shrink: 0; max-width: 260px; }
        .pbn-dos__tab--on { background: #120a0a; box-shadow: inset 0 -2px #9e2b2b; }
        .pbn-dos__tab-btn {
          flex: 1; min-width: 0; padding: 9px 4px 9px 12px; border: 0; background: none; cursor: pointer; text-align: left;
          color: #9a8a7a; font: inherit; font-size: .9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .pbn-dos__tab--on .pbn-dos__tab-btn, .pbn-dos__tab-btn:hover { color: #f3e6cf; }
        .pbn-dos__tab-x { flex: 0 0 auto; padding: 0 9px; border: 0; background: none; cursor: pointer; color: #9a8a7a; font: inherit; font-size: 1.05em; }
        .pbn-dos__tab-x:hover { color: #e07062; }
        .pbn-dos__tools { display: flex; align-items: center; flex: 0 0 auto; padding: 0 4px; gap: 1px; }
        .pbn-dos__tool {
          min-width: 32px; height: 32px; padding: 0 6px; border: 0; border-radius: 4px; background: none; cursor: pointer;
          color: #c4b49a; font: 600 .9rem/1 system-ui, 'Segoe UI', sans-serif;
        }
        .pbn-dos__tool:hover { color: #f3e6cf; background: #5a121244; }
        .pbn-dos__tool:focus-visible, .pbn-dos__tab-btn:focus-visible, .pbn-dos__tab-x:focus-visible { outline: 2px solid #e0b84a; outline-offset: -2px; }
        .pbn-dos__body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 18px 18px; line-height: 1.6; }
        .pbn-dos__top { display: flex; align-items: flex-start; gap: 10px; }
        .pbn-dos__name { flex: 1; color: #f3e6cf; font-size: 1.35em; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
        .pbn-dos__btn {
          flex: 0 0 auto; padding: 4px 11px; cursor: pointer; background: none; color: #c4b49a;
          border: 1px solid #9e2b2b80; border-radius: 4px; font: inherit; font-size: .85em;
        }
        .pbn-dos__btn:hover { color: #e8ddd0; background: #5a121233; }
        .pbn-dos__alias { margin-top: 3px; color: #9a8a7a; font-size: .9em; font-style: italic; overflow-wrap: anywhere; }
        #pbn-dossier .pbn-tk-menu__head {
          display: flex; justify-content: space-between; gap: 10px; margin: 18px 0 8px; padding: 0 0 4px;
          border-bottom: 1px solid #5a121266; color: #9a8a7a; font-size: .75em; letter-spacing: .8px; text-transform: uppercase;
        }
        .pbn-dos__when { text-transform: none; letter-spacing: 0; font-size: 1.15em; font-style: italic; }
        #pbn-dossier .pbn-tk-menu__item { padding: 6px 0; font-size: 1em; }
        #pbn-dossier .pbn-nm-notes, #pbn-dossier .pbn-nm-notes-edit { margin: 0 0 6px; width: 100%; max-height: none; font-family: inherit; font-size: 1em; }
        #pbn-dossier .pbn-nm-notes-bar { padding: 0 0 6px; }
        .pbn-dos__look { overflow-wrap: anywhere; }
        .pbn-dos__look p { margin: 0 0 .7em; }
        .pbn-dos__look strong { font-weight: 600; }
        .pbn-dos__look a { color: #e0b84a; }
        .pbn-dos__look .look-equipment, .pbn-dos__look .look-political { margin-top: .6em; padding-top: .5em; border-top: 1px dotted #5a121299; }
        .pbn-dos__look .look-label { color: #9a8a7a; }
        .pbn-dos__empty { color: #9a8a7a; font-style: italic; }
      `);

      namesApi = {
        openList,
        // Save Log: restores the game text in a copy of a message, or with
        // withNames writes your names into it.
        prepareLogCopy(root, withNames) {
          root.querySelectorAll('.pbn-dos-stub').forEach(n => n.remove()); // folded-look line (DOM fallback only)
          root.querySelectorAll(`.${NM}[data-pbn-nm-orig]`).forEach(s => { s.textContent = s.dataset.pbnNmOrig; });
          if (!withNames) return;
          process(root);
          root.querySelectorAll('.' + NM).forEach(s => render(s, true));
        },
        writesMine: () => opt('names', 'log', 'game') === 'mine' && Object.values(book).some(e => e.name),
      };

      let tick = null;
      c.onRoute(c.isPlay, () => {
        loadBook();
        const run = () => {
          ensureButton();
          syncContainer();
          if ((c.getCharName() || 'default') !== bookChar) { closeDossier(); loadBook(); looksCache = null; refreshAll(); }
        };
        run();
        tick = setInterval(run, 1000);
        document.addEventListener('click', onChatClick);
        document.addEventListener('contextmenu', onChatContext);
        window.addEventListener('storage', onStorage);
        window.addEventListener('resize', placeDossier);
      }, () => {
        closeDossier();
        document.removeEventListener('contextmenu', onChatContext);
        window.removeEventListener('resize', placeDossier);
        clearInterval(tick);
        if (observer) observer.disconnect();
        if (typingObserver) typingObserver.disconnect();
        observer = null; container = null; typingObserver = null; column = null;
        document.removeEventListener('click', onChatClick);
        window.removeEventListener('storage', onStorage);
      });
    },
  });

  // ==========================================================================
  // SHARED MENU STYLE (popovers used by Hide, presets and languages)
  // ==========================================================================

  const SHARED_CSS = `
    .pbn-tk-menu {
      position: fixed; z-index: 9000; display: flex; flex-direction: column; min-width: 230px; max-width: 360px; padding: 4px 0;
      background: #120a0a; border: 1px solid #5a1212; border-radius: 6px; box-shadow: 0 8px 28px #000a;
      font-family: Georgia, 'Times New Roman', serif;
    }
    .pbn-tk-menu__head { padding: 6px 16px 4px; color: #9a8a7a; font-size: .8rem; text-transform: uppercase; letter-spacing: .8px; }
    .pbn-tk-menu__item, .pbn-tk-menu__check {
      display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box; padding: 9px 16px; text-align: left;
      border: 0; background: none; cursor: pointer; font: inherit; font-size: 1rem; color: #c4b49a;
    }
    .pbn-tk-menu__item:hover:not(:disabled), .pbn-tk-menu__check:hover { color: #e8ddd0; background: #5a121233; }
    .pbn-tk-menu__item:focus-visible { outline: 2px solid #e0b84a; outline-offset: -2px; }
    .pbn-tk-menu__item:disabled { opacity: .45; cursor: default; }
    .pbn-tk-menu__item--current { color: #f3e6cf; }
    span.pbn-tk-menu__check { width: 1em; padding: 0; color: #e0b84a; flex: 0 0 auto; background: none !important; }
    .pbn-tk-menu__check input { accent-color: #9e2b2b; width: 16px; height: 16px; margin: 0; }
    .pbn-tk-menu__sep { height: 1px; margin: 4px 0; background: #5a121299; }
    .pbn-tk-menu__note { padding: 6px 16px 8px; color: #9a8a7a; font-size: .95rem; font-style: italic; line-height: 1.4; }
  `;

  // ==========================================================================
  // SETTINGS PANEL
  // ==========================================================================

  const PANEL_ID = 'pbn-tk-panel';
  const PANEL_CSS = `
    #${PANEL_ID} {
      position: fixed; inset: 0; z-index: 2147483500; display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,.65); font: 15px/1.5 Georgia, 'Times New Roman', serif; color: #e8ddd0;
    }
    .pbn-tk__panel {
      width: min(720px, 94vw); max-height: 88vh; display: flex; flex-direction: column; box-sizing: border-box;
      background: #120a0a; border: 1px solid #5a1212; border-radius: 6px; box-shadow: 0 8px 40px rgba(0,0,0,.6);
    }
    .pbn-tk__head { padding: 18px 24px 10px; display: flex; align-items: baseline; gap: 12px; }
    .pbn-tk__title { font-family: TMUnicorn, serif; font-size: 1.6rem; letter-spacing: .5px; }
    .pbn-tk__version { color: #9a8a7a; font-size: .9rem; }
    .pbn-tk__x { margin-left: auto; background: none; border: 0; color: #9a8a7a; font-size: 1.4rem; cursor: pointer; padding: 0 4px; }
    .pbn-tk__x:hover { color: #e8ddd0; }
    .pbn-tk__intro { padding: 0 24px 10px; color: #c4b49a; font-size: .95rem; }
    .pbn-tk__dirty {
      margin: 0 24px 10px; padding: 8px 12px; display: none; align-items: center; gap: 12px;
      border: 1px solid #e0b84a66; border-radius: 4px; background: #e0b84a14; color: #e0b84a; font-size: .95rem;
    }
    .pbn-tk__dirty--on { display: flex; }
    .pbn-tk__body { overflow-y: auto; padding: 0 24px; }
    .pbn-tk-mod { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; padding: 14px 0; border-top: 1px solid #5a121266; }
    .pbn-tk-mod__name { font-size: 1.1rem; color: #f3e6cf; }
    .pbn-tk-mod__desc { color: #c4b49a; font-size: .95rem; }
    .pbn-tk-mod__note { color: #9a8a7a; font-size: .9rem; font-style: italic; }
    .pbn-tk-mod__status { font-size: .9rem; font-style: italic; color: #9a8a7a; }
    .pbn-tk-mod__status--legacy { color: #e0b84a; }
    .pbn-tk-mod__status--error { color: #f0906a; }
    .pbn-tk-mod__opts { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
    .pbn-tk-mod__opt { display: flex; align-items: center; gap: 10px; font-size: .95rem; color: #c4b49a; flex-wrap: wrap; }
    .pbn-tk-mod__opt select, .pbn-tk-mod__opt input[type=number] {
      background: #0d0707; color: #e8ddd0; border: 1px solid #5a1212; border-radius: 4px; padding: 3px 6px; font: inherit; font-size: .95rem;
    }
    .pbn-tk-mod__opt input[type=number] { width: 5em; }
    .pbn-tk-mod__opt input[type=checkbox] { accent-color: #9e2b2b; width: 16px; height: 16px; margin: 0; }
    .pbn-tk-mod__opts .pbn-tk-btn { align-self: flex-start; }
    .pbn-tk-mod--off .pbn-tk-mod__opts { opacity: .5; }
    .pbn-tk-switch { position: relative; width: 40px; height: 22px; margin-top: 2px; }
    .pbn-tk-switch input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; z-index: 1; }
    .pbn-tk-switch span {
      position: absolute; inset: 0; border-radius: 11px; background: #2a1515; border: 1px solid #5a1212; transition: background .15s;
    }
    .pbn-tk-switch span::after {
      content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
      background: #9a8a7a; transition: transform .15s, background .15s;
    }
    .pbn-tk-switch input:checked + span { background: #9e2b2b; }
    .pbn-tk-switch input:checked + span::after { transform: translateX(18px); background: #f3e6cf; }
    .pbn-tk-switch input:focus-visible + span { outline: 2px solid #e0b84a; outline-offset: 2px; }
    .pbn-tk__foot { padding: 12px 24px 16px; display: flex; gap: 8px; align-items: center; border-top: 1px solid #5a1212; flex-wrap: wrap; }
    .pbn-tk__foot-note { color: #9a8a7a; font-size: .85rem; margin-right: auto; }
    .pbn-tk-btn {
      cursor: pointer; padding: 5px 14px; border-radius: 4px; font: inherit; font-size: .95rem;
      background: #120a0a; color: #c4b49a; border: 1px solid #9e2b2b80;
    }
    .pbn-tk-btn:hover { color: #e8dcc0; background: #5a121233; }
    .pbn-tk-btn:focus-visible { outline: 2px solid #e0b84a; outline-offset: -2px; }
    .pbn-tk-btn--primary { background: #9e2b2b; color: #f3e6cf; border-color: #9e2b2b; }
    .pbn-tk-btn--primary:hover { background: #b33434; color: #fff; }
    .pbn-tk-section .pbn-tk-open { margin: 6px 0 4px; }
  `;

  function legacyState(id) { return document.documentElement.getAttribute(`data-pbn-legacy-${id}`); }

  function statusLine(m) {
    const legacy = legacyState(m.id);
    if (!isEnabled(m.id)) return ['Off.', ''];
    switch (status[m.id]) {
      case 'legacy':
        return [`Your separate "PbN ${m.name}" script is handling this. Uninstall it to let the toolkit take over.`, 'legacy'];
      case 'error':
        return [`Couldn't start: ${errors[m.id]}`, 'error'];
      case 'on':
        return legacy === 'deferred'
          ? [`On. Your separate "PbN ${m.name}" script is still installed and stepping aside; you can uninstall it.`, 'legacy']
          : ['On.', ''];
      default:
        return ['On (starts on the next page load).', ''];
    }
  }

  function openPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const s = loadSettings();
    let dirty = false;

    const dirtyBar = el('div', { className: 'pbn-tk__dirty' }, 'Changes apply after reloading the page.');
    const reloadBtn = el('button', { type: 'button', className: 'pbn-tk-btn pbn-tk-btn--primary', textContent: 'Reload now' });
    reloadBtn.addEventListener('click', () => location.reload());
    dirtyBar.append(reloadBtn);
    const markDirty = () => { dirty = true; dirtyBar.classList.add('pbn-tk__dirty--on'); saveSettings(s); };

    const body = el('div', { className: 'pbn-tk__body' });
    MODULES.forEach(m => {
      const on = s.enabled[m.id] !== false;
      const row = el('div', { className: 'pbn-tk-mod' + (on ? '' : ' pbn-tk-mod--off') });
      const sw = el('label', { className: 'pbn-tk-switch', title: on ? 'Turn off' : 'Turn on' });
      const box = el('input', { type: 'checkbox', checked: on });
      box.setAttribute('aria-label', `${m.name} on/off`);
      sw.append(box, el('span'));
      const [statusText, statusKind] = statusLine(m);
      const info = el('div', {},
        el('div', { className: 'pbn-tk-mod__name', textContent: m.name }),
        el('div', { className: 'pbn-tk-mod__desc', textContent: m.description }),
        m.note ? el('div', { className: 'pbn-tk-mod__note', textContent: m.note }) : null,
        el('div', { className: 'pbn-tk-mod__status' + (statusKind ? ` pbn-tk-mod__status--${statusKind}` : ''), textContent: statusText }));
      box.addEventListener('change', () => {
        s.enabled[m.id] = box.checked;
        row.classList.toggle('pbn-tk-mod--off', !box.checked);
        markDirty();
      });

      if (m.settings?.length || m.actions?.length) {
        const opts = el('div', { className: 'pbn-tk-mod__opts' });
        (m.settings || []).forEach(def => {
          const cur = s.opts[m.id]?.[def.key] ?? def.default;
          const setOpt = v => { (s.opts[m.id] || (s.opts[m.id] = {}))[def.key] = v; markDirty(); };
          let control;
          if (def.type === 'toggle') {
            control = el('input', { type: 'checkbox', checked: !!cur });
            control.addEventListener('change', () => setOpt(control.checked));
            opts.append(el('label', { className: 'pbn-tk-mod__opt' }, control, def.label));
            return;
          }
          if (def.type === 'select') {
            control = el('select', {}, ...def.options.map(([v, t]) => el('option', { value: v, textContent: t, selected: v === cur })));
            control.addEventListener('change', () => setOpt(control.value));
          } else {
            control = el('input', { type: 'number', value: cur, min: def.min ?? '', max: def.max ?? '' });
            control.addEventListener('change', () => {
              let v = Number(control.value);
              if (Number.isNaN(v)) v = def.default;
              if (def.min != null) v = Math.max(def.min, v);
              if (def.max != null) v = Math.min(def.max, v);
              control.value = v;
              setOpt(v);
            });
          }
          opts.append(el('label', { className: 'pbn-tk-mod__opt' }, def.label, control));
        });
        (m.actions || []).forEach(a => {
          const b = el('button', { type: 'button', className: 'pbn-tk-btn', textContent: a.label });
          const available = status[m.id] === 'on';
          b.disabled = !available;
          if (!available) b.title = 'Available while this feature is running in the toolkit';
          b.addEventListener('click', () => { close(); a.run(); });
          opts.append(b);
        });
        info.append(opts);
      }
      row.append(sw, info);
      body.append(row);
    });

    const exportBtn = el('button', { type: 'button', className: 'pbn-tk-btn', textContent: 'Export settings' });
    const importBtn = el('button', { type: 'button', className: 'pbn-tk-btn', textContent: 'Import…' });
    const closeBtn = el('button', { type: 'button', className: 'pbn-tk-btn pbn-tk-btn--primary', textContent: 'Close' });
    exportBtn.addEventListener('click', exportSettings);
    importBtn.addEventListener('click', importSettings);
    closeBtn.addEventListener('click', () => close());

    const x = el('button', { type: 'button', className: 'pbn-tk__x', textContent: '×', title: 'Close (Esc)' });
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', () => close());

    const panel = el('div', { className: 'pbn-tk__panel' },
      el('div', { className: 'pbn-tk__head' },
        el('span', { className: 'pbn-tk__title', textContent: 'PbN Toolkit' }),
        el('span', { className: 'pbn-tk__version', textContent: `v${TK_VERSION}` }), x),
      el('div', { className: 'pbn-tk__intro', textContent: 'Switch features on or off and adjust their settings. Everything is stored in this browser.' }),
      dirtyBar, body,
      el('div', { className: 'pbn-tk__foot' },
        el('span', { className: 'pbn-tk__foot-note', textContent: 'Backup or move your toolkit data (button lists, presets, languages, names, card order).' }),
        exportBtn, importBtn, closeBtn));
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'PbN Toolkit settings');
    const overlay = el('div', { id: PANEL_ID }, panel);

    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }
    function close() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (dirty && confirm('Reload the page now so your changes take effect?')) location.reload();
    }
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    closeBtn.focus();
  }

  // Every toolkit/standalone-script key: pbn-…, pbn_… (the toolkit's own
  // settings included).
  const isOurKey = k => /^pbn[-_]/.test(k);

  function exportSettings() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (isOurKey(k)) data[k] = localStorage.getItem(k);
    }
    const pad = n => String(n).padStart(2, '0');
    const d = new Date();
    const blob = new Blob([JSON.stringify({ app: 'pbn-toolkit', version: TK_VERSION, exported: d.toISOString(), data }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    el('a', { href: url, download: `pbn-toolkit-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json` }).click();
    URL.revokeObjectURL(url);
  }

  function importSettings() {
    const input = el('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      let parsed;
      try { parsed = JSON.parse(await file.text()); } catch (e) { alert(`That file isn't valid JSON: ${e.message}`); return; }
      if (parsed?.app !== 'pbn-toolkit' || !parsed.data || typeof parsed.data !== 'object') { alert("That doesn't look like a PbN Toolkit backup."); return; }
      const keys = Object.keys(parsed.data).filter(isOurKey);
      if (!confirm(`Import ${keys.length} saved item(s) from ${parsed.exported ? new Date(parsed.exported).toLocaleString() : 'this backup'}? ` +
        'Matching settings in this browser are replaced. The page reloads afterwards.')) return;
      keys.forEach(k => { if (typeof parsed.data[k] === 'string') localStorage.setItem(k, parsed.data[k]); });
      location.reload();
    });
    input.click();
  }

  // "PbN Toolkit" section in the play page's Settings tab, built from the
  // tab's own classes so it looks native.
  function ensureSettingsSection() {
    const tab = document.querySelector('.settings-tab');
    if (!tab || tab.querySelector('.pbn-tk-section')) return;
    const refSection = tab.querySelector('.settings-filter-section');
    const refDivider = tab.querySelector('.settings-filter-divider');
    const section = el('div', { className: 'settings-filter-section pbn-tk-section' });
    const divider = el('div', { className: 'settings-filter-divider', textContent: 'PbN Toolkit' });
    copyScopeAttrs(refSection || tab, section);
    copyScopeAttrs(refDivider || tab, divider);
    const open = el('button', { type: 'button', className: 'pbn-tk-btn pbn-tk-open', textContent: 'Open PbN Toolkit' });
    open.title = 'Switch toolkit features on or off and change their settings (Alt+Shift+T)';
    open.addEventListener('click', openPanel);
    section.append(divider, open);
    tab.append(section);
  }

  // ==========================================================================
  // BOOT
  // ==========================================================================

  const enabledIds = MODULES.filter(m => isEnabled(m.id)).map(m => m.id);
  // Published before any other userscript runs, for the standalone scripts.
  document.documentElement.setAttribute('data-pbn-toolkit', enabledIds.join(' '));
  document.documentElement.setAttribute('data-pbn-toolkit-version', TK_VERSION);

  MODULES.forEach(m => {
    status[m.id] = isEnabled(m.id) ? 'pending' : 'off';
    if (isEnabled(m.id) && m.early) {
      try { m.early(core); } catch (e) { status[m.id] = 'error'; errors[m.id] = e.message; LOG(m.id, e); }
    }
  });

  onDomReady(() => {
    addStyle(SHARED_CSS + PANEL_CSS);
    MODULES.forEach(m => {
      if (status[m.id] !== 'pending') return;
      if (legacyState(m.id) === 'running') { status[m.id] = 'legacy'; return; }
      try { m.start(core); status[m.id] = 'on'; }
      catch (e) { status[m.id] = 'error'; errors[m.id] = e.message; LOG(m.id, e); }
    });

    new MutationObserver(ensureSettingsSection).observe(document.body, { childList: true, subtree: true });
    ensureSettingsSection();
    document.addEventListener('keydown', e => {
      if (e.altKey && e.shiftKey && (e.key === 'T' || e.key === 't')) { e.preventDefault(); openPanel(); }
    });
  });
})();
