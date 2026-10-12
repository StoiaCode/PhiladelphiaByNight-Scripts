// ==UserScript==
// @name         PbN Language Switcher
// @namespace    stoia.red
// @version      1.0.1
// @description  Per-character list of known languages with one-click /speak switching and a "next line only" [language] prefix.
// @match        https://philadelphiabynight.net/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-speak.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-speak.user.js
// ==/UserScript==

(function () {
  'use strict';

  // The game has no command that lists which languages a character has
  // claimed, so the list is kept here, per character, and maintained by the
  // player (Manage languages…). Two chat lines keep it up to date on their
  // own: "You have learned X." adds X, and "You will now speak in X." adds X
  // and marks it current. "You go back to speaking plain English." resets.
  //
  // Those lines are read from the play page's Vue message arrays (both the RP
  // and the Activity list, so the chat filter can't hide them), the same
  // component the Chat Log script hooks.

  const STORAGE_KEY = 'pbn-speak';
  const ENGLISH = 'English';

  // Catalog from the in-game help for /speak, with the aliases it accepts.
  const CATALOG = [
    ['Ancient Greek', ['greek']], ['Arabic', []], ['Bengali', []], ['Danish', ['dansk']],
    ['Dutch', []], ['Farsi', ['persian']], ['French', []],
    ['Gaelic', ['irish', 'gaeilge', 'scottish gaelic']], ['German', []],
    ['Hebrew', ['ivrit', 'modern hebrew', 'biblical hebrew']], ['Hindi', []], ['Italian', []],
    ['Japanese', []], ['Korean', []], ['Latin', []], ['Mandarin', []], ['Norwegian', ['norsk']],
    ['Polish', []], ['Portuguese', []], ['Romanian', []], ['Russian', []], ['Spanish', []],
    ['Swahili', []], ['Swedish', ['svenska']], ['Tagalog', ['filipino']], ['Turkish', []],
    ['Ukrainian', []], ['Urdu', []], ['Vietnamese', []],
    ['Yiddish', ['yidish', 'mameloshn', 'mameloshen']],
  ];

  function canonical(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    if (n === 'english') return ENGLISH;
    for (const [lang, aliases] of CATALOG) {
      if (lang.toLowerCase() === n || aliases.includes(n)) return lang;
    }
    return null;
  }

  // The word the game expects after /speak or inside [ ]: lower-case name.
  function cmdName(lang) { return lang.toLowerCase(); }

  // --------------------------------------------------------------------------
  // Storage: { [characterName]: { known: string[], current: string } }
  // --------------------------------------------------------------------------

  function loadAll() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }

  function saveAll(all) { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); }

  function charData(all, name) {
    const d = all[name] || (all[name] = { known: [], current: ENGLISH });
    if (!Array.isArray(d.known)) d.known = [];
    if (!d.current) d.current = ENGLISH;
    return d;
  }

  function update(fn) {
    const all = loadAll();
    const d = charData(all, getCharName());
    fn(d);
    d.known = CATALOG.map(([l]) => l).filter(l => d.known.includes(l)); // catalog order, no dupes
    saveAll(all);
    refreshBadge();
  }

  // --------------------------------------------------------------------------
  // Play component (Vue) — character name and chat messages.
  // --------------------------------------------------------------------------

  function findPlayInstance() {
    const stack = [document.querySelector('#q-app')?._vnode];
    let guard = 0;
    while (stack.length && guard++ < 20000) {
      const v = stack.pop();
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) { stack.push(...v); continue; }
      const c = v.component;
      if (c) {
        const p = c.proxy;
        if (p && !c.isUnmounted && Array.isArray(p.messages) && Array.isArray(p.activityMessages)) return c;
        stack.push(c.subTree);
      }
      if (v.suspense) stack.push(v.suspense.activeBranch);
      if (Array.isArray(v.children)) stack.push(v.children);
    }
    return null;
  }

  function getCharName() {
    try {
      const name = (hooked?.inst || findPlayInstance())?.proxy?.character?.name;
      if (name) return String(name);
    } catch (e) { /* fall through */ }
    const m = document.querySelector('.journal-title')?.textContent.trim().match(/^(.+?)['’]s Journal$/);
    return m ? m[1] : 'default';
  }

  const SPEAK_RE   = /You will now speak in ([A-Za-z][A-Za-z ']*?)\./;
  const ENGLISH_RE = /You go back to speaking plain English/;
  const LEARNED_RE = /You have learned ([A-Za-z][A-Za-z ']*?)\./;

  function onGameText(text) {
    let m;
    if (ENGLISH_RE.test(text)) {
      update(d => { d.current = ENGLISH; });
    } else if ((m = text.match(SPEAK_RE))) {
      const lang = canonical(m[1]);
      if (lang) update(d => { d.current = lang; if (lang !== ENGLISH && !d.known.includes(lang)) d.known.push(lang); });
    } else if ((m = text.match(LEARNED_RE))) {
      const lang = canonical(m[1]);
      if (lang && lang !== ENGLISH) update(d => { if (!d.known.includes(lang)) d.known.push(lang); });
    }
  }

  // The game renders these with its "system" template, which is what puts
  // the orange [SYSTEM] label in front.
  function isSystemLine(m) {
    return m.type === 'system' || /\[SYSTEM\]/.test(m.html || '');
  }

  const seenMsgs = new WeakSet();
  let hooked = null; // { inst, stops }

  function drain(list) {
    let i = list.length;
    while (i > 0 && !seenMsgs.has(list[i - 1].__v_raw || list[i - 1])) i--;
    for (; i < list.length; i++) {
      const m = list[i];
      seenMsgs.add(m.__v_raw || m);
      if (m.isHistory) continue; // replayed room history may be someone else's old state
      // Only the game's own [SYSTEM] lines, so a player quoting these phrases
      // in say/LOOC can't change anything. (Checking for a missing sender
      // didn't work: system lines can carry `from` too.)
      if (!isSystemLine(m)) continue;
      if (typeof m.text === 'string') onGameText(m.text);
    }
  }

  function syncHook() {
    if (hooked && hooked.inst.isUnmounted) { hooked.stops.forEach(s => s()); hooked = null; }
    if (hooked) return;
    const inst = findPlayInstance();
    if (!inst) return;
    const p = inst.proxy;
    const stops = ['messages', 'activityMessages'].map(key => {
      drain(p[key]);
      return p.$watch(
        () => { const a = p[key]; return a.length ? a[a.length - 1] : null; },
        () => drain(p[key]),
        { flush: 'sync' },
      );
    });
    hooked = { inst, stops };
    refreshBadge();
  }

  // --------------------------------------------------------------------------
  // Command box helpers
  // --------------------------------------------------------------------------

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function findCommandInput() {
    return document.querySelector('.command-bar textarea')
      || document.querySelector('.command-bar input[type="text"]');
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Sends a command, restoring whatever was being typed.
  async function sendCommand(cmd) {
    const input = findCommandInput();
    if (!input) return;
    const draft = input.value;
    setNativeValue(input, cmd);
    await sleep(0);
    pressEnter(input);
    if (draft) { await sleep(50); setNativeValue(input, draft); }
  }

  // "Next line only": put [language] right after the line's command, replacing
  // an existing [tag] there. Empty box -> start a /say.
  function addLinePrefix(lang) {
    const input = findCommandInput();
    if (!input) return;
    const tag = `[${cmdName(lang)}]`;
    let v = input.value;
    if (!v.trim()) {
      v = `/say ${tag} `;
    } else if (/^\//.test(v)) {
      v = v.replace(/^(\/\S+)\s*(\[[^\]]*\]\s*)?/, `$1 ${tag} `);
    } else {
      v = v.replace(/^\s*(\[[^\]]*\]\s*)?/, `${tag} `);
    }
    setNativeValue(input, v);
    input.focus();
    try { input.setSelectionRange(v.length, v.length); } catch (e) { /* ignore */ }
  }

  // --------------------------------------------------------------------------
  // UI
  // --------------------------------------------------------------------------

  const style = document.createElement('style');
  style.textContent = `
    #pbn-sp-quick .pbn-sp-badge {
      margin-left: 3px; font: 700 11px/1 Georgia, 'Times New Roman', serif;
      letter-spacing: .5px; color: #e0b84a;
    }
    #pbn-sp-quick.pbn-sp-quick--foreign { color: #e0b84a !important; }

    .pbn-sp-menu {
      position: fixed; z-index: 9000; display: flex; flex-direction: column;
      min-width: 240px; max-width: 340px; padding: 4px 0;
      background: #120a0a; border: 1px solid #5a1212; border-radius: 6px;
      box-shadow: 0 8px 28px #000a;
      font-family: Georgia, 'Times New Roman', serif;
    }
    .pbn-sp-menu__head {
      padding: 6px 16px 4px; color: #9a8a7a; font-size: .8rem;
      text-transform: uppercase; letter-spacing: .8px;
    }
    .pbn-sp-row { display: flex; align-items: stretch; }
    .pbn-sp-item {
      flex: 1; display: flex; align-items: center; gap: 10px; text-align: left;
      padding: 9px 16px; border: 0; background: none; cursor: pointer;
      font: inherit; font-size: 1rem; color: #c4b49a;
    }
    .pbn-sp-item:hover { color: #e8ddd0; background: #5a121233; }
    .pbn-sp-item:focus-visible, .pbn-sp-once:focus-visible { outline: 2px solid #e0b84a; outline-offset: -2px; }
    .pbn-sp-item--current { color: #f3e6cf; }
    .pbn-sp-check { width: 1em; color: #e0b84a; flex: 0 0 auto; }
    .pbn-sp-once {
      flex: 0 0 auto; padding: 0 14px; border: 0; border-left: 1px solid #5a121266;
      background: none; cursor: pointer; font: inherit; font-size: .9rem; color: #9a8a7a;
    }
    .pbn-sp-once:hover { color: #e0b84a; background: #5a121233; }
    .pbn-sp-sep { height: 1px; margin: 4px 0; background: #5a121299; }
    .pbn-sp-note { padding: 6px 16px 8px; color: #9a8a7a; font-size: .95rem; font-style: italic; line-height: 1.4; }

    .pbn-sp-manage { max-height: min(60vh, 460px); overflow-y: auto; padding: 2px 0 4px; }
    .pbn-sp-manage label {
      display: flex; align-items: center; gap: 10px; padding: 6px 16px; cursor: pointer;
      font-size: 1rem; color: #c4b49a;
    }
    .pbn-sp-manage label:hover { background: #5a121233; color: #e8ddd0; }
    .pbn-sp-manage input { accent-color: #9e2b2b; width: 16px; height: 16px; }
    .pbn-sp-done {
      margin: 6px 16px 8px; padding: 6px 14px; cursor: pointer; align-self: flex-end;
      background: #9e2b2b; color: #f3e6cf; border: 1px solid #9e2b2b; border-radius: 4px;
      font: inherit; font-size: .95rem;
    }
    .pbn-sp-done:hover { background: #b33434; }
  `;
  document.head.appendChild(style);

  function copyScopeAttrs(from, to) {
    if (!from) return;
    for (const a of from.attributes) if (a.name.startsWith('data-v-')) to.setAttribute(a.name, '');
  }

  let openMenu = null;

  function closeMenu() {
    if (!openMenu) return;
    openMenu.menu.remove();
    openMenu.trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
    window.removeEventListener('resize', closeMenu);
    openMenu = null;
  }

  function onOutside(e) {
    if (openMenu && !openMenu.menu.contains(e.target) && !openMenu.trigger.contains(e.target)) closeMenu();
  }

  function onMenuKey(e) {
    if (e.key === 'Escape') { const t = openMenu?.trigger; closeMenu(); t?.focus(); }
  }

  function el(tag, props, ...kids) {
    const n = Object.assign(document.createElement(tag), props || {});
    n.append(...kids);
    return n;
  }

  function renderMain(menu) {
    const name = getCharName();
    const d = charData(loadAll(), name);
    menu.textContent = '';
    menu.append(el('div', { className: 'pbn-sp-menu__head', textContent: `Speaking — ${name}` }));

    [ENGLISH, ...d.known].forEach(lang => {
      const isCur = d.current === lang;
      const item = el('button', {
        type: 'button',
        className: 'pbn-sp-item' + (isCur ? ' pbn-sp-item--current' : ''),
        title: lang === ENGLISH ? 'Go back to plain English' : `Speak ${lang} until you change it`,
      }, el('span', { className: 'pbn-sp-check', textContent: isCur ? '✓' : '' }), lang);
      item.setAttribute('role', 'menuitem');
      item.addEventListener('click', () => {
        closeMenu();
        // Current language is updated from the game's confirmation line, not
        // here, so a refused switch doesn't leave the badge lying.
        sendCommand(`/speak ${cmdName(lang)}`);
      });
      const row = el('div', { className: 'pbn-sp-row' }, item);
      if (lang !== ENGLISH) {
        const once = el('button', {
          type: 'button', className: 'pbn-sp-once', textContent: '1×',
          title: `Next line only: add [${cmdName(lang)}] to the line you're typing`,
        });
        once.setAttribute('aria-label', `${lang} for the next line only`);
        once.addEventListener('click', () => { closeMenu(); addLinePrefix(lang); });
        row.append(once);
      }
      menu.append(row);
    });

    if (!d.known.length) {
      menu.append(el('div', {
        className: 'pbn-sp-note',
        textContent: `No languages saved for ${name} yet. Add the ones you've claimed with /speak learn below.`,
      }));
    }

    menu.append(el('div', { className: 'pbn-sp-sep' }));
    const manage = el('button', { type: 'button', className: 'pbn-sp-item' },
      el('span', { className: 'pbn-sp-check' }), 'Manage languages…');
    manage.setAttribute('role', 'menuitem');
    manage.addEventListener('click', () => { renderManage(menu); position(); });
    menu.append(manage);
  }

  function renderManage(menu) {
    const name = getCharName();
    const d = charData(loadAll(), name);
    menu.textContent = '';
    menu.append(
      el('div', { className: 'pbn-sp-menu__head', textContent: `Languages — ${name}` }),
      el('div', {
        className: 'pbn-sp-note',
        textContent: `Tick the languages ${name} has claimed with /speak learn. The game can't list them, so this list is kept here.`,
      }),
    );
    const list = el('div', { className: 'pbn-sp-manage' });
    CATALOG.forEach(([lang]) => {
      const box = el('input', { type: 'checkbox', checked: d.known.includes(lang) });
      box.addEventListener('change', () => update(x => {
        if (box.checked) { if (!x.known.includes(lang)) x.known.push(lang); }
        else {
          x.known = x.known.filter(k => k !== lang);
          if (x.current === lang) x.current = ENGLISH;
        }
      }));
      list.append(el('label', {}, box, lang));
    });
    const done = el('button', { type: 'button', className: 'pbn-sp-done', textContent: 'Done' });
    done.addEventListener('click', () => { renderMain(menu); position(); menu.querySelector('.pbn-sp-item')?.focus(); });
    menu.append(list, done);
    list.querySelector('input')?.focus();
  }

  function position() {
    if (!openMenu) return;
    const { menu, trigger } = openMenu;
    const r = trigger.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = `${Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8)}px`;
    menu.style.top = `${r.top - 6 - mh >= 8 ? r.top - 6 - mh : Math.max(8, Math.min(r.bottom + 6, window.innerHeight - mh - 8))}px`;
  }

  function showMenu(trigger) {
    const menu = el('div', { className: 'pbn-sp-menu' });
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    openMenu = { menu, trigger };
    renderMain(menu);
    position();
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
    window.addEventListener('resize', closeMenu);
    menu.querySelector('.pbn-sp-item')?.focus();
  }

  function refreshBadge() {
    const btn = document.getElementById('pbn-sp-quick');
    if (!btn) return;
    const cur = charData(loadAll(), getCharName()).current;
    const foreign = cur !== ENGLISH;
    btn.classList.toggle('pbn-sp-quick--foreign', foreign);
    const badge = btn.querySelector('.pbn-sp-badge');
    const text = foreign ? cur.slice(0, 3).toUpperCase() : '';
    if (badge && badge.textContent !== text) badge.textContent = text;
    const title = `Language: speaking ${cur}`;
    if (btn.title !== title) btn.title = title;
  }

  // Translate icon, copied from the site's own "Set your mood" icon button.
  function ensureQuickButton() {
    if (location.pathname !== '/play' || document.getElementById('pbn-sp-quick')) return;
    const mood = document.querySelector('.command-bar .q-field__append [aria-label="Set your mood"]');
    if (!mood) return;

    const btn = document.createElement('button');
    btn.id = 'pbn-sp-quick';
    btn.type = 'button';
    btn.className = mood.className;
    copyScopeAttrs(mood, btn);
    btn.setAttribute('style', mood.getAttribute('style') || '');
    btn.setAttribute('aria-label', 'Language');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span class="q-focus-helper"></span><span class="q-btn__content text-center col items-center q-anchor--skip justify-center row no-wrap"><i aria-hidden="true" class="q-icon notranslate material-icons" role="img"><span aria-hidden="true">translate</span></i><span class="pbn-sp-badge"></span></span>';
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => {
      const wasOpen = openMenu?.trigger === btn;
      closeMenu();
      if (!wasOpen) showMenu(btn);
    });
    // Leftmost of the script-added icons, just before the site's own ones end.
    (document.getElementById('pbn-dp-quick') || mood).before(btn);
    refreshBadge();
  }

  // --------------------------------------------------------------------------
  // Lifecycle: a light 1s tick while on /play keeps the icon present and the
  // message hook pointed at the live component.
  // --------------------------------------------------------------------------

  setInterval(() => {
    if (location.pathname !== '/play') {
      if (hooked) { hooked.stops.forEach(s => s()); hooked = null; }
      closeMenu();
      return;
    }
    ensureQuickButton();
    syncHook();
  }, 1000);
})();
