// ==UserScript==
// @name         PbN Craft Helper
// @namespace    stoia.red
// @version      1.0.0
// @description  Quick-action panel for the crafting system — recipe memory, one-click commands, attempt counter.
// @match        https://philadelphiabynight.net/play
// @run-at       document-idle
// @grant        none
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-craft-helper.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-craft-helper.user.js
// ==/UserScript==

(function () {
  'use strict';

  const RECIPE_KEY = 'pbn-craft-recipe';

  let startCount = 0;

  // --------------------------------------------------------------------------
  // Command sending (same pattern as other pbn scripts)
  // --------------------------------------------------------------------------

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function findInput() {
    const pools = [
      Array.from(document.querySelectorAll('textarea')),
      Array.from(document.querySelectorAll('input[type="text"], input:not([type])')),
    ];
    for (const pool of pools) {
      const visible = pool.filter(el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      });
      if (visible.length)
        return visible.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
    }
    return null;
  }

  function sendCommand(cmd) {
    const input = findInput();
    if (!input) return;
    setNativeValue(input, cmd);
    input.focus();
    setTimeout(() => pressEnter(input), 0);
  }

  // --------------------------------------------------------------------------
  // UI helpers
  // --------------------------------------------------------------------------

  function makeBtn(label, { bg, border, title } = {}) {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    if (title) el.title = title;
    el.style.cssText = [
      'cursor:pointer', 'font:11px/1.4 inherit',
      'padding:3px 10px', 'border-radius:4px',
      `border:1px solid ${border || 'rgba(255,255,255,0.25)'}`,
      `background:${bg || 'rgba(255,255,255,0.08)'}`,
      'color:inherit', 'white-space:nowrap',
    ].join(';');
    el.addEventListener('mouseenter', () => el.style.filter = 'brightness(1.35)');
    el.addEventListener('mouseleave', () => el.style.filter = '');
    el.addEventListener('mousedown', e => e.preventDefault());
    return el;
  }

  // --------------------------------------------------------------------------
  // Mount
  // --------------------------------------------------------------------------

  function mount() {
    if (document.getElementById('pbn-craft-helper')) return true;
    const cmdInput = findInput();
    if (!cmdInput) return false;
    const field = cmdInput.closest('.q-field') || cmdInput.parentElement;
    if (!field?.parentElement) return false;

    // --- Recipe row ---

    const recipeInput = document.createElement('input');
    recipeInput.type = 'text';
    recipeInput.placeholder = 'recipe name…';
    recipeInput.value = localStorage.getItem(RECIPE_KEY) || '';
    recipeInput.style.cssText = [
      'flex:1', 'min-width:0', 'font:11px/1.4 inherit',
      'padding:3px 6px', 'border-radius:4px',
      'border:1px solid rgba(255,255,255,0.25)',
      'background:rgba(255,255,255,0.08)', 'color:inherit', 'outline:none',
    ].join(';');
    recipeInput.addEventListener('input', () =>
      localStorage.setItem(RECIPE_KEY, recipeInput.value));
    recipeInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.stopPropagation(); doStart(); }
    });

    const counterEl = document.createElement('span');
    counterEl.title = 'Click to reset';
    counterEl.style.cssText = [
      'font:11px/1.4 inherit', 'opacity:0.5',
      'white-space:nowrap', 'cursor:pointer', 'flex-shrink:0', 'user-select:none',
    ].join(';');
    const refreshCounter = () => { counterEl.textContent = `${startCount} started`; };
    refreshCounter();
    counterEl.addEventListener('click', () => { startCount = 0; refreshCounter(); });

    const startBtn = makeBtn('▶ Start', {
      bg: 'rgba(80,160,80,0.2)',
      border: 'rgba(100,200,100,0.4)',
    });

    function doStart() {
      const recipe = recipeInput.value.trim();
      if (!recipe) { recipeInput.focus(); return; }
      sendCommand(`craft start ${recipe}`);
      startCount++;
      refreshCounter();
    }
    startBtn.addEventListener('click', doStart);

    const row1 = document.createElement('div');
    row1.style.cssText = 'display:flex;gap:4px;align-items:center;';
    row1.append(recipeInput, startBtn, counterEl);

    // --- Action row ---

    const continueBtn    = makeBtn('Continue');
    const carefulBtn     = makeBtn('Careful');
    const controlledBtn  = makeBtn('Controlled');
    const rushBtn        = makeBtn('Rush', {
      bg: 'rgba(200,120,50,0.2)', border: 'rgba(220,150,80,0.4)',
    });
    const abandonBtn     = makeBtn('Abandon', {
      bg: 'rgba(180,50,50,0.15)', border: 'rgba(200,80,80,0.35)',
    });

    continueBtn.addEventListener('click',   () => sendCommand('craft continue'));
    carefulBtn.addEventListener('click',    () => sendCommand('craft choose careful'));
    controlledBtn.addEventListener('click', () => sendCommand('craft choose controlled'));
    rushBtn.addEventListener('click',       () => sendCommand('craft choose rush'));
    abandonBtn.addEventListener('click',    () => sendCommand('craft cancel'));

    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
    row2.append(continueBtn, carefulBtn, controlledBtn, rushBtn, abandonBtn);

    // --- Collapsible wrapper ---

    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    body.append(row1, row2);

    let collapsed = false;
    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.textContent = '▲';
    collapseBtn.title = 'Collapse craft helper';
    collapseBtn.style.cssText = [
      'cursor:pointer', 'font:10px/1 inherit',
      'padding:1px 5px', 'border-radius:3px',
      'border:1px solid rgba(255,255,255,0.2)',
      'background:rgba(255,255,255,0.06)', 'color:inherit',
    ].join(';');
    collapseBtn.addEventListener('mousedown', e => e.preventDefault());
    collapseBtn.addEventListener('click', () => {
      collapsed = !collapsed;
      body.style.display    = collapsed ? 'none' : 'flex';
      collapseBtn.textContent = collapsed ? '▼' : '▲';
      collapseBtn.title       = collapsed ? 'Expand craft helper' : 'Collapse craft helper';
    });

    const headerLabel = document.createElement('span');
    headerLabel.textContent = 'Craft';
    headerLabel.style.cssText = 'font:11px/1.4 inherit;opacity:0.5;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:2px;';
    header.append(headerLabel, collapseBtn);

    const panel = document.createElement('div');
    panel.id = 'pbn-craft-helper';
    panel.style.cssText = 'margin-bottom:4px;';
    panel.append(header, body);

    field.parentElement.insertBefore(panel, field);
    return true;
  }

  if (!mount()) {
    const waiter = new MutationObserver(() => { if (mount()) waiter.disconnect(); });
    waiter.observe(document.body, { childList: true, subtree: true });
  }
})();
