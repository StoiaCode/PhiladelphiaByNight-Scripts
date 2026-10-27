// ==UserScript==
// @name         PbN Roll Sampler
// @namespace    stoia.red
// @version      1.0.1
// @description  Rolls the /roll dialog's current setup N times as private rolls and compares the results with the exact V20 odds.
// @match        https://philadelphiabynight.net/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

  async function waitFor(fn, ms = 5000, step = 40) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
    return null;
  }

  // ---- command box
  function commandInput() { return $('.command-bar textarea, .command-bar input[type="text"]'); }
  function setValue(input, v) {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  async function send(cmd) {
    const input = commandInput();
    if (!input) throw new Error('command box not found');
    setValue(input, cmd);
    input.focus();
    await sleep(0);
    const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    for (const t of ['keydown', 'keypress', 'keyup']) input.dispatchEvent(new KeyboardEvent(t, o));
  }

  // ---- the roll dialog
  const dialog = () => $$('.q-dialog .q-card').find(c => /Roll Dice/.test($('.title-style', c)?.textContent || '')) || null;
  const FIELDS = { attribute: 'Select an attribute', ability: 'Select an ability', virtue: 'Select a virtue', difficulty: 'Select roll difficulty' };
  const fieldOf = (dlg, label) => $(`input[aria-label="${label}"]`, dlg)?.closest('.q-field') || null;
  const selectedText = (dlg, label) => norm($('.q-select__selected-value', fieldOf(dlg, label) || document.createElement('div'))?.textContent);
  const toggleOf = (dlg, labelStart) => $$('.q-toggle[role="switch"]', dlg).find(t => (t.getAttribute('aria-label') || '').startsWith(labelStart)) || null;
  const isOn = t => t?.getAttribute('aria-checked') === 'true';
  async function setToggle(dlg, labelStart, want) {
    const t = toggleOf(dlg, labelStart);
    if (!t || isOn(t) === want || t.getAttribute('aria-disabled') === 'true') return;
    t.click();
    await waitFor(() => isOn(t) === want, 1500);
  }
  // (menus are position:fixed, so offsetParent can't tell if one is showing)
  const openMenu = () => $$('.q-menu').find(m => m.getClientRects().length && $('.q-item', m)) || null;
  // Opens a QSelect, finds the option (scrolling the list, which only draws
  // part of it at a time) and clicks it.
  async function pick(dlg, label, wanted) {
    if (!wanted || selectedText(dlg, label) === wanted) return true;
    const field = fieldOf(dlg, label);
    if (!field) throw new Error(`field "${label}" not found`);
    $('.q-field__control', field).click();
    let menu = await waitFor(openMenu, 800);
    if (!menu) {
      const target = $('.q-select__focus-target', field);
      target.focus();
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }));
      menu = await waitFor(openMenu, 1500);
    }
    if (!menu) throw new Error(`couldn't open "${label}"`);
    const short = wanted.replace(/\s*\(.*$/, '');
    for (let i = 0; i < 40; i++) {
      const items = $$('.q-item', menu);
      const hit = items.find(it => norm(it.textContent) === wanted) || items.find(it => norm(it.textContent).replace(/\s*\(.*$/, '') === short);
      if (hit) { hit.click(); await waitFor(() => !openMenu(), 1500); return true; }
      const before = menu.scrollTop;
      menu.scrollTop += Math.max(100, menu.clientHeight - 40);
      if (menu.scrollTop === before) break;
      menu.dispatchEvent(new Event('scroll')); // redraw now, not on the next frame
      await sleep(80);
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    throw new Error(`option "${wanted}" not found in "${label}"`);
  }
  function readSetup(dlg) {
    const setup = {};
    for (const [k, label] of Object.entries(FIELDS)) setup[k] = selectedText(dlg, label);
    setup.specialty = isOn(toggleOf(dlg, 'Specialty'));
    setup.pool = Number($('.pool-display__number', dlg)?.textContent) || 0;
    setup.diff = Number(setup.difficulty) || 6;
    return setup;
  }
  async function applySetup(dlg, setup) {
    for (const [k, label] of Object.entries(FIELDS)) if (setup[k]) await pick(dlg, label, setup[k]);
    await setToggle(dlg, 'Spend Willpower', false); // never spend Willpower on samples
    await setToggle(dlg, 'Specialty', setup.specialty);
    await setToggle(dlg, 'Public Roll', false);     // private
    if (isOn(toggleOf(dlg, 'Public Roll'))) throw new Error('could not switch Public Roll off');
  }

  // ---- results: the play page's own message lists (RP and Activity), with the
  // chat on screen as a fallback.
  let playCache = null;
  function playInstance() {
    if (playCache && !playCache.isUnmounted) return playCache;
    const stack = [$('#q-app')?._vnode];
    for (let guard = 0; stack.length && guard < 20000; guard++) {
      const v = stack.pop();
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) { stack.push(...v); continue; }
      const c = v.component;
      if (c) {
        const p = c.proxy;
        if (p && !c.isUnmounted && Array.isArray(p.messages) && Array.isArray(p.activityMessages)) return (playCache = c);
        stack.push(c.subTree);
      }
      if (v.suspense) stack.push(v.suspense.activeBranch);
      if (Array.isArray(v.children)) stack.push(v.children);
    }
    return null;
  }
  function messageMark() {
    const p = playInstance()?.proxy;
    if (p) return { vue: true, seen: new Set([...p.messages, ...p.activityMessages].map(m => m.__v_raw || m)) };
    return { vue: false, seen: new Set($$('.chat-container [role="article"]')) };
  }
  function newMessagesSince(mark) {
    const out = [];
    if (mark.vue) {
      const p = playInstance()?.proxy;
      for (const m of p ? [...p.messages, ...p.activityMessages] : []) {
        const raw = m.__v_raw || m;
        if (!mark.seen.has(raw)) { mark.seen.add(raw); out.push(m.html || m.text || ''); }
      }
    } else {
      for (const r of $$('.chat-container [role="article"]')) if (!mark.seen.has(r)) { mark.seen.add(r); out.push(r.innerHTML); }
    }
    return out;
  }
  const myName = () => norm($('.journal-title')?.textContent).replace(/['’]s Journal$/, '');
  // { net, botch, faces } from a roll card / roll line, or a throttle notice, or null.
  function parseResult(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const root = tpl.content;
    const text = norm(root.textContent);
    if (/too (fast|quickly)|slow down|wait (a moment|before)|cooldown/i.test(text)) return { throttled: true };
    const card = $('.roll-card', root);
    if (card) {
      const from = norm($('.roll-card-from', card)?.textContent);
      const me = myName();
      // Private rolls read "You Roll...", public ones "<your name> Rolls..."; anything else is someone else's roll.
      if (from && !/^You Roll\b/i.test(from) && !(me && from.toLowerCase().includes(me.toLowerCase()))) return null;
    } else if (!/\broll/i.test(text)) return null;
    const res = norm($('.roll-card-result', root)?.textContent) || text;
    const faces = $$('.roll-chip', root).map(c => Number(c.textContent)).filter(n => n >= 1 && n <= 10);
    let m;
    if ((m = res.match(/(\d+)\s+success/i))) return { net: Number(m[1]), botch: false, faces };
    if (/botch/i.test(res)) return { net: 0, botch: true, faces };
    if (/fail/i.test(res)) return { net: 0, botch: false, faces };
    return null;
  }

  // ---- exact V20 odds: each 1 cancels a success; no successes rolled and
  // at least one 1 is a botch; with a specialty a 10 counts twice.
  function theory(n, diff, specialty) {
    const pOne = 0.1, pHit = Math.max(0, (11 - diff) / 10), pTen = 0.1;
    let dist = new Map([['0,0', 1]]);
    for (let i = 0; i < n; i++) {
      const next = new Map();
      const add = (s, o, p) => next.set(s + ',' + o, (next.get(s + ',' + o) || 0) + p);
      for (const [k, p] of dist) {
        const [s, o] = k.split(',').map(Number);
        add(s, o + 1, p * pOne);
        if (specialty) { add(s + 1, o, p * (pHit - pTen)); add(s + 2, o, p * pTen); } else add(s + 1, o, p * pHit);
        add(s, o, p * (1 - pOne - pHit));
      }
      dist = next;
    }
    const out = { botch: 0, byNet: [] };
    for (const [k, p] of dist) {
      const [s, o] = k.split(',').map(Number);
      if (s === 0 && o > 0) { out.botch += p; continue; }
      const net = Math.max(0, s - o);
      out.byNet[net] = (out.byNet[net] || 0) + p;
    }
    for (let i = 0; i < out.byNet.length; i++) out.byNet[i] = out.byNet[i] || 0;
    return out;
  }

  // ---- panel
  const pct = x => (100 * x).toFixed(1) + '%';
  let panel = null, stopFlag = false;
  function ensurePanel() {
    if (panel?.isConnected) return panel;
    panel = document.createElement('div');
    panel.id = 'pbn-rs-panel';
    panel.innerHTML = `<style>
      #pbn-rs-panel{position:fixed;right:16px;bottom:16px;z-index:9500;width:min(520px,94vw);max-height:80vh;overflow:auto;box-sizing:border-box;padding:14px 16px;
        background:#120a0a;color:#e8ddd0;border:1px solid #5a1212;border-radius:6px;box-shadow:0 8px 30px #000c;font:16px/1.45 system-ui,'Segoe UI',sans-serif}
      #pbn-rs-panel h3{margin:0 0 6px;font-size:1.1rem;color:#f3e6cf}
      #pbn-rs-panel table{width:100%;border-collapse:collapse;margin-top:8px;font-size:.95rem}
      #pbn-rs-panel td,#pbn-rs-panel th{padding:3px 6px;border-bottom:1px solid #5a121255;text-align:right}
      #pbn-rs-panel td:first-child,#pbn-rs-panel th:first-child{text-align:left}
      #pbn-rs-panel .rs-row{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
      #pbn-rs-panel button{padding:5px 14px;border-radius:4px;border:1px solid #9e2b2b;background:#120a0a;color:#e8ddd0;font:inherit;font-size:.95rem;cursor:pointer}
      #pbn-rs-panel button:hover{background:#5a121255}
      #pbn-rs-panel .rs-dim{color:#9a8a7a;font-size:.9rem}
      #pbn-rs-panel .rs-err{color:#f0906a}
    </style><h3>Roll sampler</h3><div class="rs-status"></div><div class="rs-body"></div>
    <div class="rs-row"><button type="button" class="rs-stop">Stop</button><button type="button" class="rs-copy">Copy</button><button type="button" class="rs-close">Close</button></div>`;
    $('.rs-stop', panel).addEventListener('click', () => { stopFlag = true; });
    $('.rs-close', panel).addEventListener('click', () => { stopFlag = true; panel.remove(); });
    $('.rs-copy', panel).addEventListener('click', () => navigator.clipboard?.writeText(panel.querySelector('.rs-status').innerText + '\n' + panel.querySelector('.rs-body').innerText));
    document.body.append(panel);
    return panel;
  }
  function render(setup, results, total, note) {
    const p = ensurePanel();
    const th = theory(setup.pool, setup.diff, setup.specialty);
    const n = results.length;
    const obs = { botch: 0, byNet: [] };
    let sum = 0;
    const faces = Array(11).fill(0);
    for (const r of results) {
      if (r.botch) obs.botch++; else { obs.byNet[r.net] = (obs.byNet[r.net] || 0) + 1; }
      sum += r.net;
      r.faces.forEach(f => faces[f]++);
    }
    const thMean = th.byNet.reduce((a, q, k) => a + q * k, 0);
    const thSucc = 1 - th.botch - (th.byNet[0] || 0);
    const obsSucc = n ? (n - obs.botch - (obs.byNet[0] || 0)) / n : 0;
    const what = [setup.attribute, setup.ability, setup.virtue].filter(Boolean).map(s => s.replace(/\s*—.*$/, '')).join(' + ');
    $('.rs-status', p).innerHTML = `<div>${what || 'Custom pool'} · <b>${setup.pool} dice</b> vs <b>${setup.diff}</b>${setup.specialty ? ' · specialty' : ''} · private</div>
      <div class="rs-dim">${n} / ${total} rolled${note ? ' · ' + note : ''}</div>`;
    const maxNet = Math.max(th.byNet.length - 1, obs.byNet.length - 1);
    let rows = `<tr><td>Botch</td><td>${n ? pct(obs.botch / n) : '–'}</td><td>${pct(th.botch)}</td></tr>`;
    for (let k = 0; k <= maxNet; k++) {
      const t = th.byNet[k] || 0, o = obs.byNet[k] || 0;
      if (t < 0.0005 && !o) continue;
      rows += `<tr><td>${k === 0 ? 'Failure (0)' : k + (k === 1 ? ' success' : ' successes')}</td><td>${n ? pct(o / n) : '–'}</td><td>${pct(t)}</td></tr>`;
    }
    const faceN = faces.reduce((a, b) => a + b, 0);
    $('.rs-body', p).innerHTML = `<table>
        <tr><th></th><th>Observed</th><th>Exact (V20)</th></tr>
        <tr><td>Average successes</td><td>${n ? (sum / n).toFixed(2) : '–'}</td><td>${thMean.toFixed(2)}</td></tr>
        <tr><td>At least 1 success</td><td>${n ? pct(obsSucc) : '–'}</td><td>${pct(thSucc)}</td></tr>
        ${rows}
      </table>
      ${faceN ? `<div class="rs-dim" style="margin-top:8px">Die faces (${faceN} dice, 10% each if fair): ${faces.slice(1).map((c, i) => `${i + 1}: ${pct(c / faceN)}`).join(' · ')}</div>` : ''}`;
  }

  // ---- the run
  let running = false;
  async function run(setup, total) {
    if (running) return;
    running = true;
    stopFlag = false;
    const results = [];
    let note = '';
    try {
      for (let i = 0; i < total && !stopFlag; i++) {
        let dlg = dialog();
        if (!dlg) { await send('/roll'); dlg = await waitFor(dialog, 6000); }
        if (!dlg) throw new Error('the /roll dialog did not open');
        await applySetup(dlg, setup);
        const mark = messageMark();
        $('.roll-btn', dlg).click();
        await waitFor(() => !dialog(), 4000);
        let res = null;
        const end = Date.now() + 15000;
        while (!res && Date.now() < end && !stopFlag) {
          for (const html of newMessagesSince(mark)) { const r = parseResult(html); if (r) { res = r; break; } }
          if (!res) await sleep(60);
        }
        if (stopFlag) break;
        if (!res) throw new Error('no roll result arrived within 15 seconds');
        if (res.throttled) { note = 'game asked to slow down, waiting'; render(setup, results, total, note); await sleep(2500); i--; continue; }
        results.push(res);
        note = '';
        render(setup, results, total, note);
        await sleep(120);
      }
      render(setup, results, total, stopFlag ? 'stopped' : 'done');
    } catch (e) {
      render(setup, results, total, `<span class="rs-err">stopped: ${e.message}</span>`);
      console.warn('[PbN Roll Sampler]', e);
    } finally {
      running = false;
    }
  }

  // ---- "Roll × N (private)" in the dialog
  function inject() {
    const dlg = dialog();
    if (!dlg || $('.pbn-rs-go', dlg) || running) return;
    const actions = $('.q-card__actions', dlg);
    if (!actions) return;
    const count = document.createElement('input');
    Object.assign(count, { type: 'number', min: 1, max: 1000, value: localStorage.getItem('pbn-rs-count') || 50, className: 'pbn-rs-count', title: 'How many private rolls' });
    count.style.cssText = 'width:5.5em;margin-right:6px;padding:6px 8px;background:#0d0707;color:#e8ddd0;border:1px solid #5a1212;border-radius:4px;font:inherit;font-size:1rem';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'pbn-rs-go';
    go.textContent = 'Roll × N (private)';
    go.title = 'Roll this setup N times as private rolls (Willpower off) and compare with the exact odds';
    go.style.cssText = 'margin-right:auto;padding:6px 14px;cursor:pointer;background:#120a0a;color:#e8ddd0;border:1px solid #9e2b2b;border-radius:4px;font:inherit;font-size:1rem';
    go.addEventListener('click', () => {
      const total = Math.max(1, Math.min(1000, Number(count.value) || 1));
      localStorage.setItem('pbn-rs-count', total);
      const setup = readSetup(dlg);
      if (!setup.pool) { alert('Pick a dice pool first.'); return; }
      render(setup, [], total, 'starting…');
      run(setup, total);
    });
    actions.prepend(count, go);
  }
  new MutationObserver(inject).observe(document.body, { childList: true, subtree: true });
})();
