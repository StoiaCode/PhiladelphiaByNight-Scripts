// ==UserScript==
// @name         PbN Character Cards
// @namespace    stoia.red
// @version      1.2.0
// @description  Reorder your character cards, choose how many appear per row, and tidy recast/leave/delete into an Options menu on the My Characters page.
// @match        https://philadelphiabynight.net/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-character-cards.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-character-cards.user.js
// ==/UserScript==

(function () {
  'use strict';

  // The My Characters page lives at /vtm/my_characters, reached via Vue
  // Router pushState, so @match is sitewide and activation is gated on that
  // route (or the .mc-grid element existing) — see watchRoute() at the bottom.
  //
  // No layout shift: runs at document-start so the column count and a
  // "hidden until arranged" rule are in place before the site's first paint.
  // The grid is revealed only once cards are ordered and wired, all from
  // MutationObserver callbacks that run before the browser paints.

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
  // Ordering — via the CSS `order` property, so Vue's own DOM order (which it
  // owns and re-patches) is never touched.
  // --------------------------------------------------------------------------

  function currentOrderedCards(grid) {
    return Array.from(grid.querySelectorAll(':scope > .mc-card'))
      .map((c, i) => ({ c, o: c.style.order !== '' ? parseInt(c.style.order, 10) : i }))
      .sort((a, b) => a.o - b.o)
      .map(x => x.c);
  }

  function applyOrderAndPrune(grid, state) {
    const keyed = Array.from(grid.querySelectorAll(':scope > .mc-card')).map(c => ({ c, key: getCardKey(c) }));
    // The grid can render before its cards load; pruning against an empty
    // grid would wipe the saved order.
    if (!keyed.length) return;
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
  // Static CSS, injected at document-start so it applies from the very first
  // paint. .mc-grid is a CSS Grid (site stylesheet: auto-fill/minmax(320px)),
  // so the column count is a plain grid-template-columns override driven by a
  // custom property on <html>. Until the script marks the grid ready it stays
  // invisible (still taking up space, so nothing around it jumps); a CSS-only
  // timer reveals it after 1.5s regardless, in case the script ever breaks.
  // --------------------------------------------------------------------------

  const READY_ATTR = 'data-pbn-cc-ready';
  const baseStyle = document.createElement('style');
  baseStyle.textContent = `
    .mc-grid { grid-template-columns: repeat(var(${COLS_VAR}, ${DEFAULT_COLS}), 1fr) !important; }
    .mc-grid:not([${READY_ATTR}]) { visibility: hidden; animation: pbn-cc-failsafe 0s 1.5s forwards; }
    @keyframes pbn-cc-failsafe { to { visibility: visible; } }
  `;
  (document.head || document.documentElement).appendChild(baseStyle);

  function setCols(n) {
    document.documentElement.style.setProperty(COLS_VAR, String(n));
  }

  setCols(loadState().cols);

  // Reveal once there are cards to show, replaying the site's staggered
  // fade-in in the saved order instead of the DOM order (the original
  // animation already ran, invisibly, while the grid was hidden).
  function reveal(grid) {
    if (grid.hasAttribute(READY_ATTR) || !grid.querySelector(':scope > .mc-card')) return;
    const cards = currentOrderedCards(grid);
    cards.forEach((c, i) => { c.style.animationDelay = `${i * 80}ms`; c.style.animationName = 'none'; });
    void grid.offsetWidth; // flush so clearing animationName restarts it
    cards.forEach(c => { c.style.animationName = ''; });
    grid.setAttribute(READY_ATTR, '');
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
  (document.head || document.documentElement).appendChild(uiStyle);

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
  let mountedGrid = null;

  function mount() {
    const grid = document.querySelector('.mc-grid');
    if (!grid) return false;
    if (gridObserver) gridObserver.disconnect();
    mountedGrid = grid;

    const state = loadState();
    setCols(state.cols);
    uiStyle.disabled = false;
    buildStepperBar(grid, state);

    // Order + wire every card, then reveal. Also re-run whenever cards change
    // without a route change (they may load after the grid itself, or a
    // character gets created/deleted). Observer callbacks run before paint,
    // so the unarranged state is never drawn.
    function arrange(s) {
      applyOrderAndPrune(grid, s);
      grid.querySelectorAll(':scope > .mc-card').forEach(c => {
        if (!wired.has(c)) { wired.add(c); wireCard(grid, s, c); }
        wireOptions(c);
      });
      refreshButtons(grid, s);
      reveal(grid);
    }
    arrange(state);
    gridObserver = new MutationObserver(() => arrange(loadState()));
    gridObserver.observe(grid, { childList: true });

    return true;
  }

  // Violentmonkey only evaluates @match on a real page load; this site's Vue
  // Router changes the URL via pushState without reloading the document.
  // pushState/replaceState are wrapped so a route change is noticed in the
  // same tick (the old 500ms poll alone left the site's unarranged layout on
  // screen for up to half a second); the poll stays as a backstop.
  function watchRoute(isActive, enter, exit) {
    let active = null;
    function check() {
      const on = !!isActive();
      if (on === active) return;
      active = on;
      (on ? enter : exit)();
    }
    for (const fn of ['pushState', 'replaceState']) {
      const orig = history[fn];
      history[fn] = function (...args) {
        const r = orig.apply(this, args);
        check();
        return r;
      };
    }
    window.addEventListener('popstate', check);
    setInterval(check, 500);
    check();
  }

  // While the page is active, mount whenever a .mc-grid appears that isn't
  // the one already mounted — first render, or Vue re-rendering the page.
  // Watches the whole document (body may not exist yet at document-start).
  let docObserver = null;

  function syncGrid() {
    const g = document.querySelector('.mc-grid');
    if (g && g !== mountedGrid) mount();
  }

  function enter() {
    syncGrid();
    docObserver = new MutationObserver(syncGrid);
    docObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function exit() {
    if (docObserver) { docObserver.disconnect(); docObserver = null; }
    if (gridObserver) { gridObserver.disconnect(); gridObserver = null; }
    mountedGrid = null;
    closeMenu();
    uiStyle.disabled = true;
    document.getElementById('pbn-cc-stepper')?.remove();
  }

  watchRoute(
    () => /\/my_characters\/?$/.test(location.pathname) || !!document.querySelector('.mc-grid'),
    enter, exit,
  );
})();
