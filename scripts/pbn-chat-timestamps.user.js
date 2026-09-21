// ==UserScript==
// @name         PbN Chat Timestamps
// @namespace    stoia.red
// @version      1.0.0
// @description  Shows an HH:MM timestamp in front of every chat message, in the chat's own font.
// @match        https://philadelphiabynight.net/play
// @run-at       document-idle
// @grant        none
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-chat-timestamps.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-chat-timestamps.user.js
// ==/UserScript==

(function () {
  'use strict';

  const CHAT_SELECTOR    = '.chat-container';
  const ARTICLE_SELECTOR = '[role="article"]';
  const TS_ATTR          = 'data-pbn-ts';

  // Rendered as a ::before pseudo-element rather than a real inserted node.
  // Generated content inherits the surrounding font/color automatically
  // (no explicit styling needed to "use the chat font"), and — unlike a
  // real DOM node — it's invisible to .innerText/.textContent, so it can
  // never end up duplicated inside pbn-chat-log's exported session file.
  const style = document.createElement('style');
  style.textContent = `
    ${CHAT_SELECTOR} ${ARTICLE_SELECTOR}[${TS_ATTR}]::before {
      content: "[" attr(${TS_ATTR}) "] ";
      opacity: 0.55;
    }
  `;
  style.disabled = true;
  document.head.appendChild(style);

  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtTime(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

  function stamp(el, ts) {
    if (el.hasAttribute(TS_ATTR)) return;
    el.setAttribute(TS_ATTR, fmtTime(ts || new Date()));
  }

  let chatObserver = null;
  let waiter = null;

  function mount() {
    const container = document.querySelector(CHAT_SELECTOR);
    if (!container) return false;

    // Messages already on screen have no known arrival time — stamp them
    // with "now" as the best available guess, the same trade-off
    // pbn-chat-log makes for its own backfill.
    const now = new Date();
    container.querySelectorAll(ARTICLE_SELECTOR).forEach(el => stamp(el, now));

    chatObserver = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches(ARTICLE_SELECTOR)) stamp(node);
          else node.querySelectorAll(ARTICLE_SELECTOR).forEach(el => stamp(el));
        }
      }
    });
    chatObserver.observe(container, { childList: true, subtree: true });

    style.disabled = false;
    return true;
  }

  // Violentmonkey only evaluates @match on a real page load; this site's Vue
  // Router changes the URL via pushState without reloading the document, so
  // without this the observer above would keep a handle on a detached
  // .chat-container once the user navigates away from /play.
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

  function enter() {
    if (mount()) return;
    waiter = new MutationObserver(() => { if (mount()) { waiter.disconnect(); waiter = null; } });
    waiter.observe(document.body, { childList: true, subtree: true });
  }

  function exit() {
    if (waiter) { waiter.disconnect(); waiter = null; }
    if (chatObserver) { chatObserver.disconnect(); chatObserver = null; }
    style.disabled = true;
  }

  watchRoute(() => location.pathname === '/play', enter, exit);
})();
