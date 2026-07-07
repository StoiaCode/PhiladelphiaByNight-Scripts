// ==UserScript==
// @name         PbN Typing Indicator De-Shift
// @namespace    stoia.red
// @version      1.3.0
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
         z-index: 9999 !important;
         pointer-events: none !important;
         white-space: nowrap !important;
         font-family: system-ui, ui-sans-serif, sans-serif !important;
         font-style: normal !important;
         font-size: 13px !important;
         font-weight: 600 !important;
         line-height: 1.4 !important;
         letter-spacing: 0.01em !important;
         color: #ffffff !important;
         text-shadow: 0 1px 3px rgba(0,0,0,0.9) !important;
         background: rgba(0,0,0,0.55) !important;
         padding: 2px 8px !important;
         border-radius: 4px !important;
         opacity: 1 !important;
       }`;
  document.head.appendChild(style);

  if (HIDE_ENTIRELY) return;

  // Applied as inline styles so they beat any site stylesheet rule regardless
  // of specificity — inline always wins.
  function applyStyles(tip) {
    const s = tip.style;
    s.fontFamily     = 'system-ui, ui-sans-serif, sans-serif';
    s.fontStyle      = 'normal';
    s.fontSize       = '13px';
    s.fontWeight     = '600';
    s.lineHeight     = '1.4';
    s.letterSpacing  = '0.01em';
    s.color          = '#ffffff';
    s.textShadow     = '0 1px 3px rgba(0,0,0,0.9)';
    s.background     = 'rgba(0,0,0,0.55)';
    s.padding        = '2px 8px';
    s.borderRadius   = '4px';
    s.opacity        = '1';
    s.whiteSpace     = 'nowrap';
    s.pointerEvents  = 'none';
    s.zIndex         = '9999';
  }

  function reposition() {
    const tip = document.querySelector(TYPING_SELECTOR);
    const input = document.querySelector(INPUT_SELECTOR);
    if (!tip || !input) return;
    applyStyles(tip);
    // Anchor to the whole control row, not just the textarea.
    const anchor = input.closest('.q-field__control') || input;
    const r = anchor.getBoundingClientRect();
    // Right-align with the control row; pin bottom edge GAP px above its top.
    tip.style.position = 'fixed';
    tip.style.left     = 'auto';
    tip.style.top      = 'auto';
    tip.style.right    = `${Math.round(window.innerWidth - r.right)}px`;
    tip.style.bottom   = `${Math.round(window.innerHeight - r.top + GAP)}px`;
  }

  // The span is created/destroyed dynamically, so watch for it and reposition
  // on anything that can move the input.
  const observer = new MutationObserver(reposition);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  setInterval(reposition, 250); // cheap safety net for missed layout changes
})();
