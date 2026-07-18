// ==UserScript==
// @name         PbN Chat Declutter
// @namespace    stoia.red
// @version      1.0.3
// @description  Collapses consecutive same-person SYSTEM spam (walk in / look around / walk out) into a compact block, and hides "entered torpor" for other players for a bit in case it's just a flaky reconnect.
// @match        https://philadelphiabynight.net/play
// @run-at       document-idle
// @grant        none
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-chat-declutter.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-chat-declutter.user.js
// ==/UserScript==

(function () {
  'use strict';

  // How long to wait after "<Name> has entered torpor." before showing it, in
  // case a matching "<Name> has awoken." shows up (flaky-reconnect blip).
  // Only applies to other players — your own torpor always shows immediately.
  const TORPOR_AWAIT_MS = 30000;

  // Minimum number of Title-Case words required to treat the start of a
  // SYSTEM line as a real actor name (rather than an ordinary capitalized
  // sentence opener). Confirmed from real traffic that single-word character
  // names exist ("Thorn"), so this has to stay at 1 — the trade-off is an
  // occasional false positive (e.g. "Invalid command: says" reads as an
  // actor named "Invalid"), which is harmless in practice since a one-off
  // never repeats consecutively and a lone message renders unchanged.
  const NAME_MIN_WORDS = 1;

  // The exact wording for "entered torpor" and "has awoken" hasn't been
  // directly observed yet (only paraphrased) — best-effort, safe to
  // tighten/loosen once real examples show up. Follow messages use two
  // different verb forms confirmed from real traffic: "arrives, following
  // <Name>, from the south." on entry, and "follows <Name> to the down." on
  // exit — both must match.
  const SELF_RE = /^You\b/;
  const NAME_RE = new RegExp(`^([A-Z][\\w'-]*(?:\\s[A-Z][\\w'-]*){${NAME_MIN_WORDS - 1},3})\\b`);
  const FOLLOW_RE = /\bfollow(?:s|ing)\b/i;
  const FOLLOW_TARGET_RE = /\bfollow(?:s|ing)\s+([A-Z][\w'-]*(?:\s[A-Z][\w'-]*){0,3})/;
  const TORPOR_RE = /\bentered torpor\b/i;
  const AWOKEN_RE = /\bhas awoken\b/i;

  // Movement lines (walk in/out) always include a compass/travel direction
  // word ("from the east", "towards the west", "upward", etc.) regardless of
  // the customizable flavor verb used. Not used programmatically below since
  // grouping treats every consecutive same-actor SYSTEM line the same way,
  // but useful context if the heuristic ever needs to split out message
  // subtypes: /\b(north|south|east|west|northeast|northwest|southeast|southwest|up|upward|down|downward|in|out)\b/i

  // --------------------------------------------------------------------------
  // DOM helpers
  // --------------------------------------------------------------------------

  // Reads a [role="article"] node and returns its SYSTEM-line text (with the
  // "[SYSTEM] " tag stripped), or null if it isn't a SYSTEM line.
  function getSystemText(article) {
    const p = article.querySelector('p');
    if (!p) return null;
    const tagSpan = p.querySelector('span.text-orange-9.text-weight-bold');
    if (!tagSpan || tagSpan.textContent.trim() !== '[SYSTEM]') return null;
    const full = (p.textContent || '').replace(/\s+/g, ' ').trim();
    return full.replace(/^\[SYSTEM\]\s*/, '');
  }

  // Hides a node while keeping it fully "rendered" (display isn't none, so
  // innerText-based readers like pbn-chat-log's export still see its full
  // text) and without inflating any ancestor's scrollable area (zero size +
  // overflow:hidden, no large offsets).
  function hideKeepText(node) {
    Object.assign(node.style, {
      position: 'absolute', width: '0', height: '0', overflow: 'hidden',
      margin: '0', padding: '0', border: '0',
      clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap',
    });
  }

  // Undoes hideKeepText(). Since hiding never moved the node in the DOM, this
  // makes it reappear exactly where it originally sat.
  function revealInPlace(node) {
    node.style.position = node.style.width = node.style.height = node.style.overflow =
      node.style.margin = node.style.padding = node.style.border =
      node.style.clip = node.style.whiteSpace = '';
  }

  // --------------------------------------------------------------------------
  // Feature A — consecutive same-actor grouping
  // --------------------------------------------------------------------------

  let pendingSingle = null; // { text, node, primaryName, names: Set } | null
  let currentGroup = null;  // { wrapperEl, rowsEl, primaryName, names: Set } | null

  // Shared muted tone for movement-type lines, whether they end up solo or
  // in a materialized group — a lone message dims in place immediately on
  // classification; a grouped one is hidden and replaced by rows at the same
  // opacity, so there's no flash of "loud" styling before it settles.
  const DIM_OPACITY = '0.85';

  function closeOpenGroup() {
    pendingSingle = null;
    currentGroup = null;
  }

  // Mutes a still-visible original line (a solo movement message that hasn't
  // — or hasn't yet — joined a group) without restructuring it.
  function dimInPlace(node) {
    node.style.opacity = DIM_OPACITY;
  }

  function appendRow(rowsEl, text) {
    const row = document.createElement('div');
    row.textContent = text;
    row.style.cssText = `font:12px/1.4 inherit;opacity:${DIM_OPACITY};`;
    rowsEl.appendChild(row);
  }

  function materializeGroup(first, second) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pbn-declutter-group';
    wrapper.style.cssText = 'margin:2px 0;';

    const header = document.createElement('div');
    header.textContent = first.primaryName;
    header.style.cssText = 'font:11px/1.4 inherit;opacity:0.6;font-weight:600;';

    const rows = document.createElement('div');
    rows.style.cssText = 'padding-left:10px;';

    wrapper.append(header, rows);
    appendRow(rows, first.text);
    appendRow(rows, second.text);

    first.node.parentElement.insertBefore(wrapper, first.node);
    hideKeepText(first.node);
    hideKeepText(second.node);

    const names = new Set(first.names);
    second.identitySet.forEach(n => names.add(n));

    currentGroup = { wrapperEl: wrapper, rowsEl: rows, primaryName: first.primaryName, names };
    pendingSingle = null;
  }

  function handleGrouping(name, text, node) {
    // Dim immediately, before we know whether this stays solo or gets
    // folded into a group — a lone message should never render "loud" even
    // briefly, and dimming a node that's about to be hidden is harmless.
    dimInPlace(node);

    let identitySet = new Set([name]);
    if (FOLLOW_RE.test(text)) {
      const targetMatch = FOLLOW_TARGET_RE.exec(text);
      if (targetMatch && targetMatch[1] !== name) identitySet.add(targetMatch[1]);
    }

    const open = currentGroup || pendingSingle;
    const intersects = open && [...identitySet].some(n => open.names.has(n));

    if (intersects && currentGroup) {
      appendRow(currentGroup.rowsEl, text);
      hideKeepText(node);
      identitySet.forEach(n => currentGroup.names.add(n));
      return;
    }

    if (intersects && pendingSingle) {
      materializeGroup(pendingSingle, { text, node, identitySet });
      return;
    }

    closeOpenGroup();
    pendingSingle = { text, node, primaryName: name, names: identitySet };
  }

  // --------------------------------------------------------------------------
  // Feature B — torpor/awoken await (other players only)
  // --------------------------------------------------------------------------

  const pendingTorpor = new Map(); // name -> { node, timeoutId }

  function handleTorpor(name, node) {
    if (pendingTorpor.has(name)) {
      const prev = pendingTorpor.get(name);
      clearTimeout(prev.timeoutId);
      revealInPlace(prev.node);
      pendingTorpor.delete(name);
    }
    hideKeepText(node);
    const timeoutId = setTimeout(() => {
      pendingTorpor.delete(name);
      revealInPlace(node);
    }, TORPOR_AWAIT_MS);
    pendingTorpor.set(name, { node, timeoutId });
  }

  function handleAwoken(name, node) {
    if (!pendingTorpor.has(name)) return; // no matching wait in progress — render normally
    const pending = pendingTorpor.get(name);
    clearTimeout(pending.timeoutId);
    pendingTorpor.delete(name);
    hideKeepText(node); // suppress this message too — it was just a reconnect blip
  }

  // --------------------------------------------------------------------------
  // Classification pipeline
  // --------------------------------------------------------------------------

  function handleArticle(article) {
    const text = getSystemText(article);
    if (text === null || SELF_RE.test(text)) {
      closeOpenGroup();
      return;
    }

    const nameMatch = NAME_RE.exec(text);
    if (!nameMatch) {
      closeOpenGroup();
      return;
    }
    const name = nameMatch[1];

    if (TORPOR_RE.test(text)) {
      closeOpenGroup();
      handleTorpor(name, article);
      return;
    }
    if (AWOKEN_RE.test(text)) {
      closeOpenGroup();
      handleAwoken(name, article);
      return;
    }

    handleGrouping(name, text, article);
  }

  // --------------------------------------------------------------------------
  // Mount: watch for new chat messages. Re-runs on SPA navigation since the
  // chat container doesn't exist yet at document-idle.
  // --------------------------------------------------------------------------

  function mount() {
    const container = document.querySelector('.chat-container');
    if (!container) return false;

    new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches('[role="article"]')) handleArticle(node);
          else node.querySelectorAll('[role="article"]').forEach(handleArticle);
        }
      }
    }).observe(container, { childList: true, subtree: true });

    return true;
  }

  if (!mount()) {
    const waiter = new MutationObserver(() => { if (mount()) waiter.disconnect(); });
    waiter.observe(document.body, { childList: true, subtree: true });
  }
})();
