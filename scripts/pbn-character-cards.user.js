// ==UserScript==
// @name         PbN Character Cards
// @namespace    stoia.red
// @version      1.1.0
// @description  Reorder your character cards, choose how many appear per row, and tidy recast/leave/delete into an Options menu on the My Characters page.
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
  // Column count. .mc-grid's real layout mode (Grid vs Flexbox) isn't known
  // without the site's stylesheet, so it's detected at runtime and only the
  // matching rule is injected — NOT both. A percentage max-width/flex-basis
  // applies to any box regardless of display type, so if .mc-grid actually
  // uses CSS Grid, a max-width rule sitting alongside grid-template-columns
  // would resolve against the item's own (already 1/N-sized) grid-area
  // width, squeezing every card to roughly 1/N² of the row instead of 1/N.
  // --------------------------------------------------------------------------

  const GAP_VAR = '--pbn-cc-gap';
  const style = document.createElement('style');
  style.disabled = true;
  document.head.appendChild(style);

  function applyColumnCSS(grid) {
    const isFlex = getComputedStyle(grid).display.includes('flex');
    if (isFlex) {
      const cs = getComputedStyle(grid);
      const gapPx = parseFloat(cs.columnGap || cs.gap) || 0;
      document.documentElement.style.setProperty(GAP_VAR, `${gapPx}px`);
      style.textContent = `
        .mc-grid > .mc-card {
          flex: 1 1 calc((100% - (var(${COLS_VAR}, ${DEFAULT_COLS}) - 1) * var(${GAP_VAR}, 0px)) / var(${COLS_VAR}, ${DEFAULT_COLS})) !important;
          max-width: calc((100% - (var(${COLS_VAR}, ${DEFAULT_COLS}) - 1) * var(${GAP_VAR}, 0px)) / var(${COLS_VAR}, ${DEFAULT_COLS})) !important;
          box-sizing: border-box !important;
        }
      `;
    } else {
      style.textContent = `
        .mc-grid {
          grid-template-columns: repeat(var(${COLS_VAR}, ${DEFAULT_COLS}), 1fr) !important;
        }
      `;
    }
  }

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
    btn.addEventListener('mousedown', e => e.preventDefault());
    return btn;
  }

  // Vue's scoped CSS only matches elements carrying the component's data-v-*
  // attribute; copying it lets injected buttons inherit the site's styling.
  function copyScopeAttrs(from, to) {
    if (!from) return;
    for (const a of from.attributes) if (a.name.startsWith('data-v-')) to.setAttribute(a.name, '');
  }

  function wireCard(grid, state, article) {
    const actions = article.querySelector('.mc-card__actions');
    if (!actions || actions.querySelector('.pbn-cc-up')) return;
    // Real .mc-card__action buttons, narrowed by .pbn-cc-move in uiStyle.
    const up = makeBtn('▲', 'mc-card__action pbn-cc-move pbn-cc-up');
    const down = makeBtn('▼', 'mc-card__action pbn-cc-move pbn-cc-down');
    up.setAttribute('aria-label', 'Move card earlier');
    down.setAttribute('aria-label', 'Move card later');
    const sibling = actions.querySelector('.mc-card__action');
    copyScopeAttrs(sibling, up);
    copyScopeAttrs(sibling, down);
    up.addEventListener('click', () => moveCard(grid, state, getCardKey(article), -1));
    down.addEventListener('click', () => moveCard(grid, state, getCardKey(article), 1));
    actions.appendChild(up);
    actions.appendChild(down);
  }

  // --------------------------------------------------------------------------
  // Options menu. The site's "Request a recast" / "Take Leave" buttons sit in
  // their own unaligned rows above the actions row, and Delete sits right next
  // to the everyday buttons. All three are folded into one "Options" dropdown
  // that takes Delete's slot. The original buttons are hidden, not moved or
  // removed — Vue owns them — and each menu item just .click()s its original,
  // so the site's own handlers (and confirm dialogs) run unchanged. Items are
  // rebuilt from the live DOM on every open, so a recast/leave button that
  // appears or disappears later is picked up automatically.
  // --------------------------------------------------------------------------

  const uiStyle = document.createElement('style');
  uiStyle.disabled = true;
  uiStyle.textContent = `
    .mc-card__respec button,
    .mc-card__leave button,
    .mc-grid .mc-card__action--delete { display: none !important; }
    /* Collapse the rows entirely unless they hold something besides buttons
       (e.g. a leave-status note), so no empty gap is left behind. */
    .mc-card__respec:not(:has(> :not(button))),
    .mc-card__leave:not(:has(> :not(button))) { display: none !important; }

    /* Palette lifted from the site's my_characters stylesheet: the panel uses
       .mc-card's gradient/border/shadow, items use .mc-card__action's type,
       and each item keeps the accent its original button had. */
    .pbn-cc-menu {
      position: fixed; z-index: 9000; display: flex; flex-direction: column;
      min-width: 200px; padding: 4px 0;
      background: linear-gradient(175deg, #161a28 0%, #111520 60%, #0f1118 100%);
      border: 1px solid #ffffff1a; border-radius: 6px;
      box-shadow: 0 4px 12px #0006, 0 12px 40px #00000040;
    }
    .pbn-cc-menu__item {
      display: block; width: 100%; text-align: left; white-space: nowrap;
      padding: .7rem 1.1rem; border: 0; background: none; cursor: pointer;
      font-family: Georgia, 'Times New Roman', serif; font-size: .95rem;
      text-transform: uppercase; letter-spacing: .8px; color: #9a8e7e;
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

    /* ▲/▼ are real .mc-card__action buttons; just stop them taking an equal
       share of the row so View/Make Active/Options keep their width. */
    .mc-card__actions .pbn-cc-move { flex: 0 0 auto !important; padding: .75rem .85rem !important; }
    .mc-card__actions .pbn-cc-move:disabled { opacity: .3; }
    .mc-card__actions .pbn-cc-move:disabled:hover { color: #9a8e7e; background: none; }

    #pbn-cc-stepper {
      display: flex; gap: 8px; align-items: center; margin-bottom: 12px;
      font-family: Georgia, 'Times New Roman', serif;
    }
    .pbn-cc-stepper__label {
      color: #9a8e7e; font-size: .95rem; text-transform: uppercase; letter-spacing: .8px;
      margin-right: 4px;
    }
    .pbn-cc-stepper__btn {
      width: 2rem; height: 2rem; padding: 0; cursor: pointer;
      font-family: inherit; font-size: 1.1rem; line-height: 1; color: #9a8e7e;
      background: linear-gradient(175deg, #161a28 0%, #111520 60%, #0f1118 100%);
      border: 1px solid #ffffff1a; border-radius: 4px;
      transition: color .2s, border-color .2s;
    }
    .pbn-cc-stepper__btn:hover { color: #e8ddd0; border-color: #e31c2566; }
    .pbn-cc-stepper__btn:focus-visible { outline: 2px solid #e31c2580; outline-offset: 2px; }
    .pbn-cc-stepper__count { min-width: 1.6em; text-align: center; color: #e8ddd0; font-size: 1.05rem; }
  `;
  document.head.appendChild(uiStyle);

  let openMenu = null;

  function closeMenu() {
    if (!openMenu) return;
    openMenu.menu.remove();
    openMenu.trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
    window.removeEventListener('scroll', closeMenu, true);
    window.removeEventListener('resize', closeMenu);
    openMenu = null;
  }

  function onOutside(e) {
    if (openMenu && !openMenu.menu.contains(e.target) && !openMenu.trigger.contains(e.target)) closeMenu();
  }

  function onMenuKey(e) {
    if (e.key === 'Escape') { const t = openMenu?.trigger; closeMenu(); t?.focus(); }
  }

  function itemKind(orig) {
    if (orig.matches('.mc-card__action--delete')) return 'delete';
    if (orig.matches('.mc-card__leave-btn--return')) return 'return';
    if (orig.closest('.mc-card__respec')) return 'recast';
    return 'leave';
  }

  function menuEntries(article) {
    const entries = [];
    article.querySelectorAll('.mc-card__respec button, .mc-card__leave button').forEach(b => {
      entries.push({ orig: b, label: b.textContent.trim() });
    });
    const del = article.querySelector('.mc-card__action--delete');
    if (del) entries.push({ orig: del, label: del.textContent.trim() || 'Delete' });
    return entries;
  }

  function showMenu(article, trigger) {
    const entries = menuEntries(article);
    if (!entries.length) return;

    const menu = document.createElement('div');
    menu.className = 'pbn-cc-menu';
    menu.setAttribute('role', 'menu');

    entries.forEach(({ orig, label }) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.className = `pbn-cc-menu__item pbn-cc-menu__item--${itemKind(orig)}`;
      item.textContent = label;
      item.disabled = orig.disabled;
      if (orig.title) item.title = orig.title;
      item.addEventListener('click', () => { closeMenu(); orig.click(); });
      menu.appendChild(item);
    });

    document.body.appendChild(menu);

    // Right-align under the trigger; flip above it if there's no room below.
    const r = trigger.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const left = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8);
    const top = r.bottom + 4 + mh <= window.innerHeight ? r.bottom + 4 : Math.max(8, r.top - 4 - mh);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    trigger.setAttribute('aria-expanded', 'true');
    openMenu = { menu, trigger };
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu);
    menu.querySelector('button:not(:disabled)')?.focus();
  }

  function wireOptions(article) {
    const actions = article.querySelector('.mc-card__actions');
    if (!actions || actions.querySelector('.pbn-cc-options')) return;
    if (!menuEntries(article).length) return;

    const opts = document.createElement('button');
    opts.type = 'button';
    opts.className = 'mc-card__action mc-card__action--options pbn-cc-options';
    opts.textContent = 'Options ▾';
    opts.setAttribute('aria-haspopup', 'menu');
    opts.setAttribute('aria-expanded', 'false');
    opts.setAttribute('aria-label', 'More options');
    copyScopeAttrs(actions.querySelector('.mc-card__action'), opts);
    opts.addEventListener('click', () => {
      const wasOpen = openMenu?.trigger === opts;
      closeMenu();
      if (!wasOpen) showMenu(article, opts);
    });

    const del = actions.querySelector('.mc-card__action--delete');
    if (del) del.after(opts);
    else actions.appendChild(opts);
  }

  function refreshButtons(grid, state) {
    const cards = currentOrderedCards(grid);
    cards.forEach((c, i) => {
      const up = c.querySelector('.pbn-cc-up');
      const down = c.querySelector('.pbn-cc-down');
      if (up) up.disabled = i === 0;
      if (down) down.disabled = i === cards.length - 1;
    });
  }

  function buildStepperBar(grid, state) {
    if (grid.previousElementSibling?.id === 'pbn-cc-stepper') return;

    const bar = document.createElement('div');
    bar.id = 'pbn-cc-stepper';

    const label = document.createElement('span');
    label.className = 'pbn-cc-stepper__label';
    label.textContent = 'Cards per row';

    const minusBtn = makeBtn('–', 'pbn-cc-stepper__btn');
    minusBtn.setAttribute('aria-label', 'Fewer cards per row');
    const countEl = document.createElement('span');
    countEl.className = 'pbn-cc-stepper__count';
    const plusBtn = makeBtn('+', 'pbn-cc-stepper__btn');
    plusBtn.setAttribute('aria-label', 'More cards per row');

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
    applyColumnCSS(grid);
    setCols(state.cols);
    style.disabled = false;
    uiStyle.disabled = false;

    buildStepperBar(grid, state);
    grid.querySelectorAll(':scope > .mc-card').forEach(c => {
      if (!wired.has(c)) { wired.add(c); wireCard(grid, state, c); }
      wireOptions(c);
    });
    refreshButtons(grid, state);

    // Cards can change without a route change (creating/deleting a
    // character), so keep reconciling order/wiring while this page is up.
    gridObserver = new MutationObserver(() => {
      const s = loadState();
      applyOrderAndPrune(grid, s);
      grid.querySelectorAll(':scope > .mc-card').forEach(c => {
        if (!wired.has(c)) { wired.add(c); wireCard(grid, s, c); }
        wireOptions(c);
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
    closeMenu();
    style.disabled = true;
    uiStyle.disabled = true;
    document.getElementById('pbn-cc-stepper')?.remove();
  }

  watchRoute(() => !!document.querySelector('.mc-grid'), enter, exit);
})();
