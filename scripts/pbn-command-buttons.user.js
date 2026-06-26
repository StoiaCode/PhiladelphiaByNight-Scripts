// ==UserScript==
// @name         PbN Command Buttons
// @namespace    stoia.red
// @version      1.2.1
// @description  Adds quick-command buttons (/ooc /say /emote /pose ...) above the MUSH input box. Buttons are editable in-page via the userscript menu (no script editing needed).
// @match        https://philadelphiabynight.net/play
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-command-buttons.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-command-buttons.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ----------------------------------------------------------------------
  // CONFIG
  // ----------------------------------------------------------------------

  // Default commands, used on first run only. After that the live list is
  // read from userscript storage (GM_getValue) and can be edited in-page via
  // the userscript menu: Violentmonkey/Tampermonkey icon -> "Edit command
  // buttons". Edits persist across reloads and browser restarts.
  //
  // `label` is the button text, `cmd` is what gets pasted (a trailing space
  // is added automatically).
  // Firing modes (optional, mutually exclusive):
  //   submit: true  -> paste + Enter immediately (fire-and-forget, no arg)
  //   expand: true  -> 1st click opens an inline field, 2nd click sends
  //                    cmd + typed text. Fast double-click sends bare cmd.
  const DEFAULT_COMMANDS = [
    { label: 'OOC',     cmd: '/ooc'     },
    { label: 'LOOC',    cmd: '/looc'    },
    { label: 'Say',     cmd: '/say'     },
    { label: 'Emote',   cmd: '/emote'   },
    { label: 'Hide',    cmd: '/hide',            submit: true },
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
  // STORAGE (user-editable command list)
  // ----------------------------------------------------------------------

  const BAR_ID = 'pbn-cmd-bar';
  const EDITOR_ID = 'pbn-cmd-editor';
  const STORAGE_KEY = 'pbn_commands';

  // Validate a parsed command list before trusting it. Returns true only for
  // a non-empty array of {label, cmd} objects with sane optional flags.
  function validateCommands(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    return arr.every(c =>
      c && typeof c === 'object' &&
      typeof c.label === 'string' && c.label.trim() !== '' &&
      typeof c.cmd === 'string' && c.cmd.trim() !== '' &&
      (c.submit === undefined || typeof c.submit === 'boolean') &&
      (c.expand === undefined || typeof c.expand === 'boolean'));
  }

  function defaultsCopy() {
    return DEFAULT_COMMANDS.map(c => Object.assign({}, c));
  }

  // Read the stored list, falling back to defaults if absent/corrupt.
  function loadCommands() {
    try {
      if (typeof GM_getValue === 'function') {
        const raw = GM_getValue(STORAGE_KEY, '');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (validateCommands(parsed)) return parsed;
        }
      }
    } catch (e) { /* fall through to defaults */ }
    return defaultsCopy();
  }

  // Persist a (pre-validated) list and refresh derived state.
  function saveCommands(arr) {
    commands = arr;
    refreshKnownCmds();
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(STORAGE_KEY, JSON.stringify(arr));
      }
    } catch (e) { /* storage unavailable; live list still updates */ }
  }

  // Live command list + the set of known command prefixes (for swapping).
  let commands = loadCommands();
  let knownCmds = commands.map(c => c.cmd);
  function refreshKnownCmds() { knownCmds = commands.map(c => c.cmd); }

  // ----------------------------------------------------------------------
  // INTERNALS
  // ----------------------------------------------------------------------

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

    for (const { label, cmd, submit, expand } of commands) {
      const el = expand
        ? makeExpandButton(input, label, cmd)
        : makePlainButton(input, label, cmd, submit);
      bar.appendChild(el);
    }
    return bar;
  }

  function removeBar() {
    const existing = document.getElementById(BAR_ID);
    if (existing) existing.remove();
  }

  function mount() {
    const input = findInput();
    if (!input) return;

    const existing = document.getElementById(BAR_ID);
    // Re-mount if the bar is gone or detached from the current input's area.
    if (existing && existing.isConnected) return;
    removeBar();

    const bar = buildBar(input);
    // Place the bar just above the input's field container.
    const anchor = input.closest('.q-field') || input.parentElement || input;
    anchor.parentElement.insertBefore(bar, anchor);
  }

  // Rebuild the bar from the current command list (after an edit).
  function rerender() {
    removeBar();
    mount();
  }

  // ----------------------------------------------------------------------
  // SETTINGS EDITOR (opened from the userscript menu)
  // ----------------------------------------------------------------------

  function modalButton(text, primary) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.style.cssText = [
      'cursor:pointer', 'font:13px/1 inherit', 'padding:7px 14px',
      'border-radius:5px', 'border:1px solid rgba(255,255,255,0.25)',
      primary ? 'background:#3a6df0' : 'background:rgba(255,255,255,0.10)',
      'color:#fff', 'flex:0 0 auto',
    ].join(';');
    return b;
  }

  function openEditor() {
    if (document.getElementById(EDITOR_ID)) return; // already open

    const overlay = document.createElement('div');
    overlay.id = EDITOR_ID;
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:rgba(0,0,0,0.6)', 'font:13px/1.5 sans-serif',
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
      'width:min(560px,92vw)', 'max-height:85vh', 'overflow:auto',
      'box-sizing:border-box', 'padding:18px 20px',
      'border-radius:8px', 'border:1px solid rgba(255,255,255,0.2)',
      'background:#1e1e24', 'color:#eee',
      'box-shadow:0 8px 40px rgba(0,0,0,0.5)',
    ].join(';');

    const heading = document.createElement('div');
    heading.textContent = 'Edit command buttons';
    heading.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:8px;';

    const help = document.createElement('div');
    help.style.cssText = 'opacity:0.85;margin-bottom:10px;';
    help.innerHTML =
      'One entry per button. Each needs <code>"label"</code> (button text) and ' +
      '<code>"cmd"</code> (what gets pasted). Optional: <code>"submit": true</code> ' +
      'sends immediately, or <code>"expand": true</code> opens an input field first. ' +
      'Changes are saved permanently in your userscript manager.';

    const ta = document.createElement('textarea');
    ta.value = JSON.stringify(commands, null, 2);
    ta.spellcheck = false;
    ta.style.cssText = [
      'width:100%', 'box-sizing:border-box', 'height:300px',
      'resize:vertical', 'font:12px/1.45 monospace',
      'padding:8px', 'border-radius:6px',
      'border:1px solid rgba(255,255,255,0.25)',
      'background:#13131a', 'color:#eee', 'white-space:pre',
    ].join(';');

    const msg = document.createElement('div');
    msg.style.cssText = 'min-height:18px;margin:8px 0;white-space:pre-wrap;';

    function showError(text) { msg.style.color = '#ff8080'; msg.textContent = text; }
    function showInfo(text) { msg.style.color = '#8fdc8f'; msg.textContent = text; }

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;';

    const resetBtn = modalButton('Reset to defaults', false);
    const spacer = document.createElement('div');
    spacer.style.cssText = 'flex:1 1 auto;';
    const cancelBtn = modalButton('Cancel', false);
    const saveBtn = modalButton('Save', true);

    function close() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }

    function doSave() {
      let parsed;
      try {
        parsed = JSON.parse(ta.value);
      } catch (e) {
        showError('Invalid JSON: ' + e.message);
        return;
      }
      if (!validateCommands(parsed)) {
        showError('Each entry needs a non-empty "label" and "cmd". ' +
                  '"submit"/"expand" must be true or false if present.');
        return;
      }
      saveCommands(parsed);
      rerender();
      close();
    }

    resetBtn.addEventListener('click', () => {
      ta.value = JSON.stringify(defaultsCopy(), null, 2);
      showInfo('Defaults loaded — click Save to apply.');
    });
    cancelBtn.addEventListener('click', close);
    saveBtn.addEventListener('click', doSave);

    // Click on the dimmed backdrop (but not the panel) closes without saving.
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    document.addEventListener('keydown', onKey, true);

    row.appendChild(resetBtn);
    row.appendChild(spacer);
    row.appendChild(cancelBtn);
    row.appendChild(saveBtn);

    panel.appendChild(heading);
    panel.appendChild(help);
    panel.appendChild(ta);
    panel.appendChild(msg);
    panel.appendChild(row);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    ta.focus();
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Edit command buttons', openEditor);
  }

  // SPA: the input mounts/unmounts on navigation, so keep checking.
  const observer = new MutationObserver(() => mount());
  observer.observe(document.body, { childList: true, subtree: true });

  mount();
})();
