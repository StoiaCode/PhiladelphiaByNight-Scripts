// ==UserScript==
// @name         PbN Layout Lock
// @namespace    stoia.red
// @version      1.0.0
// @description  Locks the play page to viewport height — the chat box shrinks to fit, no page-level scrollbar.
// @match        https://philadelphiabynight.net/play
// @run-at       document-idle
// @grant        none
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-layout-lock.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-layout-lock.user.js
// ==/UserScript==

(function () {
  'use strict';

  // Quasar sets min-height on .q-layout and main.q-page via inline styles based
  // on content size, which makes the page taller than the viewport and forces a
  // page-level scrollbar. CSS !important in a stylesheet beats inline styles that
  // lack !important, so we can override them without a JS fight.

  const style = document.createElement('style');
  style.textContent = `
    /* Prevent body-level scroll */
    body { overflow: hidden !important; }

    /* Clamp the layout shell to the viewport */
    #q-app,
    .q-layout {
      height: 100vh !important;
      min-height: 0 !important;
      overflow: hidden !important;
    }

    /* Page container fills the shell.
       Its padding-top/bottom (set by Quasar) already offsets the fixed header and footer. */
    .q-page-container {
      height: 100% !important;
      overflow: hidden !important;
      box-sizing: border-box !important;
    }

    /* Page fills the container; kill Quasar's JS-computed min-height */
    main.q-page {
      height: 100% !important;
      min-height: 0 !important;
      overflow: hidden !important;
      align-items: stretch !important;
    }

    /* Left column: vertical flex so the chat log can grow and shrink */
    main.q-page > .col-md-8 {
      display: flex !important;
      flex-direction: column !important;
      height: 100% !important;
      min-height: 0 !important;
      overflow: hidden !important;
    }

    /* Tab bar and presence bar stay at their natural height */
    .chat-tab-bar,
    .room-presence-bar {
      flex: 0 0 auto !important;
    }

    /* Chat log fills whatever is left and scrolls internally */
    .chat-container {
      flex: 1 1 0 !important;
      min-height: 0 !important;
      overflow-y: auto !important;
    }

    /* Command bar / input row is pinned at the bottom */
    main.q-page > .col-md-8 > .q-mt-md {
      flex: 0 0 auto !important;
    }

    /* Right column scrolls internally — its content size never affects the left side */
    main.q-page > .col-md-4 {
      height: 100% !important;
      min-height: 0 !important;
      overflow-y: auto !important;
    }
  `;
  document.head.appendChild(style);
})();
