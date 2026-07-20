// ==UserScript==
// @name         PbN Chat Declutter
// @namespace    stoia.red
// @version      1.3.0
// @description  Mutes and collapses consecutive/related SYSTEM spam (walk in / look around / walk out) into compact per-actor blocks, and hides "entered torpor" for other players for a bit in case it's just a flaky reconnect.
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

  // Each actor's grouping thread stays open for this many total chat lines
  // (dialogue included, since that's what actually scrolls things away) —
  // a rough stand-in for "still on screen." A busy room burns through this
  // fast on message count alone regardless of wall-clock time, which is the
  // point: a thread that's scrolled off shouldn't keep silently growing.
  const SCREEN_WORTH_LINES = 18;

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
  // \p{Lu}/\p{L} (Unicode letter classes, needs the 'u' flag) instead of
  // A-Z/\w — real names include accented letters ("Cécile Aurelius"), which
  // plain \w doesn't cover and would silently truncate the match. No
  // trailing \b: JS's \b is itself ASCII-only, so a name ending in an
  // accented letter would fail the boundary check even with \p{L} above.
  const NAME_RE = new RegExp(`^(\\p{Lu}[\\p{L}\\p{N}'-]*(?:\\s\\p{Lu}[\\p{L}\\p{N}'-]*){${NAME_MIN_WORDS - 1},3})`, 'u');
  // Anonymous/masked descriptions are common ("A massive woman with a
  // shaggy two-tone haircut...") and, being sentence-initial, their leading
  // article is capitalized too — with NAME_MIN_WORDS=1 that reads as a
  // 1-word name literally called "A". Worse, it's not a one-off: any two
  // such descriptions both starting with "A" would spuriously merge under
  // that fake shared identity. Reject known non-name leading words.
  const NAME_STOPWORDS = new Set(['A', 'An', 'The', 'Someone', 'Something', 'There', 'It', 'This', 'That']);
  const FOLLOW_RE = /\bfollow(?:s|ing)\b/i;
  const FOLLOW_TARGET_RE = /\bfollow(?:s|ing)\s+(\p{Lu}[\p{L}\p{N}'-]*(?:\s\p{Lu}[\p{L}\p{N}'-]*){0,3})/u;
  const TORPOR_RE = /\bentered torpor\b/i;
  const AWOKEN_RE = /\bhas awoken\b/i;
  // Confirmed from real traffic: "X looks around." never carries custom
  // flavor text (every enter/leave line does, this one never does). That
  // makes it a reliable anchor for an identity even when X is an anonymous
  // description with no proper name — see buildIdentity() and the orphan
  // buffer below.
  const LOOKS_AROUND_RE = /^(.+) looks around\.$/;
  // Guards findPrefixThread() against accidentally matching on a very short
  // registered key (shouldn't happen given NAME_STOPWORDS, but cheap safety).
  const MIN_PREFIX_KEY_LEN = 8;
  // Minimum shared-prefix length (characters) before two anonymous lines with
  // no other anchor (no name, no follow, no "looks around.") are inferred to
  // be the same character purely from matching leading text. Higher than
  // MIN_PREFIX_KEY_LEN since this infers a brand-new identity from scratch
  // rather than matching an already-confirmed one — a short accidental
  // overlap ("A tall, ") shouldn't be enough to merge two different people.
  const MIN_LCP_LEN = 20;
  // Some [SYSTEM] messages are a completely different category of content —
  // e.g. a "Daily News" feature that posts a headline, a multi-sentence
  // article body, and bracket-tagged metadata ("[Center City | 2 nights
  // ago | Severity: Critical]") all as their own SYSTEM lines. None of that
  // is movement/observation spam, so it shouldn't be dimmed, grouped, or fed
  // into the orphan/similarity buffers at all — left completely untouched.
  // Detected two ways: a leading structural marker (-, ", or [), or sheer
  // length (every real movement/look line observed so far is well under
  // this; a multi-sentence news paragraph blows past it easily).
  const NON_MOVEMENT_RE = /^[-"[]/;
  const MAX_MOVEMENT_LEN = 200;
  // Duplicated from pbn-room-presence.user.js (if installed) purely to
  // recognize categories that script now owns outright — see the
  // document.documentElement.dataset.pbnRoomPresenceActive check in
  // handleArticle() below. Not otherwise used by declutter's own logic.
  const ENTER_RE = /\bfrom the \p{L}+/iu;
  const LEAVE_RE = /\b(?:to|towards) the \p{L}+/iu;
  const LOOKS_AT_RE = /^(.+) looks at (.+)\.$/;
  const WHISPER_RE = /^(.+) whispers to (.+)\.$/;

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

  // Shared muted tone for movement-type lines, whether they end up solo or
  // in a materialized group — a lone message dims in place immediately on
  // classification; a grouped one is hidden and replaced by rows at the same
  // opacity, so there's no flash of "loud" styling before it settles.
  const DIM_OPACITY = '0.85';

  function dimInPlace(node) {
    node.style.opacity = DIM_OPACITY;
  }

  function appendRow(rowsEl, text) {
    const row = document.createElement('div');
    row.textContent = text;
    row.style.cssText = `font:12px/1.4 inherit;opacity:${DIM_OPACITY};`;
    rowsEl.appendChild(row);
  }

  function truncateHeader(s, max) {
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  // --------------------------------------------------------------------------
  // Identity extraction
  // --------------------------------------------------------------------------

  // Builds the identity set for a SYSTEM line: the leading actor name if we
  // found one, a follow-target name if the line mentions "following" /
  // "follows" someone, and the subject of a "looks around." line (works even
  // for an anonymous description, since that suffix is never customized).
  // A line with none of these can still be linked in later — see
  // handleArticle's prefix/orphan fallbacks.
  function buildIdentity(text, name) {
    const identitySet = new Set();
    if (name) identitySet.add(name);
    if (FOLLOW_RE.test(text)) {
      const targetMatch = FOLLOW_TARGET_RE.exec(text);
      // Same trap as the leading-name case: a followed target with no proper
      // name of their own ("following A short woman, with long dust-white
      // hair") truncates to just the stopword "A" — drop it rather than
      // registering "A" as a shared identity for every unrelated line that
      // happens to start with it.
      if (targetMatch && targetMatch[1] !== name && !NAME_STOPWORDS.has(targetMatch[1])) {
        identitySet.add(targetMatch[1]);
      }
    }
    const lookMatch = LOOKS_AROUND_RE.exec(text);
    if (lookMatch) identitySet.add(lookMatch[1]);
    return identitySet;
  }

  // --------------------------------------------------------------------------
  // Per-actor threads
  // --------------------------------------------------------------------------
  // Each thread is a { kind: 'single'|'group', primaryName, names: Set,
  // lastLine, ...single:{text,node} or group:{wrapperEl,rowsEl} }. A single
  // identity string can appear as a key for at most one thread; a
  // follow-bridged thread is registered under every name it's known by.

  const threads = new Map(); // identity string -> thread
  let lineCounter = 0;

  function registerThread(thread) {
    thread.names.forEach(n => threads.set(n, thread));
  }

  // Returns the thread for any name in identitySet that's still "on screen"
  // (within SCREEN_WORTH_LINES), or null if none is open.
  function findOpenThread(identitySet) {
    for (const n of identitySet) {
      const t = threads.get(n);
      if (t && (lineCounter - t.lastLine) <= SCREEN_WORTH_LINES) return t;
    }
    return null;
  }

  // Fallback for a line with no identity of its own: does it start with an
  // already-known identity string (e.g. an anonymous character's next
  // action, once their description was established by a prior "looks
  // around." line)?
  function findPrefixThread(text) {
    for (const [key, thread] of threads) {
      if (key.length < MIN_PREFIX_KEY_LEN) continue;
      if ((lineCounter - thread.lastLine) > SCREEN_WORTH_LINES) continue;
      if (text.startsWith(key)) return thread;
    }
    return null;
  }

  // Short buffer of recent lines that couldn't be identified at all (e.g. an
  // anonymous character's entry line, before a later "looks around." reveals
  // their description). Lets that entry line be retroactively linked once an
  // identity for it shows up.
  const recentOrphans = []; // { text, node, line }[]
  const ORPHAN_BUFFER_MAX = 20;

  function pruneOrphans() {
    while (recentOrphans.length && (lineCounter - recentOrphans[0].line) > SCREEN_WORTH_LINES) {
      recentOrphans.shift();
    }
  }

  function recordOrphan(text, node) {
    recentOrphans.push({ text, node, line: lineCounter });
    if (recentOrphans.length > ORPHAN_BUFFER_MAX) recentOrphans.shift();
  }

  function takeMatchingOrphan(key) {
    pruneOrphans();
    const idx = recentOrphans.findIndex(o => o.text.startsWith(key));
    if (idx === -1) return null;
    return recentOrphans.splice(idx, 1)[0];
  }

  // Longest run of identical leading characters. If two lines share an exact
  // description as a prefix, this recovers that description precisely —
  // it can only stop where the texts actually first differ, which for a
  // fixed description + custom flavor text is exactly the verb boundary.
  function commonPrefix(a, b) {
    let i = 0;
    const len = Math.min(a.length, b.length);
    while (i < len && a[i] === b[i]) i++;
    return a.slice(0, i);
  }

  // Last-resort fallback for a fully unidentified line (no name, no follow,
  // no "looks around.", no known-thread prefix match): does it share a long
  // enough leading run with some other still-unidentified recent line to
  // infer they're the same anonymous character? Picks the best (longest)
  // match among buffered orphans rather than the first one found.
  function findOrphanBySimilarity(text) {
    pruneOrphans();
    let bestIdx = -1;
    let bestKey = '';
    for (let i = 0; i < recentOrphans.length; i++) {
      const cp = commonPrefix(text, recentOrphans[i].text).trimEnd();
      if (cp.length >= MIN_LCP_LEN && cp.length > bestKey.length) {
        bestKey = cp;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) return null;
    return { orphan: recentOrphans.splice(bestIdx, 1)[0], key: bestKey };
  }

  // --------------------------------------------------------------------------
  // Feature A — grouping
  // --------------------------------------------------------------------------

  function materializeGroup(first, second) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pbn-declutter-group';
    wrapper.style.cssText = 'margin:2px 0;';

    const header = document.createElement('div');
    header.textContent = truncateHeader(first.primaryName, 48);
    header.title = first.primaryName;
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

    registerThread({ kind: 'group', wrapperEl: wrapper, rowsEl: rows, primaryName: first.primaryName, names, lastLine: lineCounter });
  }

  function handleGrouping(text, node, identitySet, primaryName) {
    // Dim immediately, before we know whether this stays solo or gets
    // folded into a group — a lone message should never render "loud" even
    // briefly, and dimming a node that's about to be hidden is harmless.
    dimInPlace(node);

    const open = findOpenThread(identitySet);

    if (open && open.kind === 'group') {
      appendRow(open.rowsEl, text);
      hideKeepText(node);
      identitySet.forEach(n => open.names.add(n));
      open.lastLine = lineCounter;
      registerThread(open);
      return;
    }

    if (open && open.kind === 'single') {
      materializeGroup(open, { text, node, identitySet });
      return;
    }

    // No open thread for this identity yet — check whether a recent
    // unidentified line (e.g. this same anonymous character's entry, before
    // we knew their description) actually belongs to it.
    for (const key of identitySet) {
      const orphan = takeMatchingOrphan(key);
      if (orphan) {
        materializeGroup(
          { text: orphan.text, node: orphan.node, primaryName, names: new Set() },
          { text, node, identitySet }
        );
        return;
      }
    }

    registerThread({ kind: 'single', text, node, primaryName, names: new Set(identitySet), lastLine: lineCounter });
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
    // Every chat line counts toward "screen worth," system or not — dialogue
    // scrolls things away just as much as system spam does.
    lineCounter++;

    const text = getSystemText(article);
    if (text === null || SELF_RE.test(text)) return;

    // Not movement/observation spam at all — a news article or similar
    // structured announcement. Leave it completely alone: no dimming, no
    // grouping, no orphan buffering.
    if (NON_MOVEMENT_RE.test(text) || text.length > MAX_MOVEMENT_LEN) return;

    // If pbn-room-presence.user.js is installed and mounted, it now owns
    // enter/leave/looks-around/looks-at/whisper lines outright (hiding them
    // and, where relevant, drawing an arrow instead) — defer to it entirely
    // for these categories rather than also dimming/grouping them here.
    // Everything else (torpor/awoken, non-movement passthrough, and
    // grouping for movement lines Room Presence's heuristics don't
    // recognize) is unaffected.
    if (document.documentElement.dataset.pbnRoomPresenceActive === '1' &&
        (ENTER_RE.test(text) || LEAVE_RE.test(text) || LOOKS_AROUND_RE.test(text) ||
         LOOKS_AT_RE.test(text) || WHISPER_RE.test(text))) {
      return;
    }

    // The leading actor may have no usable name at all — some characters
    // display an anonymous/masked description instead of a proper name
    // (e.g. "an immaculately dressed, but horribly unkempt lady"), which
    // starts lowercase and never matches NAME_RE. Torpor/awoken require a
    // real leading name; grouping can still identify the line via a
    // follow-target or "looks around." subject below.
    const nameMatch = NAME_RE.exec(text);
    let name = nameMatch ? nameMatch[1] : null;
    if (name && NAME_STOPWORDS.has(name)) name = null;

    if (name) {
      if (TORPOR_RE.test(text)) { handleTorpor(name, article); return; }
      if (AWOKEN_RE.test(text)) { handleAwoken(name, article); return; }
    }

    const identitySet = buildIdentity(text, name);

    if (identitySet.size === 0) {
      // No name, no follow-target, not a "looks around." line — try bridging
      // into an already-known identity (e.g. this same anonymous character's
      // next action after their description was established); otherwise
      // it's an orphan for now, muted and buffered in case a later line
      // reveals who it was about.
      const fallback = findPrefixThread(text);
      if (fallback) {
        handleGrouping(text, article, new Set(fallback.names), fallback.primaryName);
        return;
      }

      // Still nothing — as a last resort, see if this line shares a long
      // exact leading run with another still-unidentified recent line (e.g.
      // two custom-flavored lines about the same anonymous character, with
      // no "looks around." to anchor either of them). The matched prefix
      // itself becomes the identity going forward.
      const similar = findOrphanBySimilarity(text);
      if (similar) {
        materializeGroup(
          { text: similar.orphan.text, node: similar.orphan.node, primaryName: similar.key, names: new Set() },
          { text, node: article, identitySet: new Set([similar.key]) }
        );
        return;
      }

      dimInPlace(article);
      recordOrphan(text, article);
      return;
    }

    const primaryName = name || [...identitySet][0];
    handleGrouping(text, article, identitySet, primaryName);
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
