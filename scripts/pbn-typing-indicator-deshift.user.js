// ==UserScript==
// @name         PbN Typing Indicator De-Shift
// @namespace    stoia.red
// @version      1.5.0
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

  if (HIDE_ENTIRELY) {
    const s = document.createElement('style');
    s.textContent = `${TYPING_SELECTOR}{display:none !important;}`;
    document.head.appendChild(s);
    return;
  }

  // Inline styles beat any stylesheet rule regardless of specificity.
  // Applied to the element AND every descendant because Vue scoped CSS targets
  // the inner spans directly, overriding inherited values from the parent.
  function applyStyles(tip) {
    const shared = {
      fontFamily:    'system-ui, ui-sans-serif, sans-serif',
      fontStyle:     'normal',
      fontSize:      '13px',
      fontWeight:    '600',
      lineHeight:    '1.4',
      letterSpacing: '0.01em',
    };
    Object.assign(tip.style, shared, {
      position:     'fixed',
      zIndex:       '9999',
      pointerEvents:'none',
      whiteSpace:   'nowrap',
      color:        '#ffffff',
      textShadow:   '0 1px 3px rgba(0,0,0,0.9)',
      background:   'rgba(0,0,0,0.55)',
      padding:      '2px 8px',
      borderRadius: '4px',
      opacity:      '1',
    });
    tip.querySelectorAll('*').forEach(el => Object.assign(el.style, shared));
  }

  function reposition() {
    const tip = document.querySelector(TYPING_SELECTOR);
    const input = document.querySelector(INPUT_SELECTOR);
    if (!tip || !input) return;
    applyStyles(tip);
    const anchor = input.closest('.q-field__control') || input;
    const r = anchor.getBoundingClientRect();
    // Right-align with the control row; pin bottom edge GAP px above its top.
    tip.style.left   = 'auto';
    tip.style.top    = 'auto';
    tip.style.right  = `${Math.round(window.innerWidth - r.right)}px`;
    tip.style.bottom = `${Math.round(window.innerHeight - r.top + GAP)}px`;
  }

  // The element is created/destroyed dynamically, so watch for it and
  // reposition on anything that can move the input.
  const observer = new MutationObserver(reposition);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  setInterval(reposition, 250); // safety net for missed layout changes
})();
