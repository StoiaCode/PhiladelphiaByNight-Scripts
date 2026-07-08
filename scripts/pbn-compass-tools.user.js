// ==UserScript==
// @name         PbN Compass Tools
// @namespace    stoia.red
// @version      1.0.0
// @description  Shows destination room names on compass hover and adds Look/Search mode toggle.
// @match        https://philadelphiabynight.net/play
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

  function makeToggle(compass) {
    if (compass.previousElementSibling?.id === 'pbn-compass-toggle') return;

    const bar = document.createElement('div');
    bar.id = 'pbn-compass-toggle';
    bar.style.cssText = 'display:flex;gap:4px;margin-bottom:4px;';

    MODES.forEach(m => {
      const btn = document.createElement('button');
      btn.type        = 'button';
      btn.textContent = m.charAt(0).toUpperCase() + m.slice(1);
      btn.dataset.mode = m;
      btn.style.cssText = [
        'cursor:pointer', 'font:11px/1.4 inherit',
        'padding:2px 8px', 'border-radius:4px',
        'border:1px solid rgba(255,255,255,0.25)',
        'color:inherit', 'flex:1',
      ].join(';');
      updateBtnStyle(btn, m === mode);
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => {
        mode = m;
        bar.querySelectorAll('button').forEach(b => updateBtnStyle(b, b.dataset.mode === mode));
      });
      bar.appendChild(btn);
    });

    compass.parentElement.insertBefore(bar, compass);
  }

  function updateBtnStyle(btn, active) {
    btn.style.background = active
      ? 'rgba(255,255,255,0.22)'
      : 'rgba(255,255,255,0.06)';
    btn.style.fontWeight = active ? '600' : '400';
  }

  // --------------------------------------------------------------------------
  // Click intercept (capture phase runs before Vue's bubble-phase handler).
  // In non-walk modes, prevent navigation and send the appropriate command.
  // --------------------------------------------------------------------------

  function attachIntercept(compass) {
    if (compass.dataset.pbnIntercepted) return;
    compass.dataset.pbnIntercepted = '1';

    compass.addEventListener('click', e => {
      if (mode === 'walk') return;
      const cell = e.target.closest('.compass__cell--open');
      if (!cell) return;
      e.preventDefault();
      e.stopPropagation();
      const dir = DIR[cell.textContent.trim().toUpperCase()];
      if (dir) sendCommand(`/${mode} ${dir}`);
    }, true); // capture phase
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
      attachIntercept(compass);
    });
  }

  // Re-apply tooltips when compass cells update (room changes, exits change).
  new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList?.contains('compass')) { mountAll(); return; }
        if (node.querySelector?.('.compass'))    { mountAll(); return; }
        // Exit availability can change on existing compass (cell class updates).
        if (node.classList?.contains('compass__cell')) {
          node.closest('.compass') && applyTooltips(node.closest('.compass'));
          return;
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

  mountAll();
})();
