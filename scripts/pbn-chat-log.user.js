// ==UserScript==
// @name         PbN Chat Log
// @namespace    stoia.red
// @version      1.0.0
// @description  Captures chat messages to memory as they arrive and saves the session as a plain-text file on demand.
// @match        https://philadelphiabynight.net/play
// @run-at       document-idle
// @grant        none
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-chat-log.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-chat-log.user.js
// ==/UserScript==

(function () {
  'use strict';

  const CHAT_SELECTOR    = '.chat-container';
  const ARTICLE_SELECTOR = '[role="article"]';
  const BTN_ID           = 'pbn-log-btn';

  const sessionStart = new Date();
  const entries = []; // { ts: Date, text: string }[]
  const seen = new WeakSet();

  function pad(n) { return String(n).padStart(2, '0'); }

  function fmtDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function fmtTime(d) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function fmtTs(d) { return `${fmtDate(d)} ${fmtTime(d)}`; }

  function capture(el, ts) {
    if (seen.has(el)) return;
    seen.add(el);
    const text = (el.innerText || '').trim().replace(/\s+/g, ' ');
    if (text) entries.push({ ts: ts || new Date(), text });
  }

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

  function addButton(tabBar) {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement('button');
    btn.id          = BTN_ID;
    btn.textContent = 'Save Log';
    btn.title       = 'Download this session\'s chat as a text file';
    btn.style.cssText = [
      'cursor:pointer', 'font:12px/1.4 inherit',
      'padding:3px 8px', 'border-radius:4px',
      'border:1px solid rgba(255,255,255,0.25)',
      'background:rgba(255,255,255,0.06)', 'color:inherit',
      'margin-left:auto', 'flex-shrink:0',
    ].join(';');
    btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(255,255,255,0.14)');
    btn.addEventListener('mouseleave', () => btn.style.background = 'rgba(255,255,255,0.06)');
    btn.addEventListener('mousedown',  e => e.preventDefault());
    btn.addEventListener('click', saveLog);
    tabBar.appendChild(btn);
  }

  function mount() {
    const container = document.querySelector(CHAT_SELECTOR);
    const tabBar    = document.querySelector('.chat-tab-bar');
    if (!container || !tabBar) return false;

    // Backfill messages already in the DOM at script load time.
    // They all get the session-start timestamp since we don't know when they arrived.
    container.querySelectorAll(ARTICLE_SELECTOR).forEach(el => capture(el, sessionStart));

    // Watch for new messages and timestamp them on arrival.
    new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches(ARTICLE_SELECTOR)) capture(node);
          else node.querySelectorAll(ARTICLE_SELECTOR).forEach(el => capture(el));
        }
      }
    }).observe(container, { childList: true, subtree: true });

    addButton(tabBar);
    return true;
  }

  // SPA: the chat container may not exist yet at document-idle.
  if (!mount()) {
    const waiter = new MutationObserver(() => { if (mount()) waiter.disconnect(); });
    waiter.observe(document.body, { childList: true, subtree: true });
  }
})();
