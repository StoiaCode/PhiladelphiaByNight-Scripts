// ==UserScript==
// @name         PbN Room Presence
// @namespace    stoia.red
// @version      1.0.1
// @description  Tracks who's actually in the room (via enter/leave lines, resynced by /look) in a new "Present" tab, and draws momentary arrows for looks/whispers/mentions instead of leaving them as chat spam.
// @match        https://philadelphiabynight.net/play
// @run-at       document-idle
// @grant        none
// @downloadURL  https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-room-presence.user.js
// @updateURL    https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-room-presence.user.js
// ==/UserScript==

(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // Config — see pbn-chat-declutter.user.js for the shared rationale behind
  // most of these; several constants are duplicated verbatim from there
  // since this repo has no build system / cross-file imports.
  // --------------------------------------------------------------------------

  const SELF_RE = /^You\b/;
  const NAME_RE = new RegExp("^(\\p{Lu}[\\p{L}\\p{N}'-]*(?:\\s\\p{Lu}[\\p{L}\\p{N}'-]*){0,3})", 'u');
  const NAME_STOPWORDS = new Set(['A', 'An', 'The', 'Someone', 'Something', 'There', 'It', 'This', 'That']);
  const NON_MOVEMENT_RE = /^[-"[]/;
  const MAX_MOVEMENT_LEN = 200;
  // Guards resolveAgainstRoster()'s anonymous-prefix-match against a very
  // short registered key (shouldn't happen given NAME_STOPWORDS, cheap safety).
  const MIN_PREFIX_KEY_LEN = 8;

  // Confirmed from real traffic: enter lines contain "from the <direction>"
  // OR "from <direction>" with no "the" at all ("strides in from below,
  // adjusting his jacket..." — live example caught mid-session); leave lines
  // contain "to the"/"towards the <direction>". A whitelist of direction
  // words (rather than matching any word after "from"/"to") is deliberately
  // used here — it's both safer against false positives and fixes the
  // "the"-optional case in one move. NOT exhaustive — e.g. "Coyote Duran
  // drags her feet along downward." uses neither "from"/"to"/"towards" at
  // all, so it matches neither RE. When that happens the roster simply
  // doesn't update from that line; the next /look resync corrects any
  // drift. Intentional — graceful drift, not perfection — and
  // pbn-chat-declutter.js (if installed) still handles that line via its
  // own grouping as a fallback.
  const DIRECTION_WORD = '(?:the\\s+)?(?:north|south|east|west|northeast|northwest|southeast|southwest|up|upward|down|downward|above|below|in|out)\\b';
  const ENTER_RE = new RegExp(`\\bfrom ${DIRECTION_WORD}`, 'iu');
  const LEAVE_RE = new RegExp(`\\b(?:to|towards) ${DIRECTION_WORD}`, 'iu');
  // Duplicated verbatim from declutter — confirmed from real traffic to never
  // carry custom flavor text, unlike enter/leave. Identity-recovery only here
  // (see handleSystemArticle) — never itself an add/remove signal, since
  // anyone can /look regardless of how long they've already been present.
  const LOOKS_AROUND_RE = /^(.+) looks around\.$/;
  // One confirmed real example each ("Cécile Aurelius looks at A massive
  // woman with a shaggy two-tone haircut.", "Celeste Dunn whispers to Jang
  // Sun-Hee."). Tighten/loosen if trailing flavor text ever shows up on
  // either — unlike enter/leave, we have no confirmation either way yet.
  const LOOKS_AT_RE = /^(.+) looks at (.+)\.$/;
  const WHISPER_RE = /^(.+) whispers to (.+)\.$/;

  // UNCONFIRMED exact markup — see README caveats. The [LOCATION] tag class
  // itself IS confirmed (directly inspected this session:
  // <span class="text-teal-8 text-weight-bold">[LOCATION]</span>), but the
  // "You see:" bullet list's internal structure (separate elements vs. one
  // text blob, exact bullet glyph) has not been. Written defensively against
  // a single multi-line text blob using literal newlines, since that's
  // already confirmed to be how other multi-paragraph [LOCATION] bodies work.
  const YOU_SEE_RE = /^You see:?$/i;
  const ROSTER_BULLET_RE = /^[•\-*]\s*/;

  // How long a drawn arrow stays visible before fading out. Tune to taste.
  const ARROW_FADE_MS = 5000;
  // Minimum registered-name length before a substring match in dialogue is
  // trusted as a deliberate mention rather than common-word noise.
  const MIN_MENTION_NAME_LEN = 4;
  // Off by default: a bare first name ("Cade") collides with common words
  // far more than a full registered name ("Cade Karstenson") does, and this
  // can't be tuned without live false-positive data.
  const MATCH_FIRST_NAME_ONLY = false;

  // --------------------------------------------------------------------------
  // DOM helpers (duplicated from pbn-chat-declutter.user.js)
  // --------------------------------------------------------------------------

  function getSystemText(article) {
    const p = article.querySelector('p');
    if (!p) return null;
    const tagSpan = p.querySelector('span.text-orange-9.text-weight-bold');
    if (!tagSpan || tagSpan.textContent.trim() !== '[SYSTEM]') return null;
    const full = (p.textContent || '').replace(/\s+/g, ' ').trim();
    return full.replace(/^\[SYSTEM\]\s*/, '');
  }

  // Unlike getSystemText, deliberately does NOT collapse whitespace — the
  // roster bullet list's line structure is load-bearing. Uses innerText (not
  // textContent) so rendered line breaks are preserved as \n, consistent
  // with an earlier confirmed multi-paragraph [LOCATION] example this
  // session ("[LOCATION] The Lincoln Room\nA long dining hall...").
  function getLocationText(article) {
    const p = article.querySelector('p');
    if (!p) return null;
    const tagSpan = p.querySelector('span.text-teal-8.text-weight-bold');
    if (!tagSpan || tagSpan.textContent.trim() !== '[LOCATION]') return null;
    const full = article.innerText || '';
    return full.replace(/^\[LOCATION\]\s*/, '');
  }

  // Same technique as declutter's hideKeepText: keeps the node fully
  // "rendered" (so pbn-chat-log's innerText-based export still sees it) and
  // avoids inflating any ancestor's scrollable area. Room Presence never
  // reveals a hidden line again (unlike declutter's torpor await), so no
  // revealInPlace() is needed here.
  function hideKeepText(node) {
    Object.assign(node.style, {
      position: 'absolute', width: '0', height: '0', overflow: 'hidden',
      margin: '0', padding: '0', border: '0',
      clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap',
    });
  }

  function truncateHeader(s, max) {
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // --------------------------------------------------------------------------
  // Identity resolution
  // --------------------------------------------------------------------------

  function extractLeadingName(text) {
    const m = NAME_RE.exec(text);
    if (!m) return null;
    return NAME_STOPWORDS.has(m[1]) ? null : m[1];
  }

  // Resolves arbitrary text to a roster identity: a proper leading name, or
  // (for an anonymous description) a match against an already-known roster
  // key. Returns { key, existing } where existing is the current RosterEntry
  // if one is already tracked under that key, else null — or null outright
  // if nothing could be resolved at all.
  function resolveAgainstRoster(text) {
    const name = extractLeadingName(text);
    if (name) return { key: name, existing: roster.get(name) || null };
    for (const [key, entry] of roster) {
      if (key.length < MIN_PREFIX_KEY_LEN) continue;
      if (text === key || text.startsWith(key)) return { key, existing: entry };
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // Roster
  // --------------------------------------------------------------------------
  // roster: Map<identityKey, RosterEntry> — a single entry can be found under
  // multiple keys (mirrors declutter's `threads` Map), though in practice
  // this script rarely grows more than one key per entry since it doesn't
  // attempt follow-chain bridging the way declutter's grouping does.

  const roster = new Map();
  let presentPanelEl = null;
  let presentOpen = false;

  function uniqueRosterEntries() {
    const seen = new Set();
    const out = [];
    for (const entry of roster.values()) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
    return out;
  }

  function createRosterRow(entry) {
    const row = document.createElement('div');
    row.textContent = entry.displayText;
    row.title = entry.primaryKey;
    row.style.cssText = 'padding:4px 2px;font:12px/1.4 inherit;border-bottom:1px solid rgba(255,255,255,0.08);';
    return row;
  }

  function upsertRoster(key, source) {
    const existing = roster.get(key);
    if (existing) {
      existing.lastSource = source;
      return existing;
    }
    const entry = {
      identityKeys: new Set([key]),
      primaryKey: key,
      displayText: truncateHeader(key, 48),
      isAnonymous: extractLeadingName(key) !== key,
      rowEl: null,
      lastSource: source,
    };
    roster.set(key, entry);
    entry.rowEl = createRosterRow(entry);
    if (presentPanelEl) presentPanelEl.appendChild(entry.rowEl);
    return entry;
  }

  function removeRosterEntry(entry) {
    entry.identityKeys.forEach(k => roster.delete(k));
    if (entry.rowEl) entry.rowEl.remove();
  }

  // The periodic source of truth: replaces the roster's membership with
  // exactly what /look reported, adding anyone missing and removing anyone
  // no longer listed. Matched entries keep their existing object (and so
  // their existing rowEl) rather than being torn down and recreated.
  function resyncRoster(bulletTexts) {
    const confirmedKeys = new Set();
    for (const raw of bulletTexts) {
      const name = extractLeadingName(raw);
      const key = name || raw;
      confirmedKeys.add(key);
      upsertRoster(key, 'look-resync');
    }
    for (const entry of uniqueRosterEntries()) {
      const stillPresent = [...entry.identityKeys].some(k => confirmedKeys.has(k));
      if (!stillPresent) removeRosterEntry(entry);
    }
  }

  function parseRosterBullets(locationText) {
    const lines = locationText.split('\n').map(l => l.trim());
    const start = lines.findIndex(l => YOU_SEE_RE.test(l));
    if (start === -1) return null; // not a /look roster payload at all
    const names = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (ROSTER_BULLET_RE.test(lines[i])) names.push(lines[i].replace(ROSTER_BULLET_RE, '').trim());
      else if (lines[i] === '') continue;
      else break;
    }
    return names; // may be [] if "You see:" was found but the room is empty
  }

  // --------------------------------------------------------------------------
  // "Present" tab — an independently-rendered panel docked over the existing
  // Info/Actions/Settings panels container, since we have no confirmed
  // selectors for that native tab bar to inject a real sibling tab into (an
  // injected button couldn't participate in Quasar's reactive v-model
  // anyway). See README for the live-verification follow-up that could
  // upgrade this to native-looking tab styling without changing the
  // show/hide mechanism itself.
  // --------------------------------------------------------------------------

  function buildPresentTab() {
    if (document.getElementById('pbn-present-toggle')) return true; // already built
    const panelsContainer = document.querySelector('.opt-container');
    if (!panelsContainer || !panelsContainer.parentElement) return false;

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'pbn-present-toggle';
    toggleBtn.type = 'button';
    toggleBtn.textContent = 'Present';
    toggleBtn.style.cssText = [
      'cursor:pointer', 'font:11px/1.4 inherit',
      'padding:3px 10px', 'border-radius:4px',
      'border:1px solid rgba(255,255,255,0.25)',
      'background:rgba(255,255,255,0.06)', 'color:inherit',
      'margin:4px',
    ].join(';');

    const panel = document.createElement('div');
    panel.id = 'pbn-present-panel';
    panel.style.cssText = [
      'display:none', 'position:absolute', 'z-index:500',
      'overflow-y:auto', 'padding:8px', 'box-sizing:border-box',
      'background:#13131a', 'border:1px solid rgba(255,255,255,0.15)',
      'border-radius:4px',
    ].join(';');
    document.body.appendChild(panel);
    presentPanelEl = panel;

    function positionPanel() {
      const r = panelsContainer.getBoundingClientRect();
      Object.assign(panel.style, {
        left: `${Math.round(r.left + window.scrollX)}px`,
        top: `${Math.round(r.top + window.scrollY)}px`,
        width: `${Math.round(r.width)}px`,
        height: `${Math.round(r.height)}px`,
      });
    }

    function setOpen(next) {
      presentOpen = next;
      if (presentOpen) {
        positionPanel();
        panel.style.display = 'block';
      } else {
        panel.style.display = 'none';
      }
      toggleBtn.style.background = presentOpen ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.06)';
    }

    toggleBtn.addEventListener('click', () => setOpen(!presentOpen));
    window.addEventListener('resize', () => { if (presentOpen) positionPanel(); });
    window.addEventListener('scroll', () => { if (presentOpen) positionPanel(); }, true);

    panelsContainer.parentElement.insertBefore(toggleBtn, panelsContainer);
    return true;
  }

  // --------------------------------------------------------------------------
  // Arrows
  // --------------------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  let arrowOverlay = null;

  const ARROW_STYLES = {
    'looks-at': { color: '#8fbfff', dash: '' },
    whisper: { color: '#e0a9ff', dash: '4 3' },
    mention: { color: '#ffd58a', dash: '1 3' },
  };

  function buildArrowOverlay() {
    if (arrowOverlay) return;
    arrowOverlay = document.createElementNS(SVG_NS, 'svg');
    arrowOverlay.id = 'pbn-presence-arrows';
    Object.assign(arrowOverlay.style, {
      position: 'fixed', inset: '0', width: '100vw', height: '100vh',
      pointerEvents: 'none', zIndex: '999999',
    });
    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.innerHTML = '<marker id="pbn-arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">'
      + '<path d="M0,0 L8,4 L0,8 Z" fill="currentColor" /></marker>';
    arrowOverlay.appendChild(defs);
    document.body.appendChild(arrowOverlay);
  }

  // Skips silently (no queueing) if the Present tab isn't open or either
  // party has no visible row — confirmed preference over queuing missed
  // arrows, to avoid a confusing burst firing whenever the tab eventually
  // opens for an unrelated reason. The chat line is hidden either way.
  function drawArrow(fromEntry, toEntry, kind) {
    if (!presentOpen || !fromEntry.rowEl || !toEntry.rowEl) return;
    const fromRect = fromEntry.rowEl.getBoundingClientRect();
    const toRect = toEntry.rowEl.getBoundingClientRect();
    if (!fromRect.width || !toRect.width) return;

    buildArrowOverlay();
    const style = ARROW_STYLES[kind] || ARROW_STYLES['looks-at'];
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(fromRect.left + fromRect.width / 2));
    line.setAttribute('y1', String(fromRect.top + fromRect.height / 2));
    line.setAttribute('x2', String(toRect.left + toRect.width / 2));
    line.setAttribute('y2', String(toRect.top + toRect.height / 2));
    line.setAttribute('stroke', style.color);
    line.setAttribute('stroke-width', '2');
    if (style.dash) line.setAttribute('stroke-dasharray', style.dash);
    line.setAttribute('marker-end', 'url(#pbn-arrowhead)');
    line.style.color = style.color; // currentColor source for the marker's fill
    arrowOverlay.appendChild(line);

    const anim = line.animate(
      [{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }],
      { duration: ARROW_FADE_MS }
    );
    anim.onfinish = () => line.remove();
  }

  // --------------------------------------------------------------------------
  // SYSTEM line handling — enter/leave/looks-around/looks-at/whisper
  // --------------------------------------------------------------------------

  function handleLooksAt(actorText, targetText, article) {
    hideKeepText(article);
    const actor = resolveAgainstRoster(actorText);
    const target = resolveAgainstRoster(targetText);
    if (actor && actor.existing && target && target.existing) {
      drawArrow(actor.existing, target.existing, 'looks-at');
    }
  }

  function handleWhisper(actorText, targetText, article) {
    hideKeepText(article);
    const actor = resolveAgainstRoster(actorText);
    const target = resolveAgainstRoster(targetText);
    if (actor && actor.existing && target && target.existing) {
      drawArrow(actor.existing, target.existing, 'whisper');
    }
  }

  // Returns true if this article was SYSTEM-tagged at all (handled or
  // intentionally left alone), false if it wasn't SYSTEM-tagged.
  function handleSystemArticle(article) {
    const text = getSystemText(article);
    if (text === null) return false;
    if (SELF_RE.test(text)) return true;
    if (NON_MOVEMENT_RE.test(text) || text.length > MAX_MOVEMENT_LEN) return true; // e.g. Daily News — leave alone

    const looksAt = LOOKS_AT_RE.exec(text);
    if (looksAt) { handleLooksAt(looksAt[1].trim(), looksAt[2].trim(), article); return true; }

    const whisper = WHISPER_RE.exec(text);
    if (whisper) { handleWhisper(whisper[1].trim(), whisper[2].trim(), article); return true; }

    if (LOOKS_AROUND_RE.test(text)) { hideKeepText(article); return true; }

    const enters = ENTER_RE.test(text);
    const leaves = LEAVE_RE.test(text);
    if (enters === leaves) return true; // both or neither — ambiguous, leave for declutter's fallback grouping

    const resolved = resolveAgainstRoster(text);
    if (!resolved) return true; // unresolved — same fallback

    if (enters) upsertRoster(resolved.key, 'enter');
    else if (resolved.existing) removeRosterEntry(resolved.existing);
    hideKeepText(article);
    return true;
  }

  // Returns true if this article was [LOCATION]-tagged at all.
  function handleLocationArticle(article) {
    const text = getLocationText(article);
    if (text === null) return false;
    const bullets = parseRosterBullets(text);
    if (bullets !== null) resyncRoster(bullets);
    return true;
  }

  // --------------------------------------------------------------------------
  // Mention arrows — dialogue (say/pose/LOOC) lines only
  // --------------------------------------------------------------------------

  function getDialogueSpeaker(article) {
    const nameSpan = article.querySelector('span.chat-name-anonymous');
    return nameSpan ? nameSpan.textContent.trim() : null;
  }

  function getMentionPatterns(entry) {
    const patterns = [entry.primaryKey];
    if (MATCH_FIRST_NAME_ONLY) {
      const first = entry.primaryKey.split(/\s+/)[0];
      if (first) patterns.push(first);
    }
    return patterns;
  }

  function handleDialogueArticle(article) {
    const speakerName = getDialogueSpeaker(article);
    if (!speakerName) return;
    const speakerEntry = roster.get(speakerName);
    if (!speakerEntry) return; // can't draw an arrow with no row to draw it from
    const body = article.innerText || '';

    for (const entry of uniqueRosterEntries()) {
      if (entry.isAnonymous || entry === speakerEntry) continue;
      const matched = getMentionPatterns(entry).some(p =>
        p.length >= MIN_MENTION_NAME_LEN && new RegExp('\\b' + escapeRegExp(p) + '\\b').test(body));
      if (matched) drawArrow(speakerEntry, entry, 'mention');
    }
  }

  // --------------------------------------------------------------------------
  // Classification pipeline
  // --------------------------------------------------------------------------

  function processArticle(article) {
    if (handleLocationArticle(article)) return;
    if (handleSystemArticle(article)) return;
    handleDialogueArticle(article);
  }

  // --------------------------------------------------------------------------
  // Mount: watch for new chat messages. Re-runs on SPA navigation since the
  // chat container doesn't exist yet at document-idle.
  // --------------------------------------------------------------------------

  function mount() {
    const container = document.querySelector('.chat-container');
    if (!container) return false;
    if (!buildPresentTab()) return false;

    new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches('[role="article"]')) processArticle(node);
          else node.querySelectorAll('[role="article"]').forEach(processArticle);
        }
      }
    }).observe(container, { childList: true, subtree: true });

    // Lets pbn-chat-declutter.user.js (if also installed) know it should
    // stop touching the categories this script now owns outright.
    document.documentElement.dataset.pbnRoomPresenceActive = '1';
    return true;
  }

  if (!mount()) {
    const waiter = new MutationObserver(() => { if (mount()) waiter.disconnect(); });
    waiter.observe(document.body, { childList: true, subtree: true });
  }
})();
