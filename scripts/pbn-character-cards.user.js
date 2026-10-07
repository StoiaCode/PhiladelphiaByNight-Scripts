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

  function menuEntries(article) {
    const entries = [];
    article.querySelectorAll('.mc-card__respec button, .mc-card__leave button').forEach(b => {
      entries.push({ orig: b, label: b.textContent.trim(), danger: false });
    });
    const del = article.querySelector('.mc-card__action--delete');
    if (del) entries.push({ orig: del, label: del.textContent.trim() || 'Delete', danger: true });
    return entries;
  }

  // First non-transparent background walking up from el, so the menu panel
  // matches whatever the card is drawn on.
  function solidBackground(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
    }
    return '#1a1a1a';
  }

  function showMenu(article, trigger) {
    const entries = menuEntries(article);
    if (!entries.length) return;

    const ref = getComputedStyle(trigger);
    const card = getComputedStyle(article);
    const fontSize = Math.max(parseFloat(ref.fontSize) || 0, 15);
    const border = card.borderTopWidth !== '0px' && card.borderTopStyle !== 'none'
      ? card.borderTopColor : 'rgba(255,255,255,0.18)';
    const dangerColor = getComputedStyle(article.querySelector('.mc-card__action--delete') || trigger).color;

    const menu = document.createElement('div');
    menu.className = 'pbn-cc-menu';
    menu.setAttribute('role', 'menu');
    menu.style.cssText = [
      'position:fixed', 'z-index:9000', 'display:flex', 'flex-direction:column',
      'padding:4px 0', `min-width:${Math.max(trigger.offsetWidth, 180)}px`,
      `background:${solidBackground(article)}`, `border:1px solid ${border}`,
      `border-radius:${card.borderTopLeftRadius || '6px'}`,
      'box-shadow:0 8px 24px rgba(0,0,0,0.55)',
    ].join(';');

    entries.forEach(({ orig, label, danger }) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.textContent = label;
      item.disabled = orig.disabled;
      if (orig.title) item.title = orig.title;
      item.style.cssText = [
        'display:block', 'width:100%', 'text-align:left', 'white-space:nowrap',
        'padding:9px 16px', 'border:0', 'background:transparent',
        `font-family:${ref.fontFamily}`, `font-size:${fontSize}px`,
        `letter-spacing:${ref.letterSpacing}`, `text-transform:${ref.textTransform}`,
        `color:${danger ? dangerColor : ref.color}`,
        `cursor:${orig.disabled ? 'default' : 'pointer'}`,
        `opacity:${orig.disabled ? '0.4' : '1'}`,
      ].join(';');
      if (danger) item.style.borderTop = `1px solid ${border}`;
      item.addEventListener('mouseenter', () => { if (!item.disabled) item.style.background = 'rgba(255,255,255,0.08)'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
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
    // Vue's scoped CSS only matches elements carrying the component's
    // data-v-* attribute, so copy it over to inherit the real button styling.
    const sibling = actions.querySelector('.mc-card__action');
    if (sibling) {
      for (const a of sibling.attributes) if (a.name.startsWith('data-v-')) opts.setAttribute(a.name, '');
    }
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
