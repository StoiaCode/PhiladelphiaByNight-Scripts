// ==UserScript==
// @name         PbN Pair
// @namespace    stoia.red
// @version      0.1.1
// @description  For players who play together: claim a chat line ("I'll answer this one") or hand it to your partner, and they see it on their screen. Encrypted, through your own small relay.
// @match        https://philadelphiabynight.net/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/pair/pbn-pair.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/pair/pbn-pair.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---- How it works. Hovering a chat line shows "✋ Mine" and "→ Yours".
  // Claiming marks the line on everyone else's screen ("✋ Jane takes it");
  // handing over lights it up for them. A line is recognised by what was
  // said, without the speaker's name (that can differ between viewers: a
  // name for one, a short desc for the other). Only "this line: claimed /
  // handed over / dropped" is sent, never chat text: a short hash of the
  // line, encrypted in the browser with your shared key. The relay only
  // passes it on and can't read it.

  const CFG_KEY = 'pbnpair:config'; // { server, secret, name }: kept out of the toolkit's export on purpose
  const CLAIM_MS = 10 * 60 * 1000;   // a claim or hand-over fades after this
  const MAX_AGE_MS = 2 * 60 * 1000;  // older messages are ignored (replays)
  const CHAT = '.chat-container';
  const ROW = '[role="article"]';
  const LOG = (...a) => console.log('[PbN Pair]', ...a);

  const loadCfg = () => { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; } catch (e) { return {}; } };
  let cfg = loadCfg();
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };
  const myName = () => (cfg.name || '').trim()
    || document.querySelector('.journal-title')?.textContent.trim().match(/^(.+?)['’]s Journal$/)?.[1] || 'Partner';

  // ---- Lines. Only what players say and emote: those have a speaker
  // (<strong><span class="chat-name-…">) or the spoken text in .msg-body.
  // [SYSTEM], [LOCATION], looks, item notes and overheard whispers have neither.
  const isUserLine = row => !!row.querySelector('.msg-body, strong [class*="chat-name"]');
  // The key is a hash of the line's text minus the speaker.
  function lineText(row) {
    const x = row.cloneNode(true);
    // The PbN Toolkit's word filter and screenshot mode change what's shown; read the real words.
    x.querySelectorAll('[data-pbn-cf]').forEach(s => s.replaceWith(s.dataset.pbnCf));
    x.querySelectorAll('[data-pbn-shot-me]').forEach(s => s.replaceWith(s.dataset.pbnShotMe));
    const bodies = x.querySelectorAll('.msg-body');
    let t;
    if (bodies.length) t = [...bodies].map(b => b.textContent).join(' ');
    else {
      x.querySelectorAll('[class*="chat-name"], .text-amber-6, .text-orange-9, .pbn-dos-stub, button').forEach(n => n.remove());
      t = x.textContent;
    }
    return t.replace(/\s+/g, ' ').trim().toLowerCase();
  }
  // cyrb53: a small, fast string hash; it's encrypted before it leaves anyway.
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const keyCache = new WeakMap(); // row -> [text, key]
  function keyOf(row) {
    if (!isUserLine(row)) return null;
    const t = lineText(row);
    const c = keyCache.get(row);
    if (c && c[0] === t) return c[1];
    const k = t ? hash(t) : null;
    keyCache.set(row, [t, k]);
    return k;
  }
  // The newest row with that key (the same words twice: the latest one).
  function rowFor(k) {
    const rows = document.querySelectorAll(`${CHAT} ${ROW}`);
    for (let i = rows.length - 1, n = 0; i >= 0 && n < 400; i--, n++) if (keyOf(rows[i]) === k) return rows[i];
    return null;
  }

  // ---- State, per line key: { state: 'mine'|'theirs'|'toyou'|'passed', who, at }
  const marks = new Map();
  function setMark(k, m) { if (m) marks.set(k, m); else marks.delete(k); paint(); }
  const LABEL = { mine: () => '✋ you', theirs: m => '✋ ' + m.who, toyou: m => '→ ' + m.who + ': yours', passed: () => '→ handed over' };
  function paint() {
    const now = Date.now();
    for (const [k, m] of marks) if (now - m.at > CLAIM_MS) marks.delete(k);
    const want = new Map();
    for (const [k, m] of marks) { const row = rowFor(k); if (row) want.set(row, m); }
    document.querySelectorAll(`${CHAT} ${ROW}[data-pbn-pair]`).forEach(row => {
      if (!want.has(row)) { delete row.dataset.pbnPair; delete row.dataset.pbnPairLabel; }
    });
    // data- attributes, not classes: Vue rewrites a row's class attribute when it re-renders it.
    for (const [row, m] of want) {
      if (row.dataset.pbnPair !== m.state) row.dataset.pbnPair = m.state;
      const label = LABEL[m.state](m);
      if (row.dataset.pbnPairLabel !== label) row.dataset.pbnPairLabel = label;
    }
    renderPill();
  }

  // ---- Crypto. room = SHA-256 of the key (the relay's room name);
  // messages are AES-GCM with another SHA-256 of the key.
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  async function derive(secret) {
    const room = hex(await crypto.subtle.digest('SHA-256', enc.encode('pbn-pair room|' + secret)));
    const raw = await crypto.subtle.digest('SHA-256', enc.encode('pbn-pair key|' + secret));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { room, key };
  }
  function newSecret() {
    const b = crypto.getRandomValues(new Uint8Array(32));
    return b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ---- Connection
  let ws = null, crypt = null, retry = 2000, retryT = null, peers = 0, wanted = false;
  const names = new Map(); // partner name -> last heard
  let status = 'off'; // off | connecting | on | error
  async function connect() {
    clearTimeout(retryT);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    if (!wanted || !cfg.server || !cfg.secret) { status = 'off'; renderPill(); return; }
    status = 'connecting'; renderPill();
    try { crypt = await derive(cfg.secret); } catch (e) { status = 'error'; renderPill(); return; }
    const sock = new WebSocket(cfg.server.replace(/\/+$/, '') + '/?room=' + crypt.room);
    ws = sock;
    sock.onopen = () => { retry = 2000; status = 'on'; renderPill(); send({ t: 'hello' }); };
    sock.onmessage = ev => onMessage(ev.data);
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null; peers = 0; names.clear();
      status = wanted ? 'connecting' : 'off'; renderPill();
      if (wanted) { retryT = setTimeout(connect, retry); retry = Math.min(retry * 2, 30000); }
    };
  }
  async function send(msg) {
    if (!ws || ws.readyState !== 1 || !crypt) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const body = enc.encode(JSON.stringify({ ...msg, who: myName(), at: Date.now() }));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, crypt.key, body);
    ws.send(JSON.stringify({ iv: b64(iv), ct: b64(ct) }));
  }
  async function onMessage(data) {
    let env;
    try { env = JSON.parse(data); } catch (e) { return; }
    if (env?.sys === 'peers') { peers = Math.max(0, (Number(env.n) || 1) - 1); if (!peers) names.clear(); renderPill(); return; }
    if (typeof env?.iv !== 'string' || typeof env?.ct !== 'string') return;
    let m;
    try { m = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, crypt.key, unb64(env.ct)))); }
    catch (e) { return; } // not ours (wrong key) or tampered
    if (!m || typeof m.t !== 'string' || typeof m.who !== 'string' || !Number.isFinite(m.at)) return;
    if (Math.abs(Date.now() - m.at) > MAX_AGE_MS) return;
    const who = m.who.slice(0, 60);
    names.set(who, Date.now());
    if (m.t === 'hello') { send({ t: 'here' }); renderPill(); return; }
    if (m.t === 'here') { renderPill(); return; }
    if (typeof m.k !== 'string' || m.k.length > 20) return;
    const cur = marks.get(m.k);
    if (m.t === 'claim') {
      // Both claimed at once: the earlier claim wins, on both screens.
      if (cur?.state === 'mine' && (cur.at < m.at || (cur.at === m.at && myName() < who))) return;
      setMark(m.k, { state: 'theirs', who, at: m.at });
    } else if (m.t === 'pass') {
      setMark(m.k, { state: 'toyou', who, at: m.at });
    } else if (m.t === 'drop') {
      if (cur && cur.who === who && (cur.state === 'theirs' || cur.state === 'toyou')) setMark(m.k, null);
    }
  }
  function act(row, t) {
    const k = keyOf(row);
    if (!k) return;
    if (t === 'claim') setMark(k, { state: 'mine', who: myName(), at: Date.now() });
    else if (t === 'pass') setMark(k, { state: 'passed', who: myName(), at: Date.now() });
    else setMark(k, null);
    send({ t, k });
  }

  // ---- Hover toolbar: one floating element, nothing is put into the chat's own rows.
  const bar = el('div', { id: 'pbn-pair-bar' });
  let barRow = null, hideT = null;
  function btn(text, title, fn) { const b = el('button', { type: 'button', textContent: text, title }); b.addEventListener('click', e => { e.stopPropagation(); fn(); }); return b; }
  function showBar(row) {
    clearTimeout(hideT);
    const k = keyOf(row);
    if (!k || status !== 'on') { bar.hidden = true; return; }
    const m = marks.get(k);
    barRow = row;
    bar.textContent = '';
    const state = m?.state;
    if (state === 'theirs') { bar.hidden = true; return; }
    if (state !== 'mine') bar.append(btn('✋ Mine', "I'll answer this one", () => { act(row, 'claim'); showBar(row); }));
    if (state === 'mine' || state === 'passed') bar.append(btn('✕ Drop', 'Take back your claim or hand-over', () => { act(row, 'drop'); showBar(row); }));
    if (state !== 'passed' && state !== 'toyou') bar.append(btn('→ Yours', 'Hand this one to your partner', () => { act(row, 'pass'); showBar(row); }));
    const r = row.getBoundingClientRect();
    bar.hidden = false;
    bar.style.top = Math.max(4, r.top + 2) + 'px';
    bar.style.left = Math.max(4, r.right - bar.offsetWidth - 8) + 'px';
  }
  function scheduleHide() { clearTimeout(hideT); hideT = setTimeout(() => { bar.hidden = true; barRow = null; }, 250); }
  bar.addEventListener('mouseenter', () => clearTimeout(hideT));
  bar.addEventListener('mouseleave', scheduleHide);
  bar.hidden = true;
  document.addEventListener('mouseover', e => {
    const row = e.target.closest?.(`${CHAT} ${ROW}`);
    if (row) { if (row !== barRow || bar.hidden) showBar(row); else clearTimeout(hideT); }
    else if (!bar.contains(e.target)) scheduleHide();
  });
  document.addEventListener('scroll', () => { if (!bar.hidden) bar.hidden = true; }, true);

  // ---- Status pill: connection, partners, and lines handed to you (click to jump there).
  const pill = el('button', { type: 'button', id: 'pbn-pair-pill' });
  pill.addEventListener('click', () => {
    const toyou = [...marks.entries()].filter(([, m]) => m.state === 'toyou').sort((a, b) => b[1].at - a[1].at)[0];
    const row = toyou && rowFor(toyou[0]);
    if (row) { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    openSettings();
  });
  function renderPill() {
    const toyou = [...marks.values()].filter(m => m.state === 'toyou').length;
    const who = [...names.keys()].slice(0, peers).join(', ');
    const state = toyou ? 'toyou' : status;
    const text = toyou ? `→ ${toyou} for you` : status === 'on' ? (peers ? `● Pair · ${who || peers + ' connected'}` : '● Pair · waiting')
      : status === 'connecting' ? '○ Pair · connecting…' : status === 'error' ? '✕ Pair' : '○ Pair · set up';
    // Only when something changed: the page watcher would see every rewrite and repaint again.
    if (pill.dataset.state !== state) pill.dataset.state = state;
    if (pill.textContent !== text) pill.textContent = text;
    pill.title = toyou ? 'Jump to the line handed to you' : 'PbN Pair settings';
  }

  // ---- Settings
  function openSettings() {
    document.getElementById('pbn-pair-dlg')?.remove();
    const server = el('input', { type: 'url', value: cfg.server || '', placeholder: 'wss://pair.example.org', spellcheck: false });
    const secret = el('input', { type: 'text', value: cfg.secret || '', placeholder: 'Shared key (Generate, then send it to your partner)', spellcheck: false });
    const name = el('input', { type: 'text', value: cfg.name || '', placeholder: myName() + ' (from your journal)', spellcheck: false });
    const gen = btn('Generate', 'Make a new random key', () => { secret.value = newSecret(); });
    const copy = btn('Copy', 'Copy the key to send it to your partner', () => navigator.clipboard?.writeText(secret.value));
    const err = el('div', { className: 'pbn-pair-err' });
    const save = btn('Save', '', () => {
      const s = server.value.trim();
      if (s && !/^wss:\/\/[^\s/?#]+/.test(s) && !/^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(s)) { err.textContent = 'The server address has to start with wss://'; return; }
      if (secret.value.trim() && secret.value.trim().length < 32) { err.textContent = 'That key is too short: use Generate, or paste the one your partner sent.'; return; }
      cfg = { server: s, secret: secret.value.trim(), name: name.value.trim() };
      try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { err.textContent = "Couldn't save (storage blocked)."; return; }
      dlg.remove();
      connect();
    });
    const close = btn('Cancel', '', () => dlg.remove());
    const row = (label, ...kids) => el('label', {}, el('span', { textContent: label }), el('div', {}, ...kids));
    const dlg = el('div', { id: 'pbn-pair-dlg' },
      el('div', { className: 'pbn-pair-box' },
        el('h3', { textContent: 'PbN Pair' }),
        el('p', { textContent: 'Everyone playing together uses the same server and the same key. The key never leaves your browser: everything is encrypted with it before it goes to the server.' }),
        row('Server', server), row('Shared key', secret, gen, copy), row('Your name for them', name),
        err, el('div', { className: 'pbn-pair-actions' }, close, save)));
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });
    document.body.append(dlg);
    (cfg.server ? secret : server).focus();
  }

  const style = el('style', { textContent: `
    ${CHAT} ${ROW}[data-pbn-pair] { position: relative; border-left: 3px solid #6b5836; padding-left: 8px !important; }
    ${CHAT} ${ROW}[data-pbn-pair]::after {
      content: attr(data-pbn-pair-label); position: absolute; top: 2px; right: 6px; padding: 0 9px; border-radius: 999px;
      background: #1f1f26; border: 1px solid #6b5836; color: #e8d8b8; font: normal .85rem/1.6 system-ui, sans-serif; pointer-events: none;
    }
    ${CHAT} ${ROW}[data-pbn-pair="mine"] { border-left-color: #5fd38a; }
    ${CHAT} ${ROW}[data-pbn-pair="mine"]::after { border-color: #5fd38a88; color: #8fe0aa; }
    ${CHAT} ${ROW}[data-pbn-pair="theirs"]::after, ${CHAT} ${ROW}[data-pbn-pair="passed"]::after { color: #c4b49a; }
    ${CHAT} ${ROW}[data-pbn-pair="toyou"] { border-left-color: #e0b84a; background: #e0b84a1f; animation: pbn-pair-glow 1.6s ease-in-out 3; }
    ${CHAT} ${ROW}[data-pbn-pair="toyou"]::after { background: #e0b84a; border-color: #e0b84a; color: #1a1208; font-weight: 600; }
    @keyframes pbn-pair-glow { 50% { background: #e0b84a44; box-shadow: inset 0 0 0 1px #e0b84a88; } }
    #pbn-pair-bar { position: fixed; z-index: 2600; display: flex; gap: 4px; padding: 3px; background: #1f1f26f2; border: 1px solid #6b5836; border-radius: 6px; box-shadow: 0 4px 14px #000a; }
    #pbn-pair-bar[hidden] { display: none; }
    #pbn-pair-bar button, #pbn-pair-dlg button {
      padding: 3px 10px; cursor: pointer; background: none; color: #e8d8b8; border: 1px solid #6b583699; border-radius: 4px; font: .95rem system-ui, sans-serif;
    }
    #pbn-pair-bar button:hover, #pbn-pair-dlg button:hover { border-color: #e0b84a; background: #e0b84a1a; }
    #pbn-pair-pill {
      position: fixed; left: 10px; bottom: 10px; z-index: 2600; padding: 4px 12px; cursor: pointer; border-radius: 999px;
      background: #1f1f26; color: #8a8a94; border: 1px solid #3a3a44; font: .95rem system-ui, sans-serif;
    }
    #pbn-pair-pill[data-state="on"] { color: #e8d8b8; border-color: #6b5836; }
    #pbn-pair-pill[data-state="toyou"] { color: #1a1208; background: #e0b84a; border-color: #e0b84a; font-weight: 600; }
    #pbn-pair-dlg { position: fixed; inset: 0; z-index: 9000; display: flex; align-items: center; justify-content: center; background: #0008; }
    .pbn-pair-box { width: min(560px, 94vw); padding: 18px 20px; background: #1f1f26; color: #e8d8b8; border: 1px solid #6b5836; border-radius: 8px; font: 1rem/1.45 system-ui, sans-serif; }
    .pbn-pair-box h3 { margin: 0 0 6px; font-size: 1.25rem; }
    .pbn-pair-box p { margin: 0 0 12px; color: #a8a8b0; font-size: .95rem; }
    .pbn-pair-box label { display: block; margin: 0 0 10px; }
    .pbn-pair-box label > span { display: block; margin-bottom: 3px; color: #a8a8b0; font-size: .9rem; }
    .pbn-pair-box label > div { display: flex; gap: 6px; }
    .pbn-pair-box input { flex: 1; min-width: 0; padding: 6px 9px; background: #121216; color: #e8d8b8; border: 1px solid #3a3a44; border-radius: 4px; font: inherit; }
    .pbn-pair-box input:focus { outline: none; border-color: #e0b84a; }
    .pbn-pair-err { min-height: 1.3em; color: #f0906a; font-size: .9rem; }
    .pbn-pair-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
  ` });

  // ---- Only on the play page.
  let chatObs = null, paintT = null, tick = null;
  function onPlay() {
    const play = location.pathname.startsWith('/play');
    if (play === wanted) return;
    wanted = play;
    if (play) {
      document.head.append(style);
      document.body.append(bar, pill);
      chatObs = new MutationObserver(ms => {
        if (ms.every(m => bar.contains(m.target) || pill.contains(m.target))) return; // our own UI
        clearTimeout(paintT); paintT = setTimeout(paint, 60);
      });
      chatObs.observe(document.body, { childList: true, subtree: true, characterData: true });
      tick = setInterval(paint, 5000);
      connect();
    } else {
      chatObs?.disconnect(); clearInterval(tick);
      bar.remove(); pill.remove(); style.remove();
      connect(); // closes it
    }
    renderPill();
  }
  onPlay();
  setInterval(onPlay, 1000);
  LOG('ready');
})();
