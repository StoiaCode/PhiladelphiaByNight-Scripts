// ==UserScript==
// @name         PbN Typing Indicator De-Shift
// @namespace    stoia.red
// @version      1.6.0
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

  // Violentmonkey only evaluates @match on a real page load; this site's Vue
  // Router changes the URL via pushState without reloading the document, so
  // without this the code below would keep polling/observing every page of
  // the site instead of just /play (harmless in effect since the selectors
  // above only exist on /play, but wasteful).
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

  if (HIDE_ENTIRELY) {
    const s = document.createElement('style');
    s.textContent = `${TYPING_SELECTOR}{display:none !important;}`;
    s.disabled = true;
    document.head.appendChild(s);
    watchRoute(
      () => location.pathname === '/play',
      () => { s.disabled = false; },
      () => { s.disabled = true; }
    );
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
  let intervalId = null;

  function enter() {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    intervalId = setInterval(reposition, 250); // safety net for missed layout changes
    reposition();
  }
  function exit() {
    observer.disconnect();
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
  }
  watchRoute(() => location.pathname === '/play', enter, exit);
})();
