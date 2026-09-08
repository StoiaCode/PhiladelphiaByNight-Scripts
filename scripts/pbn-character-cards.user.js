// ==UserScript==
// @name         PbN Character Cards
// @namespace    stoia.red
// @version      1.0.0
// @description  Reorder your character cards and choose how many appear per row on the My Characters page.
// @match        https://philadelphiabynight.net/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-character-cards.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-character-cards.user.js
// ==/UserScript==

(function () {
  'use strict';

  // The exact URL of the "My Characters" page isn't known (its nav link is a
  // <div>, not an <a href>, wired up via a programmatic router push), so
  // @match is left sitewide and real activation is gated on the .mc-grid
  // element actually existing — see watchRoute() at the bottom.

  const STORAGE_KEY = 'pbn-character-cards';
  const DEFAULT_COLS = 3;
  const MIN_COLS = 1;
  const MAX_COLS = 6;
  const COLS_VAR = '--pbn-cc-cols';

  // --------------------------------------------------------------------------
  // Storage
  // --------------------------------------------------------------------------

  function getCardKey(article) {
    return article.getAttribute('aria-label')
      || article.querySelector('.mc-card__name')?.textContent.trim()
      || '';
  }

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return {
        order: Array.isArray(raw.order) ? raw.order : [],
        cols: Math.min(MAX_COLS, Math.max(MIN_COLS, parseInt(raw.cols, 10) || DEFAULT_COLS)),
      };
    } catch (e) { return { order: [], cols: DEFAULT_COLS }; }
  }

  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  // --------------------------------------------------------------------------
  // Ordering — uses the CSS `order` property so it works whether .mc-grid
  // turns out to be a CSS Grid or a Flexbox container.
  // --------------------------------------------------------------------------

  function currentOrderedCards(grid) {
    return Array.from(grid.querySelectorAll(':scope > .mc-card'))
      .map((c, i) => ({ c, o: c.style.order !== '' ? parseInt(c.style.order, 10) : i }))
      .sort((a, b) => a.o - b.o)
      .map(x => x.c);
  }

  function applyOrderAndPrune(grid, state) {
    const keyed = Array.from(grid.querySelectorAll(':scope > .mc-card')).map(c => ({ c, key: getCardKey(c) }));
    const present = new Set(keyed.map(x => x.key));
    const known = state.order.filter(k => present.has(k));
    const knownSet = new Set(known);
    const fresh = keyed.filter(x => !knownSet.has(x.key)).map(x => x.key);
    const finalOrder = known.concat(fresh);

    finalOrder.forEach((key, i) => {
      const entry = keyed.find(x => x.key === key);
      if (entry) entry.c.style.order = String(i);
    });

    if (finalOrder.join('') !== state.order.join('')) {
      state.order = finalOrder;
      saveState(state);
    }
  }

  function moveCard(grid, state, key, dir) {
    const cards = currentOrderedCards(grid);
    const idx = cards.findIndex(c => getCardKey(c) === key);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= cards.length) return;
    [cards[idx], cards[swapIdx]] = [cards[swapIdx], cards[idx]];
    cards.forEach((c, i) => c.style.order = String(i));
    state.order = cards.map(getCardKey);
    saveState(state);
    refreshButtons(grid, state);
  }

  // --------------------------------------------------------------------------
  // Column count — a hybrid CSS rule covers both possible layout modes for
  // .mc-grid (unknown without the site's stylesheet): grid-template-columns
  // takes effect if it's CSS Grid, the flex/max-width rule if it's Flexbox.
  // Exactly one half is ever live; the other is inert.
  // --------------------------------------------------------------------------

  const style = document.createElement('style');
  style.textContent = `
    .mc-grid {
      grid-template-columns: repeat(var(${COLS_VAR}, ${DEFAULT_COLS}), 1fr) !important;
    }
    .mc-grid > .mc-card {
      flex: 1 1 calc(100% / var(${COLS_VAR}, ${DEFAULT_COLS})) !important;
      max-width: calc(100% / var(${COLS_VAR}, ${DEFAULT_COLS})) !important;
      box-sizing: border-box !important;
    }
  `;
  style.disabled = true;
  document.head.appendChild(style);

  function setCols(n) {
    document.documentElement.style.setProperty(COLS_VAR, String(n));
  }

  // --------------------------------------------------------------------------
  // UI
  // --------------------------------------------------------------------------

  function makeBtn(label, className) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    if (className) btn.className = className;
    btn.style.cssText = [
      'cursor:pointer', 'font:11px/1.4 inherit',
      'padding:3px 10px', 'border-radius:4px',
      'border:1px solid rgba(255,255,255,0.25)',
      'background:rgba(255,255,255,0.08)', 'color:inherit',
    ].join(';');
    btn.addEventListener('mouseenter', () => { if (!btn.disabled) btn.style.filter = 'brightness(1.35)'; });
    btn.addEventListener('mouseleave', () => { btn.style.filter = ''; });
    btn.addEventListener('mousedown', e => e.preventDefault());
    return btn;
  }

  function wireCard(grid, state, article) {
    const actions = article.querySelector('.mc-card__actions');
    if (!actions || actions.querySelector('.pbn-cc-up')) return;
    const up = makeBtn('▲', 'pbn-cc-up');
    const down = makeBtn('▼', 'pbn-cc-down');
    up.addEventListener('click', () => moveCard(grid, state, getCardKey(article), -1));
    down.addEventListener('click', () => moveCard(grid, state, getCardKey(article), 1));
    actions.appendChild(up);
    actions.appendChild(down);
  }

  function refreshButtons(grid, state) {
    const cards = currentOrderedCards(grid);
    cards.forEach((c, i) => {
      const up = c.querySelector('.pbn-cc-up');
      const down = c.querySelector('.pbn-cc-down');
      if (up) { up.disabled = i === 0; up.style.opacity = up.disabled ? '0.35' : '1'; }
      if (down) { down.disabled = i === cards.length - 1; down.style.opacity = down.disabled ? '0.35' : '1'; }
    });
  }

  function buildStepperBar(grid, state) {
    if (grid.previousElementSibling?.id === 'pbn-cc-stepper') return;

    const bar = document.createElement('div');
    bar.id = 'pbn-cc-stepper';
    bar.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:8px;font:12px/1.4 inherit;';

    const label = document.createElement('span');
    label.textContent = 'Cards per row:';
    label.style.opacity = '0.7';

    const minusBtn = makeBtn('–');
    const countEl = document.createElement('span');
    countEl.style.cssText = 'min-width:1.5em;text-align:center;font-weight:600;';
    const plusBtn = makeBtn('+');

    function render() { countEl.textContent = String(state.cols); }
    render();

    minusBtn.addEventListener('click', () => {
      state.cols = Math.max(MIN_COLS, state.cols - 1);
      setCols(state.cols);
      saveState(state);
      render();
    });
    plusBtn.addEventListener('click', () => {
      state.cols = Math.min(MAX_COLS, state.cols + 1);
      setCols(state.cols);
      saveState(state);
      render();
    });

    bar.append(label, minusBtn, countEl, plusBtn);
    grid.parentElement.insertBefore(bar, grid);
  }

  // --------------------------------------------------------------------------
  // Mount / route lifecycle
  // --------------------------------------------------------------------------

  const wired = new WeakSet();
  let gridObserver = null;

  function mount() {
    const grid = document.querySelector('.mc-grid');
    if (!grid) return false;

    const state = loadState();
    applyOrderAndPrune(grid, state);
    setCols(state.cols);
    style.disabled = false;

    buildStepperBar(grid, state);
    grid.querySelectorAll(':scope > .mc-card').forEach(c => {
      if (!wired.has(c)) { wired.add(c); wireCard(grid, state, c); }
    });
    refreshButtons(grid, state);

    // Cards can change without a route change (creating/deleting a
    // character), so keep reconciling order/wiring while this page is up.
    gridObserver = new MutationObserver(() => {
      const s = loadState();
      applyOrderAndPrune(grid, s);
      grid.querySelectorAll(':scope > .mc-card').forEach(c => {
        if (!wired.has(c)) { wired.add(c); wireCard(grid, s, c); }
      });
      refreshButtons(grid, s);
    });
    gridObserver.observe(grid, { childList: true });

    return true;
  }

  // Violentmonkey only evaluates @match on a real page load; this site's Vue
  // Router changes the URL via pushState without reloading the document, so
  // this script self-monitors for .mc-grid rather than relying on a fixed
  // route and tears itself down when the grid disappears.
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

  let waiter = null;

  function enter() {
    if (mount()) return;
    waiter = new MutationObserver(() => { if (mount()) { waiter.disconnect(); waiter = null; } });
    waiter.observe(document.body, { childList: true, subtree: true });
  }

  function exit() {
    if (waiter) { waiter.disconnect(); waiter = null; }
    if (gridObserver) { gridObserver.disconnect(); gridObserver = null; }
    style.disabled = true;
    document.getElementById('pbn-cc-stepper')?.remove();
  }

  watchRoute(() => !!document.querySelector('.mc-grid'), enter, exit);
})();
