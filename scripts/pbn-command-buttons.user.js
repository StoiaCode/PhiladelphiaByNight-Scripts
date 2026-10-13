// ==UserScript==
// @name         PbN Command Buttons
// @namespace    stoia.red
// @version      1.4.0
// @description  Adds quick-command buttons (/ooc /say /emote /pose ...) above the MUSH input box. Buttons are editable in-page via the userscript menu (no script editing needed).
// @match        https://philadelphiabynight.net/*
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

  // Per-character lists. STORAGE_KEY keeps the shared list (the only list
  // before per-character support, so existing setups carry over untouched);
  // BY_CHAR_KEY maps a character name to that character's own list. A
  // character without an own list uses the shared one.
  const BY_CHAR_KEY = 'pbn_commands_by_char';

  function gmGet(key) {
    try { return typeof GM_getValue === 'function' ? GM_getValue(key, '') : ''; }
    catch (e) { return ''; }
  }

  function gmSet(key, value) {
    try { if (typeof GM_setValue === 'function') GM_setValue(key, value); }
    catch (e) { /* storage unavailable; live list still updates */ }
  }

  // Read the shared list, falling back to defaults if absent/corrupt.
  function loadShared() {
    try {
      const raw = gmGet(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (validateCommands(parsed)) return parsed;
      }
    } catch (e) { /* fall through to defaults */ }
    return defaultsCopy();
  }

  function saveShared(arr) { gmSet(STORAGE_KEY, JSON.stringify(arr)); }

  function loadByChar() {
    try { return JSON.parse(gmGet(BY_CHAR_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }

  function saveByChar(map) { gmSet(BY_CHAR_KEY, JSON.stringify(map)); }

  function ownList(name) {
    const own = name ? loadByChar()[name] : null;
    return validateCommands(own) ? own : null;
  }

  // The list a character actually uses.
  function commandsFor(name) { return ownList(name) || loadShared(); }

  // Active character, from the journal sidebar title ("Vergil's Journal").
  // Plain DOM text, so it works whether or not the userscript manager runs
  // this script in a sandbox. null when not known (yet).
  function getCharName() {
    const m = document.querySelector('.journal-title')?.textContent.trim().match(/^(.+?)['’]s Journal$/);
    return m ? m[1] : null;
  }

  // Live command list + the set of known command prefixes (for swapping).
  let commands = loadShared();
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

  // ----------------------------------------------------------------------
  // STYLES — palette from the play page's own stylesheet: buttons follow
  // its .tab-toggle (Courier, muted gold on dark red), the editor follows
  // the chat panel's dark-red framing. Injected once and kept for the life
  // of the page, since the editor can be opened from any route.
  // ----------------------------------------------------------------------

  const style = document.createElement('style');
  style.textContent = `
    #${BAR_ID} { display: flex; flex-wrap: wrap; gap: 5px; padding: 6px 4px; align-items: center; }
    /* Georgia (the site's card font) instead of the tab-toggle's Courier:
       proportional, so a dozen+ buttons fit in far less width, and easier
       to read at a glance. */
    .pbn-cmd-btn {
      flex: 0 0 auto; cursor: pointer; padding: 4px 10px;
      background: #120a0a; border: 1px solid #9e2b2b80; border-radius: 5px;
      font-family: Georgia, 'Times New Roman', serif; font-size: .95rem; line-height: 1.3;
      color: #c4b49a; transition: background .12s, color .12s;
    }
    .pbn-cmd-btn:hover { color: #e8dcc0; background: #5a121233; }
    .pbn-cmd-btn:focus-visible { outline: 2px solid #e0b84a; outline-offset: -2px; }
    .pbn-cmd-btn:active,
    .pbn-cmd-btn--open { color: #f3e6cf; background: #9e2b2b; }
    .pbn-cmd-btn--primary { color: #f3e6cf; background: #9e2b2b; border-color: #9e2b2b; }
    .pbn-cmd-btn--primary:hover { color: #fff; background: #b33434; }
    .pbn-cmd-expand { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; }
    .pbn-cmd-field {
      width: 200px; padding: 4px 8px;
      background: #0d0707; border: 1px solid #9e2b2b80; border-radius: 5px;
      font-family: Georgia, 'Times New Roman', serif; font-size: .95rem; line-height: 1.3; color: #e8dcc0;
    }
    .pbn-cmd-field:focus { outline: none; border-color: #e0b84a; }

    #${EDITOR_ID} {
      position: fixed; inset: 0; z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.65); font: 15px/1.5 Georgia, 'Times New Roman', serif;
    }
    .pbn-cmd-editor__panel {
      width: min(600px, 92vw); max-height: 85vh; overflow: auto;
      box-sizing: border-box; padding: 20px 22px;
      background: #120a0a; color: #e8ddd0;
      border: 1px solid #5a1212; border-radius: 6px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.6);
    }
    .pbn-cmd-editor__heading {
      font-family: TMUnicorn, serif; font-size: 1.3rem; letter-spacing: .5px;
      color: #e8ddd0; margin-bottom: 10px;
    }
    .pbn-cmd-editor__scope {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px;
      margin-bottom: 6px; font-size: 1rem; color: #e8ddd0;
    }
    .pbn-cmd-editor__scope label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: #c4b49a; }
    .pbn-cmd-editor__scope label:has(input:checked) { color: #f3e6cf; }
    .pbn-cmd-editor__scope input { accent-color: #9e2b2b; width: 16px; height: 16px; margin: 0; }
    .pbn-cmd-editor__note { color: #9a8a7a; font-style: italic; font-size: .95rem; margin-bottom: 12px; }
    .pbn-cmd-editor__help { color: #c4b49a; margin-bottom: 12px; }
    .pbn-cmd-editor__help code { color: #e0b84a; }
    .pbn-cmd-editor__json {
      width: 100%; box-sizing: border-box; height: 300px; resize: vertical;
      padding: 10px; white-space: pre;
      font: 14px/1.45 'Courier New', monospace; color: #e8dcc0;
      background: #0d0707; border: 1px solid #5a1212; border-radius: 4px;
    }
    .pbn-cmd-editor__json:focus { outline: none; border-color: #9e2b2b; }
    .pbn-cmd-editor__msg { min-height: 20px; margin: 8px 0; white-space: pre-wrap; }
    .pbn-cmd-editor__row { display: flex; gap: 8px; align-items: center; }
  `;
  document.head.appendChild(style);

  function makeButton(label, cmd) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pbn-cmd-btn';
    btn.textContent = label;
    btn.title = cmd;
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
    wrap.className = 'pbn-cmd-expand';

    const btn = makeButton(label, cmd);

    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'pbn-cmd-field';
    field.placeholder = `${cmd} …`;
    field.style.display = 'none';

    let expanded = false;

    function collapse() {
      expanded = false;
      btn.classList.remove('pbn-cmd-btn--open');
      field.style.display = 'none';
      field.value = '';
    }
    function expand() {
      expanded = true;
      btn.classList.add('pbn-cmd-btn--open');
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

  // Character the current bar was built for (undefined = no bar yet).
  let barChar;

  function mount() {
    const input = findInput();
    if (!input) return;

    const name = getCharName();
    const existing = document.getElementById(BAR_ID);
    // Re-mount if the bar is gone, detached from the current input's area,
    // or was built for a different character (the name can also arrive a
    // moment after the bar first mounts).
    if (existing && existing.isConnected && name === barChar) return;
    removeBar();

    barChar = name;
    commands = commandsFor(name);
    refreshKnownCmds();
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
    b.className = primary ? 'pbn-cmd-btn pbn-cmd-btn--primary' : 'pbn-cmd-btn';
    return b;
  }

  function openEditor() {
    if (document.getElementById(EDITOR_ID)) return; // already open

    const overlay = document.createElement('div');
    overlay.id = EDITOR_ID;

    const panel = document.createElement('div');
    panel.className = 'pbn-cmd-editor__panel';

    // Which list is being edited. With a known character the editor edits
    // the list that character uses: its own, or the shared one. Choosing
    // "the shared list" for a character that had its own list deletes that
    // own list on save.
    const name = getCharName();
    const hadOwn = !!ownList(name);
    let scope = hadOwn ? 'own' : 'shared';
    const drafts = {
      shared: JSON.stringify(loadShared(), null, 2),
      own: JSON.stringify(ownList(name) || loadShared(), null, 2),
    };

    const heading = document.createElement('div');
    heading.className = 'pbn-cmd-editor__heading';
    heading.textContent = name ? `Edit command buttons — ${name}` : 'Edit command buttons';

    const scopeRow = document.createElement('div');
    scopeRow.className = 'pbn-cmd-editor__scope';
    const note = document.createElement('div');
    note.className = 'pbn-cmd-editor__note';

    function renderNote() {
      if (!name) {
        note.textContent = 'No character detected, so this edits the shared list used by every character. ' +
          'Open it from the play page to give a character its own buttons.';
      } else if (scope === 'shared') {
        note.textContent = hadOwn
          ? `Saving deletes ${name}'s own list, and ${name} goes back to the shared list. ` +
            'Edits apply to every character using the shared list.'
          : 'Edits apply to every character using the shared list.';
      } else {
        note.textContent = hadOwn
          ? `Only ${name} sees these buttons.`
          : `Starts as a copy of the shared list. Only ${name} will see these buttons.`;
      }
    }

    const ta = document.createElement('textarea');
    ta.value = drafts[scope];
    ta.spellcheck = false;
    ta.className = 'pbn-cmd-editor__json';

    if (name) {
      scopeRow.append(document.createTextNode(`${name} uses:`));
      [['shared', 'the shared list'], ['own', 'its own list']].forEach(([value, text]) => {
        const label = document.createElement('label');
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'pbn-cmd-scope';
        radio.value = value;
        radio.checked = value === scope;
        radio.addEventListener('change', () => {
          drafts[scope] = ta.value; // keep unsaved edits per list while switching
          scope = value;
          ta.value = drafts[scope];
          renderNote();
        });
        label.append(radio, document.createTextNode(text));
        scopeRow.appendChild(label);
      });
    }
    renderNote();

    const help = document.createElement('div');
    help.className = 'pbn-cmd-editor__help';
    help.innerHTML =
      'One entry per button. Each needs <code>"label"</code> (button text) and ' +
      '<code>"cmd"</code> (what gets pasted). Optional: <code>"submit": true</code> ' +
      'sends immediately, or <code>"expand": true</code> opens an input field first. ' +
      'Changes are saved permanently in your userscript manager.';

    const msg = document.createElement('div');
    msg.className = 'pbn-cmd-editor__msg';

    function showError(text) { msg.style.color = '#f0906a'; msg.textContent = text; }
    function showInfo(text) { msg.style.color = '#6bdb7e'; msg.textContent = text; }

    const row = document.createElement('div');
    row.className = 'pbn-cmd-editor__row';

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
      if (name && scope === 'own') {
        const map = loadByChar();
        map[name] = parsed;
        saveByChar(map);
      } else {
        saveShared(parsed);
        if (name && hadOwn) {
          const map = loadByChar();
          delete map[name];
          saveByChar(map);
        }
      }
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
    if (name) panel.appendChild(scopeRow);
    panel.appendChild(note);
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

  // Violentmonkey only evaluates @match on a real page load; this site's Vue
  // Router changes the URL via pushState without reloading the document, so
  // without this the observer below would keep scanning the whole document
  // for a text input (and could inject the bar next to the wrong one) on
  // every other page the user navigates to within the SPA session.
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

  let observer = null;
  function enter() {
    if (observer) return;
    // SPA: the input mounts/unmounts on navigation, so keep checking.
    observer = new MutationObserver(() => mount());
    observer.observe(document.body, { childList: true, subtree: true });
    mount();
  }
  function exit() {
    if (observer) { observer.disconnect(); observer = null; }
    removeBar();
  }
  watchRoute(() => location.pathname === '/play', enter, exit);
})();
