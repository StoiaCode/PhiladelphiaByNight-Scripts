// ==UserScript==
// @name         PbN Command Buttons
// @namespace    stoia.red
// @version      1.1.0
// @description  Adds quick-command buttons (/ooc /say /emote /pose ...) above the MUSH input box.
// @match        https://philadelphiabynight.net/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-command-buttons.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-command-buttons.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ----------------------------------------------------------------------
  // CONFIG
  // ----------------------------------------------------------------------

  // The commands to expose. `label` is the button text, `cmd` is what gets
  // pasted (a trailing space is added automatically). Add/remove freely.
  // Firing modes (optional, mutually exclusive):
  //   submit: true  -> paste + Enter immediately (fire-and-forget, no arg)
  //   expand: true  -> 1st click opens an inline field, 2nd click sends
  //                    cmd + typed text. Fast double-click sends bare cmd.
  const COMMANDS = [
    { label: 'OOC',     cmd: '/ooc'     },
    { label: 'LOOC',    cmd: '/looc'    },
    { label: 'Say',     cmd: '/say'     },
    { label: 'Emote',   cmd: '/emote'   },
    { label: 'Hide',    cmd: '/hide'    },
    { label: 'Look',    cmd: '/look',            expand: true },
    { label: 'Auspex',  cmd: '/auspex heighten', submit: true },
    { label: 'News',    cmd: '/news',            expand: true },
    { label: 'SetDesc', cmd: '/setdesc',         submit: true },
    { label: 'Char',    cmd: '/char',            submit: true },
    { label: 'Roll',    cmd: '/roll',            submit: true },
    { label: 'Journal', cmd: '/journal',         submit: true },
  ];

  // Leave '' for auto-detection. If auto picks the wrong field, inspect the
  // command box in devtools and put a CSS selector here, e.g.
  //   '.q-field textarea' or 'textarea[aria-label="Command"]'
  const INPUT_SELECTOR = '';

  // If true, clicking a button swaps an existing leading command instead of
  // stacking (so /say -> /emote replaces, not "/emote /say ...").
  const SWAP_LEADING_COMMAND = true;

  // ----------------------------------------------------------------------
  // INTERNALS
  // ----------------------------------------------------------------------

  const BAR_ID = 'pbn-cmd-bar';
  const knownCmds = COMMANDS.map(c => c.cmd);

  // Set a value on a native input/textarea so Vue's v-model notices it.
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }

  // Find the command input. Explicit selector wins; otherwise heuristic:
  // prefer textareas, else text inputs; among visible candidates pick the
  // one closest to the bottom of the viewport (MUSH command line lives there).
  function findInput() {
    if (INPUT_SELECTOR) {
      const el = document.querySelector(INPUT_SELECTOR);
      return isVisible(el) ? el : null;
    }
    const pools = [
      Array.from(document.querySelectorAll('textarea')),
      Array.from(document.querySelectorAll('input[type="text"], input:not([type])')),
    ];
    for (const pool of pools) {
      const visible = pool.filter(isVisible);
      if (visible.length) {
        visible.sort((a, b) =>
          b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
        return visible[0];
      }
    }
    return null;
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // `arg` (optional): when provided, it's used as the command argument
  // verbatim instead of reusing whatever is already in the input box.
  function applyCommand(input, cmd, submit, arg) {
    let text;

    if (arg !== undefined) {
      text = arg.trim();
    } else {
      text = input.value;
      if (SWAP_LEADING_COMMAND) {
        for (const c of knownCmds) {
          if (text === c || text.startsWith(c + ' ')) {
            text = text.slice(c.length).replace(/^\s+/, '');
            break;
          }
        }
      }
    }

    const next = text ? `${cmd} ${text}` : `${cmd} `;
    setNativeValue(input, next);
    input.focus();
    try { input.setSelectionRange(next.length, next.length); } catch (e) {}

    if (submit) {
      // Let the input event settle before sending Enter.
      setTimeout(() => pressEnter(input), 0);
    }
  }

  function makeButton(label, cmd) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = cmd;
    btn.style.cssText = [
      'cursor:pointer', 'font:12px/1.4 inherit',
      'padding:4px 10px', 'border-radius:4px',
      'border:1px solid rgba(255,255,255,0.25)',
      'background:rgba(255,255,255,0.06)', 'color:inherit',
      'flex:0 0 auto',
    ].join(';');
    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'rgba(255,255,255,0.14)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'rgba(255,255,255,0.06)';
    });
    // mousedown + preventDefault keeps focus off the button.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    return btn;
  }

  // Plain button: paste (and optionally submit) on click.
  function makePlainButton(input, label, cmd, submit) {
    const btn = makeButton(label, cmd);
    btn.addEventListener('click', () => applyCommand(input, cmd, submit));
    return btn;
  }

  // Expand button: click 1 opens an inline field to the right (button stays
  // put, so a fast double-click lands on it twice); click 2 sends cmd + text.
  function makeExpandButton(input, label, cmd) {
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;';

    const btn = makeButton(label, cmd);

    const field = document.createElement('input');
    field.type = 'text';
    field.placeholder = `${cmd} …`;
    field.style.cssText = [
      'display:none', 'font:12px/1.4 inherit', 'padding:3px 6px',
      'border-radius:4px', 'border:1px solid rgba(255,255,255,0.25)',
      'background:rgba(0,0,0,0.30)', 'color:inherit', 'width:180px',
    ].join(';');

    let expanded = false;

    function collapse() {
      expanded = false;
      field.style.display = 'none';
      field.value = '';
    }
    function expand() {
      expanded = true;
      field.style.display = '';
      field.focus();
    }
    function send() {
      applyCommand(input, cmd, true, field.value);
      collapse();
    }

    btn.addEventListener('click', () => (expanded ? send() : expand()));

    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
      else if (e.key === 'Escape') { e.preventDefault(); collapse(); input.focus(); }
    });

    // Click anywhere outside cancels without sending.
    document.addEventListener('mousedown', (e) => {
      if (expanded && !wrap.contains(e.target)) collapse();
    });

    wrap.appendChild(btn);
    wrap.appendChild(field);
    return wrap;
  }

  function buildBar(input) {
    const bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.style.cssText = [
      'display:flex', 'flex-wrap:wrap', 'gap:6px',
      'padding:6px 4px', 'align-items:center',
    ].join(';');

    for (const { label, cmd, submit, expand } of COMMANDS) {
      const el = expand
        ? makeExpandButton(input, label, cmd)
        : makePlainButton(input, label, cmd, submit);
      bar.appendChild(el);
    }
    return bar;
  }

  function mount() {
    const input = findInput();
    if (!input) return;

    const existing = document.getElementById(BAR_ID);
    // Re-mount if the bar is gone or detached from the current input's area.
    if (existing && existing.isConnected) return;

    const bar = buildBar(input);
    // Place the bar just above the input's field container.
    const anchor = input.closest('.q-field') || input.parentElement || input;
    anchor.parentElement.insertBefore(bar, anchor);
  }

  // SPA: the input mounts/unmounts on navigation, so keep checking.
  const observer = new MutationObserver(() => mount());
  observer.observe(document.body, { childList: true, subtree: true });

  mount();
})();
