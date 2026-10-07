// ==UserScript==
// @name         PbN Chat Log
// @namespace    stoia.red
// @version      1.1.1
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
