// ==UserScript==
// @name         PbN Chat Log
// @namespace    stoia.red
// @version      1.3.0
// @description  Records the RP chat as it arrives and saves the session as a plain-text file on demand.
// @match        https://philadelphiabynight.net/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-chat-log.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-chat-log.user.js
// ==/UserScript==

(function () {
  'use strict';

  // How messages are recorded
  // -------------------------
  // Primary: read the play page's own Vue component state. Every RP-tab
  // message is pushed into its `messages` array (Activity-tab messages go to
  // a separate `activityMessages` array, which is deliberately ignored), and
  // that happens whether or not the row is ever on screen. A synchronous
  // watcher on that array records each message the moment it's pushed, with
  // the server's own timestamp when the message carries one.
  //
  // Fallback: if the component can't be found (e.g. a site update renames
  // things), watch the chat DOM for new rows like earlier versions did.
  // Only one of the two is ever active, so nothing is recorded twice.
  //
  // Earlier versions only had the DOM path, which could silently stop
  // recording mid-session; the component path doesn't depend on the DOM.

  const CHAT_SELECTOR    = '.chat-container';
  const ARTICLE_SELECTOR = '[role="article"]';
  const BTN_ID           = 'pbn-log-btn';
  const SEARCH_ID        = 'pbn-log-search';
  const HIDE_ID          = 'pbn-log-hide';
  const FALLBACK_AFTER_MS = 5000;

  const sessionStart = new Date();
  const entries = []; // { ts: Date, text: string }[]
  const loggedMsgs = new WeakSet(); // raw message objects already recorded
  const seenKeys = new Set();       // `${timestamp}|${text}` for server-timestamped messages
  const seenEls = new WeakSet();    // DOM rows already recorded (fallback path)

  function pad(n) { return String(n).padStart(2, '0'); }

  function fmtDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function fmtTime(d) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function fmtTs(d) { return `${fmtDate(d)} ${fmtTime(d)}`; }

  // --------------------------------------------------------------------------
  // HTML -> text. The site separates parts of a line with CSS margins rather
  // than real spaces: e.g. a say renders as
  //   <p>[ROOM]<strong class="q-ml-sm">Name</strong><span class="q-ml-sm">says, "…"</span></p>
  // so plain text extraction glues it into "[ROOM]Namesays, …". Insert a real
  // space wherever a margin class or block boundary would visually separate
  // words, then collapse whitespace.
  // --------------------------------------------------------------------------

  function htmlToText(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const root = tpl.content;
    root.querySelectorAll('[class*="q-ml-"], [class*="q-mx-"], [class*="q-px-"], [class*="q-pl-"]').forEach(el => el.before(' '));
    root.querySelectorAll('[class*="q-mr-"], [class*="q-mx-"], [class*="q-px-"], [class*="q-pr-"]').forEach(el => el.after(' '));
    root.querySelectorAll('br, p, div, li, tr').forEach(el => { el.before(' '); el.after(' '); });
    return root.textContent.replace(/\s+/g, ' ').trim();
  }

  function record(text, ts) {
    if (text) entries.push({ ts, text });
  }

  // --------------------------------------------------------------------------
  // Primary path: the play component's `messages` array.
  // --------------------------------------------------------------------------

  // Walk the live component tree from the app root to the component that owns
  // both chat arrays. Uses Vue internals that exist in production builds
  // (#q-app._vnode is set by the renderer on every mount).
  function findPlayInstance() {
    const root = document.querySelector('#q-app')?._vnode;
    const stack = [root];
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

    // The "-- Recent activity in this room --" / "-- You are now here --"
    // markers are re-sent around every reconnect's history replay.
    if (m.isHistory && /^--.*--$/.test((m.text || '').trim())) return;

    const text = htmlToText(m.html || m.text || '');
    const serverTs = msgTimestamp(m);
    if (serverTs) {
      // History replays after a reconnect resend messages already recorded.
      const key = `${serverTs.getTime()}|${text}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
    }
    record(text, serverTs || new Date());
  }

  // Record every message at the tail of the array that hasn't been recorded
  // yet, oldest first. Called on every push, so normally that's one message.
  function drain(list) {
    let i = list.length;
    while (i > 0 && !loggedMsgs.has(list[i - 1].__v_raw || list[i - 1])) i--;
    for (; i < list.length; i++) logMessage(list[i]);
  }

  let hooked = null; // { inst, stop }

  function hookInstance(inst, { backfill }) {
    const p = inst.proxy;
    if (backfill) drain(p.messages); // record whatever is already in the RP list
    // Switching over from the DOM fallback: those rows are already recorded.
    else p.messages.forEach(m => loggedMsgs.add(m.__v_raw || m));
    const stop = p.$watch(
      () => { const a = p.messages; return a.length ? a[a.length - 1] : null; },
      () => drain(p.messages),
      { flush: 'sync' },
    );
    hooked = { inst, stop };
  }

  function unhook() {
    if (hooked) { hooked.stop(); hooked = null; }
  }

  // --------------------------------------------------------------------------
  // Fallback path: DOM rows.
  // --------------------------------------------------------------------------

  let chatObserver = null;
  let observedContainer = null;

  function captureEl(el, ts) {
    if (seenEls.has(el)) return;
    seenEls.add(el);
    record(htmlToText(el.innerHTML), ts || new Date());
  }

  function startDomFallback() {
    const container = document.querySelector(CHAT_SELECTOR);
    if (!container || container === observedContainer) return;
    stopDomFallback();
    observedContainer = container;
    // Rows already on screen get the session-start time; their real arrival
    // time isn't known on this path.
    container.querySelectorAll(ARTICLE_SELECTOR).forEach(el => captureEl(el, sessionStart));
    chatObserver = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches(ARTICLE_SELECTOR)) captureEl(node);
          else node.querySelectorAll(ARTICLE_SELECTOR).forEach(el => captureEl(el));
        }
      }
    });
    chatObserver.observe(container, { childList: true, subtree: true });
  }

  function stopDomFallback() {
    if (chatObserver) { chatObserver.disconnect(); chatObserver = null; }
    observedContainer = null;
  }

  // --------------------------------------------------------------------------
  // Save button
  // --------------------------------------------------------------------------

  function saveLog() {
    if (!entries.length) return;
    const header = [
      'Philadelphia by Night — Chat Log',
      `Session started : ${fmtTs(sessionStart)}`,
      `Saved           : ${fmtTs(new Date())}`,
      `Messages        : ${entries.length}`,
      '─'.repeat(64),
      '',
    ].join('\n');
    const body = entries.map(e => `[${fmtTs(e.ts)}] ${e.text}`).join('\n');
    const blob = new Blob([header + body], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `pbn-log-${fmtDate(sessionStart)}-${fmtTime(sessionStart).replace(/:/g, '')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Matches the site's own .chat-tab buttons it sits beside (palette from
  // the play page stylesheet), minus their flex:1 so it stays compact.
  const style = document.createElement('style');
  style.textContent = `
    #${BTN_ID} {
      margin-left: auto; flex: 0 0 auto; cursor: pointer;
      padding: 6px 16px; background: none; border: none;
      border-left: 1px solid #5a1212;
      font-family: TMUnicorn, serif; font-size: .85rem; letter-spacing: .5px;
      color: #c4b49a; transition: color .15s, background .15s;
    }
    #${BTN_ID}:hover { color: #e8ddd0; background: #5a121233; }
    #${BTN_ID}:focus-visible { outline: 2px solid #e8ddd0; outline-offset: -2px; }

    /* Hide | Search | Save Log: the leftmost present one takes the push-right margin. */
    #${HIDE_ID}, #${SEARCH_ID} {
      margin-left: auto; flex: 0 1 auto; min-width: 0;
      display: flex; align-items: stretch; border-left: 1px solid #5a1212;
    }
    #${HIDE_ID} + #${SEARCH_ID}, #${SEARCH_ID} + #${BTN_ID}, #${HIDE_ID} + #${BTN_ID} { margin-left: 0; }
    .pbn-lh-btn--active { color: #e0b84a !important; }

    /* Hidden messages. Rules are off while picking, so hidden rows can be
       seen (ghosted) and clicked again to bring them back. */
    body:not(.pbn-hide-picking) .chat-container [role="article"].pbn-hidden,
    body.pbn-hide-cat-whisper:not(.pbn-hide-picking) .chat-container [role="article"]:is(.pbn-cat-whisper, :has(.whisper-line, .auspex-whisper-line)),
    body.pbn-hide-cat-system:not(.pbn-hide-picking) .chat-container [role="article"]:has(> p > span.text-orange-9:first-child),
    body.pbn-hide-cat-ooc:not(.pbn-hide-picking) .chat-container [role="article"]:has(> p > span.text-blue:first-child) {
      display: none !important;
    }
    body.pbn-hide-picking .chat-container [role="article"] { cursor: pointer; }
    body.pbn-hide-picking .chat-container [role="article"]:hover { outline: 1px dashed #e0b84a99; outline-offset: -1px; }
    body.pbn-hide-picking .chat-container [role="article"].pbn-hidden,
    body.pbn-hide-picking.pbn-hide-cat-whisper .chat-container [role="article"]:is(.pbn-cat-whisper, :has(.whisper-line, .auspex-whisper-line)),
    body.pbn-hide-picking.pbn-hide-cat-system .chat-container [role="article"]:has(> p > span.text-orange-9:first-child),
    body.pbn-hide-picking.pbn-hide-cat-ooc .chat-container [role="article"]:has(> p > span.text-blue:first-child) {
      opacity: .3; text-decoration: line-through;
    }

    .pbn-lh-menu {
      position: fixed; z-index: 9000; display: flex; flex-direction: column;
      min-width: 230px; padding: 4px 0;
      background: #120a0a; border: 1px solid #5a1212; border-radius: 6px;
      box-shadow: 0 8px 28px #000a; font-family: Georgia, 'Times New Roman', serif;
    }
    .pbn-lh-menu__head {
      padding: 6px 16px 4px; color: #9a8a7a; font-size: .8rem;
      text-transform: uppercase; letter-spacing: .8px;
    }
    .pbn-lh-menu label, .pbn-lh-item {
      display: flex; align-items: center; gap: 10px; padding: 8px 16px; cursor: pointer;
      font: inherit; font-size: 1rem; color: #c4b49a; text-align: left;
      background: none; border: 0; width: 100%;
    }
    .pbn-lh-menu label:hover, .pbn-lh-item:hover:not(:disabled) { color: #e8ddd0; background: #5a121233; }
    .pbn-lh-item:disabled { opacity: .45; cursor: default; }
    .pbn-lh-item:focus-visible { outline: 2px solid #e0b84a; outline-offset: -2px; }
    .pbn-lh-menu input { accent-color: #9e2b2b; width: 16px; height: 16px; margin: 0; }
    .pbn-lh-sep { height: 1px; margin: 4px 0; background: #5a121299; }
    .pbn-ls-btn {
      flex: 0 0 auto; cursor: pointer; padding: 6px 12px; background: none; border: none;
      font-family: TMUnicorn, serif; font-size: .85rem; letter-spacing: .5px;
      color: #c4b49a; transition: color .15s, background .15s;
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
    .pbn-ls-count {
      min-width: 4.5em; padding: 0 4px; text-align: center; white-space: nowrap;
      font-family: Georgia, 'Times New Roman', serif; font-size: .9rem; color: #9a8a7a;
    }

    ::highlight(pbn-log-search) { background-color: #e0b84a40; }
    ::highlight(pbn-log-search-current) { background-color: #e0b84a; color: #120a0a; }
    .chat-container .pbn-log-hit {
      outline: 1px solid #e0b84a99; outline-offset: -1px; background: #e0b84a14;
      border-radius: 3px;
    }
  `;
  document.head.appendChild(style);

  function ensureButton() {
    if (document.getElementById(BTN_ID)) return;
    const tabBar = document.querySelector('.chat-tab-bar');
    if (!tabBar) return;
    const btn = document.createElement('button');
    btn.type        = 'button';
    btn.id          = BTN_ID;
    btn.textContent = 'Save Log';
    btn.title       = 'Download this session\'s chat as a text file';
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', saveLog);
    tabBar.appendChild(btn);
  }

  // --------------------------------------------------------------------------
  // Search. Searches the messages currently in the chat (the site keeps the
  // last 500 on the page; older ones only exist in the saved log), scrolls a
  // match to the middle of the chat and highlights it. Matching ignores case
  // and whitespace, because the site separates names from "says," etc. with
  // CSS margins rather than spaces. Highlighting uses the CSS Custom
  // Highlight API, so the site's chat HTML is never modified; browsers
  // without it still get the outlined row.
  // --------------------------------------------------------------------------

  const canHighlight = typeof Highlight === 'function' && !!(window.CSS && CSS.highlights);
  let searchState = null; // { rows: Element[], idx, current: Element|null }

  // Rows currently shown (rows hidden via the Hide menu have no boxes).
  function chatRows() {
    const c = document.querySelector(CHAT_SELECTOR);
    return c ? Array.from(c.querySelectorAll(ARTICLE_SELECTOR)).filter(r => r.getClientRects().length) : [];
  }

  // Ranges for every whitespace-insensitive occurrence of `needle` in `row`.
  function matchRanges(row, needle) {
    const chars = []; // [textNode, offset] for each non-whitespace character
    let hay = '';
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue;
      for (let i = 0; i < t.length; i++) {
        if (/\s/.test(t[i])) continue;
        chars.push([n, i]);
        hay += t[i];
      }
    }
    hay = hay.toLowerCase();
    const ranges = [];
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
      const [sn, so] = chars[at];
      const [en, eo] = chars[at + needle.length - 1];
      const r = document.createRange();
      r.setStart(sn, so);
      r.setEnd(en, eo + 1);
      ranges.push(r);
    }
    return ranges;
  }

  function clearHits() {
    if (canHighlight) {
      CSS.highlights.delete('pbn-log-search');
      CSS.highlights.delete('pbn-log-search-current');
    }
    document.querySelectorAll('.pbn-log-hit').forEach(r => r.classList.remove('pbn-log-hit'));
  }

  function scrollRowIntoView(row) {
    const c = document.querySelector(CHAT_SELECTOR);
    if (!c) return;
    const offset = () => {
      const cr = c.getBoundingClientRect(), rr = row.getBoundingClientRect();
      return rr.top - cr.top - (cr.height - rr.height) / 2;
    };
    c.scrollBy({ top: offset(), behavior: 'smooth' });
    // Backstop: if the smooth scroll didn't happen (some browsers skip the
    // animation in background/throttled tabs), jump there directly.
    setTimeout(() => {
      if (row.isConnected && Math.abs(offset()) > c.clientHeight / 2) c.scrollTop += offset();
    }, 700);
  }

  // Re-run the search against the current chat. dir: 0 = jump to the newest
  // match, -1 = next older, +1 = next newer (relative to the current match).
  function runSearch(box, dir) {
    const needle = box.input.value.replace(/\s+/g, '').toLowerCase();
    clearHits();
    if (!needle) { searchState = null; box.count.textContent = ''; setNav(box, false); return; }

    const hits = []; // { row, ranges }
    chatRows().forEach(row => {
      const ranges = matchRanges(row, needle);
      if (ranges.length) hits.push({ row, ranges });
    });
    if (!hits.length) {
      searchState = null;
      box.count.textContent = 'none';
      box.count.title = 'No matches among the messages on screen. The site only keeps the last 500; older lines are in Save Log.';
      setNav(box, false);
      return;
    }

    let idx = hits.length - 1;
    const prev = searchState?.current;
    const prevIdx = prev ? hits.findIndex(h => h.row === prev) : -1;
    if (dir && prevIdx !== -1) idx = Math.min(hits.length - 1, Math.max(0, prevIdx + dir));

    const cur = hits[idx];
    searchState = { idx, current: cur.row };
    if (canHighlight) {
      CSS.highlights.set('pbn-log-search', new Highlight(...hits.flatMap(h => h.ranges)));
      CSS.highlights.set('pbn-log-search-current', new Highlight(...cur.ranges));
    }
    cur.row.classList.add('pbn-log-hit');
    scrollRowIntoView(cur.row);

    // Counted from the newest, since searching works upward through the chat.
    box.count.textContent = `${hits.length - idx} / ${hits.length}`;
    box.count.title = 'Enter: older match · Shift+Enter: newer match · Esc: close';
    setNav(box, true, idx > 0, idx < hits.length - 1);
  }

  function setNav(box, any, older = false, newer = false) {
    box.older.disabled = !any || !older;
    box.newer.disabled = !any || !newer;
  }

  function ensureSearch() {
    if (document.getElementById(SEARCH_ID)) return;
    const logBtn = document.getElementById(BTN_ID);
    if (!logBtn) return;

    const mk = (tag, props) => Object.assign(document.createElement(tag), props);
    const wrap = mk('div', { id: SEARCH_ID });
    const toggle = mk('button', { type: 'button', className: 'pbn-ls-btn pbn-ls-toggle', textContent: 'Search', title: 'Search the chat' });
    const boxEl = mk('span', { className: 'pbn-ls-box' });
    const input = mk('input', { type: 'text', className: 'pbn-ls-input', placeholder: 'Search chat…', spellcheck: false });
    input.setAttribute('aria-label', 'Search the chat');
    const count = mk('span', { className: 'pbn-ls-count' });
    count.setAttribute('aria-live', 'polite');
    const older = mk('button', { type: 'button', className: 'pbn-ls-btn', textContent: '▲', title: 'Older match (Enter)' });
    const newer = mk('button', { type: 'button', className: 'pbn-ls-btn', textContent: '▼', title: 'Newer match (Shift+Enter)' });
    const close = mk('button', { type: 'button', className: 'pbn-ls-btn', textContent: '✕', title: 'Close search (Esc)' });
    older.setAttribute('aria-label', 'Older match');
    newer.setAttribute('aria-label', 'Newer match');
    close.setAttribute('aria-label', 'Close search');
    boxEl.append(input, count, older, newer, close);
    wrap.append(toggle, boxEl);

    const box = { input, count, older, newer };
    setNav(box, false);

    function open() { wrap.classList.add('pbn-ls--open'); input.focus(); input.select(); }
    function shut() {
      wrap.classList.remove('pbn-ls--open');
      clearHits();
      searchState = null;
      count.textContent = '';
      toggle.focus();
    }

    let debounce = null;
    toggle.addEventListener('click', open);
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      searchState = null; // a new query starts again from the newest match
      debounce = setTimeout(() => runSearch(box, 0), 150);
    });
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

  // --------------------------------------------------------------------------
  // Hide. Temporarily hides chat messages (screenshots, backreading): quick
  // filters for whole kinds of message, plus a picking mode to click single
  // messages away. Display only — nothing is stored, the saved log is
  // unaffected, and a reload or tab switch brings everything back.
  //
  // Filters are body classes driving CSS :has() rules on the rows' own
  // markup. "X whispers to Y." / "A whisper brushes…" notices are plain
  // [SYSTEM] lines, so those rows get a pbn-cat-whisper class by text.
  // Picked rows get pbn-hidden. Vue leaves both alone: it only rewrites a
  // row's class when its own class binding changes.
  // --------------------------------------------------------------------------

  const HIDE_CATS = [
    ['whisper', 'Whispers'],
    ['system', 'System messages'],
    ['ooc', 'OOC & LOOC'],
  ];
  const WHISPER_RE = /\bwhispers to\b|A whisper brushes the edge of your awareness|catch the words meant only for another/i;
  const tagged = new WeakSet();
  let hideMenu = null;

  // Tags rows as they're added (observer callbacks run before paint, so a
  // filtered whisper never flashes up); the 1s sync tick re-attaches the
  // observer if the chat container is ever replaced.
  let tagObserver = null, tagContainer = null;

  function tagWhispers() {
    const c = document.querySelector(CHAT_SELECTOR);
    if (!c) return;
    c.querySelectorAll(ARTICLE_SELECTOR).forEach(row => {
      if (tagged.has(row)) return;
      tagged.add(row);
      if (WHISPER_RE.test(row.textContent)) row.classList.add('pbn-cat-whisper');
    });
    if (c !== tagContainer) {
      if (tagObserver) tagObserver.disconnect();
      tagContainer = c;
      tagObserver = new MutationObserver(tagWhispers);
      tagObserver.observe(c, { childList: true });
    }
  }

  const picking = () => document.body.classList.contains('pbn-hide-picking');
  const hiddenCount = () => document.querySelectorAll(`${CHAT_SELECTOR} .pbn-hidden`).length;

  function refreshHideButton() {
    const btn = document.querySelector(`#${HIDE_ID} .pbn-lh-toggle`);
    if (!btn) return;
    const n = hiddenCount();
    const cats = HIDE_CATS.filter(([k]) => document.body.classList.contains(`pbn-hide-cat-${k}`)).length;
    const text = picking() ? 'Done' : n ? `Hide · ${n}` : 'Hide';
    if (btn.textContent !== text) btn.textContent = text;
    btn.classList.toggle('pbn-lh-btn--active', picking() || n > 0 || cats > 0);
    btn.title = picking()
      ? 'Click messages to hide or bring them back; click Done (or Esc) to finish'
      : 'Temporarily hide chat messages';
  }

  function onPickClick(e) {
    const row = e.target.closest(`${CHAT_SELECTOR} ${ARTICLE_SELECTOR}`);
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
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

  function closeHideMenu() {
    if (!hideMenu) return;
    hideMenu.remove();
    hideMenu = null;
    document.removeEventListener('mousedown', onHideOutside, true);
    document.removeEventListener('keydown', onHideMenuKey, true);
  }

  function onHideOutside(e) {
    if (hideMenu && !hideMenu.contains(e.target) && !e.target.closest(`#${HIDE_ID}`)) closeHideMenu();
  }

  function onHideMenuKey(e) { if (e.key === 'Escape') closeHideMenu(); }

  function openHideMenu(anchor) {
    const mk = (tag, props) => Object.assign(document.createElement(tag), props);
    const menu = mk('div', { className: 'pbn-lh-menu' });
    menu.setAttribute('role', 'menu');
    menu.append(mk('div', { className: 'pbn-lh-menu__head', textContent: 'Hide messages' }));

    HIDE_CATS.forEach(([key, label]) => {
      const box = mk('input', { type: 'checkbox', checked: document.body.classList.contains(`pbn-hide-cat-${key}`) });
      box.addEventListener('change', () => {
        document.body.classList.toggle(`pbn-hide-cat-${key}`, box.checked);
        refreshHideButton();
      });
      const l = mk('label', {});
      l.append(box, label);
      menu.append(l);
    });

    menu.append(mk('div', { className: 'pbn-lh-sep' }));
    const pick = mk('button', { type: 'button', className: 'pbn-lh-item', textContent: 'Pick messages to hide…' });
    pick.addEventListener('click', () => { closeHideMenu(); startPicking(); });
    const n = hiddenCount();
    const showAll = mk('button', { type: 'button', className: 'pbn-lh-item', textContent: `Show all hidden (${n})`, disabled: !n });
    showAll.addEventListener('click', () => {
      document.querySelectorAll(`${CHAT_SELECTOR} .pbn-hidden`).forEach(r => r.classList.remove('pbn-hidden'));
      HIDE_CATS.forEach(([k]) => document.body.classList.remove(`pbn-hide-cat-${k}`));
      closeHideMenu();
      refreshHideButton();
    });
    showAll.title = 'Also turns the filters above off';
    if (!n && HIDE_CATS.some(([k]) => document.body.classList.contains(`pbn-hide-cat-${k}`))) {
      showAll.disabled = false;
      showAll.textContent = 'Show everything';
    }
    menu.append(pick, showAll);

    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.min(Math.max(8, r.right - menu.offsetWidth), window.innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${r.bottom + 4}px`;
    hideMenu = menu;
    document.addEventListener('mousedown', onHideOutside, true);
    document.addEventListener('keydown', onHideMenuKey, true);
  }

  function ensureHide() {
    if (document.getElementById(HIDE_ID)) return;
    const after = document.getElementById(SEARCH_ID) || document.getElementById(BTN_ID);
    if (!after) return;
    const wrap = Object.assign(document.createElement('div'), { id: HIDE_ID });
    const toggle = Object.assign(document.createElement('button'), {
      type: 'button', className: 'pbn-ls-btn pbn-ls-toggle pbn-lh-toggle', textContent: 'Hide',
    });
    toggle.setAttribute('aria-haspopup', 'menu');
    toggle.addEventListener('mousedown', e => e.preventDefault());
    toggle.addEventListener('click', () => {
      if (picking()) { stopPicking(); return; }
      if (hideMenu) closeHideMenu();
      else openHideMenu(toggle);
    });
    wrap.append(toggle);
    after.before(wrap);
    refreshHideButton();
  }

  function resetHide() {
    if (tagObserver) { tagObserver.disconnect(); tagObserver = null; tagContainer = null; }
    stopPicking();
    closeHideMenu();
    HIDE_CATS.forEach(([k]) => document.body.classList.remove(`pbn-hide-cat-${k}`));
  }

  // --------------------------------------------------------------------------
  // Lifecycle. While on /play, a 1s tick keeps the hook pointed at the live
  // component (re-hooking if the page remounts without a URL change), falls
  // back to the DOM path if no component turns up, and re-adds the button if
  // the tab bar re-renders. `entries` are deliberately kept across leaving
  // and returning to /play — the log covers the whole tab session.
  // --------------------------------------------------------------------------

  let tick = null;
  let enteredAt = 0;

  function sync() {
    ensureButton();
    ensureSearch();
    ensureHide();
    tagWhispers();
    refreshHideButton();

    if (hooked && hooked.inst.isUnmounted) unhook();
    if (!hooked) {
      const inst = findPlayInstance();
      if (inst) {
        const wasFallback = !!observedContainer;
        stopDomFallback();
        hookInstance(inst, { backfill: !wasFallback });
      }
    }
    if (!hooked && Date.now() - enteredAt > FALLBACK_AFTER_MS) startDomFallback();

    // Hover text says which path is live, so a broken hook is easy to spot.
    const btn = document.getElementById(BTN_ID);
    if (btn) {
      const how = hooked ? 'recording from the game\'s RP message list'
        : observedContainer ? 'FALLBACK: recording from the chat on screen'
        : 'starting…';
      const title = `Download this session's chat as a text file (${entries.length} messages, ${how})`;
      if (btn.title !== title) btn.title = title;
    }
  }

  function enter() {
    enteredAt = Date.now();
    sync();
    tick = setInterval(sync, 1000);
  }

  function exit() {
    if (tick) { clearInterval(tick); tick = null; }
    unhook();
    stopDomFallback();
    clearHits();
    searchState = null;
    resetHide();
  }

  // Violentmonkey only evaluates @match on a real page load; this site's Vue
  // Router changes the URL via pushState without reloading the document.
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

  watchRoute(() => location.pathname === '/play', enter, exit);
})();
