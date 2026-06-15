// ==UserScript==
// @name         PbN Typing Indicator De-Shift
// @namespace    stoia.red
// @version      1.0.0
// @description  Stops the "X is typing" indicator from nudging the command input. Floats it above the box instead.
// @match        https://philadelphiabynight.net/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-typing-indicator-deshift.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-typing-indicator-deshift.user.js
// ==/UserScript==

(function () {
  'use strict';

  // true  -> hide the indicator entirely (simplest, zero shift, lose the cue)
  // false -> keep it visible but float it so it never moves the input
  const HIDE_ENTIRELY = false;

  // Gap between the indicator and the top of the input, in px.
  const GAP = 4;

  const TYPING_SELECTOR = '.typing-indicator';
  const INPUT_SELECTOR  = 'textarea.q-field__native';

  const style = document.createElement('style');
  style.textContent = HIDE_ENTIRELY
    ? `${TYPING_SELECTOR}{display:none !important;}`
    : `${TYPING_SELECTOR}{
         position: fixed !important;
         z-index: 9999;
         pointer-events: none;
         white-space: nowrap;
         opacity: 0.85;
       }`;
  document.head.appendChild(style);

  if (HIDE_ENTIRELY) return;

  function reposition() {
    const tip = document.querySelector(TYPING_SELECTOR);
    const input = document.querySelector(INPUT_SELECTOR);
    if (!tip || !input) return;
    // Anchor to the whole control row, not just the textarea.
    const anchor = input.closest('.q-field__control') || input;
    const r = anchor.getBoundingClientRect();
    // Right-align with the control row; pin bottom edge GAP px above its top.
    tip.style.left   = 'auto';
    tip.style.top    = 'auto';
    tip.style.right  = `${Math.round(window.innerWidth - r.right)}px`;
    tip.style.bottom = `${Math.round(window.innerHeight - r.top + GAP)}px`;
  }

  // The span is created/destroyed dynamically, so watch for it and reposition
  // on anything that can move the input.
  const observer = new MutationObserver(reposition);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  setInterval(reposition, 250); // cheap safety net for missed layout changes
})();
