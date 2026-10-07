// ==UserScript==
// @name         PbN Compass Tools
// @namespace    stoia.red
// @version      1.2.0
// @description  Shows destination room names on compass hover, adds a Walk/Look/Search mode toggle, and an always-visible Up/Down bar under the compass.
// @match        https://philadelphiabynight.net/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-compass-tools.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-compass-tools.user.js
// ==/UserScript==

(function () {
  'use strict';

  // Maps button label -> full direction word sent in commands.
  const DIR = {
    N: 'north', NE: 'northeast', E: 'east', SE: 'southeast',
    S: 'south', SW: 'southwest', W: 'west', NW: 'northwest',
  };

  // Modes: 'walk' = normal compass navigation, 'look' = /look <dir>, 'search' = /search <dir>
  let mode = 'walk';

  // --------------------------------------------------------------------------
  // Command input helpers (same approach as pbn-command-buttons)
  // --------------------------------------------------------------------------

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function findInput() {
    const pools = [
      Array.from(document.querySelectorAll('textarea')),
      Array.from(document.querySelectorAll('input[type="text"], input:not([type])')),
    ];
    for (const pool of pools) {
      const visible = pool.filter(el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      });
      if (visible.length) {
        return visible.sort((a, b) =>
          b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
      }
    }
    return null;
  }

  function sendCommand(cmd) {
    const input = findInput();
    if (!input) return;
    setNativeValue(input, cmd);
    input.focus();
    setTimeout(() => pressEnter(input), 0);
  }

  // --------------------------------------------------------------------------
  // Destination tooltips
  // Extract the room name from aria-label ("Go north to Walk-In Freezer" -> "Walk-In Freezer").
  // --------------------------------------------------------------------------

  function applyTooltips(compass) {
    compass.querySelectorAll('.compass__cell--open').forEach(btn => {
      const match = (btn.getAttribute('aria-label') || '').match(/^Go \w+ to (.+)$/i);
      if (match) btn.title = match[1];
    });
  }

  // --------------------------------------------------------------------------
  // Mode selector UI
  // --------------------------------------------------------------------------

  const MODES = ['walk', 'look', 'search'];

  // Segmented toggle in the style of the play page's own .tab-toggle
  // (palette from the site's play stylesheet).
  const style = document.createElement('style');
  style.textContent = `
    /* The exits pane centres its children; a shared width keeps the mode bar
       and the Up/Down bar lined up with each other under/over the compass. */
    .pbn-compass-toggle {
      display: flex; margin-bottom: 6px; overflow: hidden;
      width: 100%; max-width: 230px; box-sizing: border-box;
      border: 1px solid #9e2b2b80; border-radius: 6px;
    }
    .pbn-compass-toggle__btn {
      flex: 1; cursor: pointer; padding: 5px 8px;
      background: none; border: none;
      font-family: 'Courier New', monospace; font-size: .9rem; letter-spacing: .04em;
      color: #b0a489; transition: background .12s, color .12s;
    }
    .pbn-compass-toggle__btn + .pbn-compass-toggle__btn { border-left: 1px solid #9e2b2b59; }
    .pbn-compass-toggle__btn:hover { color: #e8dcc0; }
    .pbn-compass-toggle__btn:focus-visible { outline: 2px solid #e0b84a; outline-offset: -2px; }
    .pbn-compass-toggle__btn--active,
    .pbn-compass-toggle__btn--active:hover { color: #f3e6cf; background: #9e2b2b; }

    /* Up/Down bar under the compass replaces the site's own .vertical-exits
       row, which is only rendered when a vertical exit exists. */
    .vertical-exits { display: none !important; }
    .pbn-compass-vertical { margin: 6px 0 0; }
    .pbn-compass-toggle__btn:disabled,
    .pbn-compass-toggle__btn:disabled:hover { color: #b0a489; opacity: .35; cursor: not-allowed; }
    /* Mirror the native .vertical-exit-btn state colours. */
    .pbn-compass-vertical .pbn-vx--locked { color: #d4a34b; }
    .pbn-compass-vertical .pbn-vx--broken { color: #e07062; }
    .pbn-compass-vertical .pbn-vx--aerial-open { color: #aaaa5a; }
    .pbn-compass-vertical .pbn-vx--aerial-locked { color: #4a4a2a; cursor: not-allowed; }
  `;
  document.head.appendChild(style);

  function makeToggle(compass) {
    if (compass.previousElementSibling?.id === 'pbn-compass-toggle') return;

    const bar = document.createElement('div');
    bar.id = 'pbn-compass-toggle';
    bar.className = 'pbn-compass-toggle';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Compass click mode');

    MODES.forEach(m => {
      const btn = document.createElement('button');
      btn.type        = 'button';
      btn.className   = 'pbn-compass-toggle__btn';
      btn.textContent = m.charAt(0).toUpperCase() + m.slice(1);
      btn.dataset.mode = m;
      updateBtnStyle(btn, m === mode);
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => {
        mode = m;
        bar.querySelectorAll('button').forEach(b => updateBtnStyle(b, b.dataset.mode === mode));
        refreshVertical();
      });
      bar.appendChild(btn);
    });

    compass.parentElement.insertBefore(bar, compass);
  }

  function updateBtnStyle(btn, active) {
    btn.classList.toggle('pbn-compass-toggle__btn--active', active);
    btn.setAttribute('aria-pressed', String(active));
  }

  // --------------------------------------------------------------------------
  // Up/Down bar. Always shown under the compass. In walk mode each button
  // clicks the site's own (hidden) .vertical-exit-btn so Vue still does the
  // moving, and is disabled when that exit doesn't exist. In look/search mode
  // both are always live and send /look up, /search down, etc.
  // --------------------------------------------------------------------------

  const VERTICAL = [
    { dir: 'up',   label: '↑ Up' },
    { dir: 'down', label: '↓ Down' },
  ];

  // Matched on the up/down word rather than an exact "Go up" label, since
  // aerial exits may be worded differently.
  function nativeVertical(dir) {
    const re = new RegExp(`\\b${dir}\\b`, 'i');
    return Array.from(document.querySelectorAll('.vertical-exit-btn'))
      .find(b => re.test(`${b.getAttribute('aria-label') || ''} ${b.textContent}`)) || null;
  }

  const VX_STATES = ['locked', 'broken', 'aerial-open', 'aerial-locked'];

  function makeVertical(compass) {
    if (compass.nextElementSibling?.classList.contains('pbn-compass-vertical')) return;

    const bar = document.createElement('div');
    bar.className = 'pbn-compass-toggle pbn-compass-vertical';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Vertical exits');

    VERTICAL.forEach(({ dir, label }) => {
      const btn = document.createElement('button');
      btn.type        = 'button';
      btn.className   = 'pbn-compass-toggle__btn';
      btn.textContent = label;
      btn.dataset.dir = dir;
      btn.dataset.label = label;
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => {
        if (mode !== 'walk') { sendCommand(`/${mode} ${dir}`); return; }
        const native = nativeVertical(dir);
        if (native && !native.disabled) native.click();
      });
      bar.appendChild(btn);
    });

    compass.after(bar);
    refreshVertical();
  }

  function refreshVertical() {
    document.querySelectorAll('.pbn-compass-vertical button').forEach(btn => {
      const native = nativeVertical(btn.dataset.dir);
      btn.disabled = mode === 'walk' && (!native || native.disabled);
      // Only write on change: a text write is a childList mutation, which
      // would re-trigger the body observer that calls this.
      const text = native?.textContent.trim() || btn.dataset.label;
      if (btn.textContent !== text) btn.textContent = text;
      VX_STATES.forEach(s => btn.classList.toggle(`pbn-vx--${s}`,
        !!native?.classList.contains(`vertical-exit-btn--${s}`)));
      // Same "Go up to X" -> "X" tooltip treatment as the compass cells.
      const match = (native?.getAttribute('aria-label') || '').match(/^Go \w+ to (.+)$/i);
      btn.title = match ? match[1] : (native?.title || '');
    });
  }

  // --------------------------------------------------------------------------
  // Click intercept (capture phase runs before Vue's bubble-phase handler).
  // In non-walk modes, prevent navigation and send the appropriate command.
  // --------------------------------------------------------------------------

  function attachIntercept(compass) {
    if (compass.dataset.pbnIntercepted) return;
    compass.dataset.pbnIntercepted = '1';

    // pointerdown fires even on disabled buttons; use it to send commands.
    compass.addEventListener('pointerdown', e => {
      if (mode === 'walk') return;
      const cell = e.target.closest('.compass__cell');
      if (!cell) return;
      const dir = DIR[cell.textContent.trim().replace(/=+$/, '').toUpperCase()];
      if (dir) sendCommand(`/${mode} ${dir}`);
    }, true);

    // Suppress the click event on enabled cells so Vue doesn't navigate.
    compass.addEventListener('click', e => {
      if (mode === 'walk') return;
      if (e.target.closest('.compass__cell')) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  // --------------------------------------------------------------------------
  // Mount: find each compass and wire it up. Re-runs on SPA navigation.
  // --------------------------------------------------------------------------

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

  // Violentmonkey only evaluates @match on a real page load; this site's Vue
  // Router changes the URL via pushState without reloading the document, so
  // without this the observer below would keep running on every page of the
  // site instead of just /play.
  function watchRoute(isActive, enter, exit) {
    let active = null;
    function check() {
      const on = !!isActive();
      if (on === active) return;
      active = on;
      (on ? enter : exit)();
    }
    check();
    window.addEventListener('popstate', check);
    setInterval(check, 500);
  }

  let bodyObserver = null;

  function enter() {
    if (bodyObserver) return;
    // Re-apply tooltips when compass cells update (room changes, exits change).
    bodyObserver = new MutationObserver(mutations => {
      // .vertical-exits appears/disappears with the room; cheap to re-sync.
      // (Only touches disabled/title, neither of which this observer watches.)
      refreshVertical();
      const toUpdate = new Set();
      for (const m of mutations) {
        if (m.type === 'attributes') {
          // aria-label or class changed on a cell — re-tooltip its compass.
          const compass = m.target.closest?.('.compass');
          if (compass) toUpdate.add(compass);
          continue;
        }
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains('compass')) { mountAll(); return; }
          if (node.querySelector?.('.compass'))    { mountAll(); return; }
          if (node.classList?.contains('compass__cell')) {
            const compass = node.closest('.compass');
            if (compass) toUpdate.add(compass);
          }
        }
      }
      toUpdate.forEach(applyTooltips);
    });
    bodyObserver.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['class', 'aria-label'],
    });
    mountAll();
  }

  function exit() {
    if (bodyObserver) { bodyObserver.disconnect(); bodyObserver = null; }
    // No manual DOM cleanup needed: #pbn-compass-toggle and wired .compass
    // elements live inside the /play subtree Vue destroys on its own;
    // `wired` is a WeakSet, so entries are collected automatically.
  }

  watchRoute(() => location.pathname === '/play', enter, exit);
})();
