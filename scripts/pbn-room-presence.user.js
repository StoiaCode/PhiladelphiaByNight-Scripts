// ==UserScript==
// @name         PbN Room Presence
// @namespace    stoia.red
// @version      1.5.0
// @description  Tracks who's actually in the room (via enter/leave lines, resynced by /look) in a new "Present" tab, and draws momentary arrows for looks/whispers/mentions instead of leaving them as chat spam.
// @match        https://philadelphiabynight.net/play
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
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
  // Each word optionally ends in a period, but ONLY when followed by
  // whitespace (lookahead, so the whitespace stays available as the
  // separator between words) — confirmed real bug: "Ms. Clement" without
  // this truncated to just "Ms", since the character class doesn't include
  // "." and the next-word repeat group requires \s immediately after,
  // which the period blocked. The lookahead specifically excludes a period
  // at the very end of the string with nothing after it (an ordinary
  // sentence-ending period), so this can't accidentally swallow the full
  // stop off the end of an unrelated one-word sentence. Kept in sync with
  // declutter's copy.
  const NAME_WORD = "\\p{Lu}[\\p{L}\\p{N}'-]*(?:\\.(?=\\s))?";
  const NAME_RE = new RegExp(`^(${NAME_WORD}(?:\\s${NAME_WORD}){0,3})`, 'u');
  const NAME_STOPWORDS = new Set(['A', 'An', 'The', 'Someone', 'Something', 'There', 'It', 'This', 'That']);
  const NON_MOVEMENT_RE = /^[-"[]/;
  const MAX_MOVEMENT_LEN = 200;
  // Guards resolveAgainstRoster()'s anonymous-prefix-match against a very
  // short registered key (shouldn't happen given NAME_STOPWORDS, cheap safety).
  const MIN_PREFIX_KEY_LEN = 8;

  // CORRECTED per user: only the direction word itself is solid — the
  // connecting preposition is player-composed flavor text just like
  // everything else surrounding it, so trying to whitelist specific
  // leave-prepositions ("to"/"towards"/"in the direction of", and whatever
  // else hasn't shown up yet) is a losing battle, not a fixable regex.
  // "from" is the one exception: it's close to impossible to phrase
  // "arriving from a place" any other way in English, so it stays as the
  // dedicated enter anchor. Leaving is instead defined as "a bare direction
  // word is present, and it's not part of an enter phrase" — no leave
  // preposition list at all. "in"/"out" are deliberately excluded from the
  // direction list itself: unlike the compass points and up/down/above/
  // below (all separately confirmed in real traffic), bare "in"/"out" have
  // no confirmed use as an actual movement direction in this game, and
  // they're common enough as ordinary English words that including them
  // here would make the now-looser "any direction word" leave check fire
  // constantly on unrelated prose.
  const DIRECTION_WORD = 'north|south|east|west|northeast|northwest|southeast|southwest|up|upward|down|downward|above|below';
  const DIRECTION_PHRASE = `(?:the\\s+)?(?:${DIRECTION_WORD})\\b`;
  // CORRECTED per user (again): "from" isn't always adjacent to the
  // direction word either — confirmed real example "creeps in from the
  // shadows of the east." has descriptive flavor text wedged in between,
  // so requiring "from" to sit directly next to the direction (only "the"
  // allowed in between) made ENTER_RE miss it entirely, and it fell through
  // to being misread as a LEAVE. [\s\S]*? (lazy, matches anything including
  // nothing) now bridges an arbitrary gap between "from" and the direction
  // word — this also means "from" no longer has to be the word immediately
  // governing the direction, just has to appear somewhere BEFORE it, which
  // is enough to rule out cases where "from" trails the direction instead
  // (e.g. a leave phrased as "...heads towards the west, moving away from
  // prying eyes" — "from" comes after "west" there, so this still wouldn't
  // false-positive as an enter).
  const ENTER_RE = new RegExp(`\\bfrom\\b[\\s\\S]*?${DIRECTION_PHRASE}`, 'iu');
  const DIRECTION_ANY_RE = new RegExp(`\\b${DIRECTION_PHRASE}`, 'iu');
  // Still known, deliberately not chased (per explicit call — /look's
  // periodic resync is the safety net for exactly this): some lines
  // describe movement with no direction word anywhere at all, e.g.
  // "Sparrow steps aboard the waiting train." or "Coyote Duran drags her
  // feet along downward." (that one WAS a direction word once, before this
  // rework — now correctly still unclassifiable on its own, since "along
  // downward" is not "from" and IS a bare direction, meaning it now
  // actually resolves as a LEAVE. Worth re-confirming live.) When no
  // direction word is present at all, the roster simply doesn't update
  // from that line; the next /look resync corrects any drift. Intentional
  // — graceful drift, not perfection — and pbn-chat-declutter.js (if
  // installed) still handles unrecognized lines via its own grouping.

  // Confirmed real example, no direction phrasing at all ("Weevil seems to
  // suddenly exist where a moment ago there was nothing.") — reads like a
  // fixed message tied to a specific mechanic (dropping a concealment
  // power, most likely) rather than customizable flavor text, similar to
  // how LOOKS_AROUND_RE is fixed. Treated as its own supplementary enter
  // signal alongside ENTER_RE.
  const MATERIALIZE_RE = /^(.+) seems to suddenly exist where a moment ago there was nothing\.$/i;

  // Duplicated from declutter, same wording/caveat — used here not to hide
  // the line (declutter, if installed, already owns that) but as an
  // additional enter/leave-equivalent signal for the roster specifically:
  // entering torpor means someone isn't really present/active anymore,
  // waking up brings them back. Read-only — never touches the article's DOM.
  const TORPOR_RE = /\bentered torpor\b/i;
  const AWOKEN_RE = /\bhas awoken\b/i;

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

  // CONFIRMED live: the roster listing is NOT part of the [LOCATION]-tagged
  // room-description article at all — it's its own separate article with no
  // [LOCATION]/[SYSTEM] tag, identified instead by <p class="look-output">:
  //   <p class="look-output"><strong>You see:</strong><br>\n• Sparrow</p>
  // An empty room instead renders <p class="look-output"><em>There is no
  // one else of note here.</em></p> (no "You see:" at all) — treated as a
  // confirmed empty roster, not "not a resync payload." Bullet glyph "•"
  // and the <br>-separated-lines shape are both confirmed; the exact
  // separator between multiple bullets (single vs. double <br>) is not yet
  // seen firsthand (only one person was present when this was captured),
  // but the parser already tolerates blank lines between bullets either way.
  const LOOK_OUTPUT_SELECTOR = 'p.look-output';
  const NO_ONE_ELSE_RE = /^There is no one else of note here\.?$/i;
  const YOU_SEE_RE = /^You see:?$/i;
  const ROSTER_BULLET_RE = /^[•\-*]\s*/;

  // CORRECTED per user: this narrative divider (no [SYSTEM]/[LOCATION] tag
  // at all — <p class="narrative"><em>-- You are now here --</em></p>) only
  // ever appears once, on initial login/connect — NOT on every room
  // arrival as originally assumed. Kept only as the trigger for that first
  // room; ordinary movement is YOU_MOVE_RE below.
  const NARRATIVE_SELECTOR = 'p.narrative';
  const YOU_ARE_NOW_HERE_RE = /^--\s*You are now here\s*--$/i;

  // The real, ordinary per-move signal (confirmed): "You move down to
  // Frankford & Girard Corner." — a normal SELF_RE-matching SYSTEM line, so
  // it must be checked for before SELF_RE's generic "ignore all You...
  // lines" short-circuit swallows it. Same room-transition handling as the
  // login divider above: whatever was in the roster belonged to the room
  // you just left.
  const YOU_MOVE_RE = /^You move\b/i;

  // This script can never learn your own character's name from anything it
  // observes — self-referential lines always say "You" ("You look around",
  // "You are in <room>"), and you never appear in your own /look roster
  // listing either. Stored via GM_getValue/GM_setValue (not a source
  // constant) so setting it doesn't require editing the script itself,
  // which would break @updateURL auto-updates — same pattern as
  // pbn-command-buttons.user.js's editable button list. Configure it via
  // the userscript menu: Violentmonkey/Tampermonkey icon -> "Set my
  // character name". Leave blank to just never track yourself — everyone
  // else still works normally either way.
  const MY_NAME_STORAGE_KEY = 'pbn_my_character_name';

  function loadMyCharacterName() {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(MY_NAME_STORAGE_KEY, '') || '';
    } catch (e) { /* fall through to blank */ }
    return '';
  }

  function saveMyCharacterName(name) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(MY_NAME_STORAGE_KEY, name);
    } catch (e) { /* storage unavailable; the live value still updates this session */ }
  }

  let myCharacterName = loadMyCharacterName();

  // How long a drawn arrow stays visible before fading out. Tune to taste.
  const ARROW_FADE_MS = 5000;
  // Minimum registered-name length before a substring match in dialogue is
  // trusted as a deliberate mention rather than common-word noise.
  const MIN_MENTION_NAME_LEN = 4;
  // Off by default: a bare first name ("Cade") collides with common words
  // far more than a full registered name ("Cade Karstenson") does, and this
  // can't be tuned without live false-positive data.
  const MATCH_FIRST_NAME_ONLY = false;

  // Confirmed real bug: an anonymous character's very first mention (e.g.
  // "A quiet blonde woman with a baseball cap enters from below.") has
  // nothing to resolve against — no existing roster entry to prefix-match,
  // and no fixed suffix in THIS message to isolate her description from
  // the verb — so it was silently dropped entirely. Ported from declutter:
  // if a later unidentified line shares a long exact leading run with this
  // one, that shared prefix IS the description (a fixed field only the
  // trailing flavor varies around), letting the pair resolve each other
  // even with no clean anchor in either message alone. Same threshold/
  // reasoning as declutter's copy.
  const MIN_LCP_LEN = 20;

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

  // Deliberately does NOT collapse whitespace (unlike getSystemText) — the
  // roster bullet list's line structure is load-bearing. Uses innerText (not
  // textContent) so <br>-driven line breaks are preserved as \n.
  function getLookOutputText(article) {
    const p = article.querySelector(LOOK_OUTPUT_SELECTOR);
    if (!p) return null;
    return p.innerText || '';
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

  // Short buffer of recent lines that couldn't be identified at all (e.g.
  // an anonymous character's very first mention). Ported from declutter —
  // see MIN_LCP_LEN above for why this matters.
  const recentOrphans = []; // { text, node }[]
  const ORPHAN_BUFFER_MAX = 20;

  function recordOrphan(text, node) {
    recentOrphans.push({ text, node });
    if (recentOrphans.length > ORPHAN_BUFFER_MAX) recentOrphans.shift();
  }

  // Longest run of identical leading characters — see declutter's copy for
  // the full reasoning (it can only stop where two texts actually first
  // differ, which for a fixed description + arbitrary flavor text is
  // exactly the boundary between them).
  function commonPrefix(a, b) {
    let i = 0;
    const len = Math.min(a.length, b.length);
    while (i < len && a[i] === b[i]) i++;
    return a.slice(0, i);
  }

  // Last-resort fallback for a fully unidentified line: does it share a
  // long enough leading run with some other still-unidentified recent line
  // to infer they're the same anonymous character? Picks the best
  // (longest) match among buffered orphans rather than the first one found.
  function findOrphanBySimilarity(text) {
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

  function clearRoster() {
    for (const entry of uniqueRosterEntries()) removeRosterEntry(entry);
  }

  // Called on any signal that you've moved to a different room (the
  // login-only narrative divider, or an ordinary "You move ... to ..."
  // line) — whatever was tracked belonged to the room you just left.
  function handleRoomTransition() {
    clearRoster();
    if (myCharacterName) upsertRoster(myCharacterName, 'self');
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

  function parseRosterBullets(lookText) {
    if (NO_ONE_ELSE_RE.test(lookText.trim())) return []; // confirmed empty room
    const lines = lookText.split('\n').map(l => l.trim());
    const start = lines.findIndex(l => YOU_SEE_RE.test(l));
    if (start === -1) return null; // some other kind of look-output, not a roster payload
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
    if (SELF_RE.test(text)) {
      if (YOU_MOVE_RE.test(text)) handleRoomTransition();
      return true;
    }
    if (NON_MOVEMENT_RE.test(text) || text.length > MAX_MOVEMENT_LEN) return true; // e.g. Daily News — leave alone

    const looksAt = LOOKS_AT_RE.exec(text);
    if (looksAt) { handleLooksAt(looksAt[1].trim(), looksAt[2].trim(), article); return true; }

    const whisper = WHISPER_RE.exec(text);
    if (whisper) { handleWhisper(whisper[1].trim(), whisper[2].trim(), article); return true; }

    const looksAround = LOOKS_AROUND_RE.exec(text);
    if (looksAround) {
      hideKeepText(article);
      const subject = looksAround[1].trim();
      // LOOKS_AROUND_RE's fixed suffix cleanly isolates the subject even
      // when anonymous — use it to confirm presence (they're doing
      // something, so they're here) whether or not we ever saw them enter.
      const name = extractLeadingName(subject);
      if (name) {
        upsertRoster(name, 'enter');
      } else {
        const resolved = resolveAgainstRoster(subject);
        if (resolved) {
          upsertRoster(resolved.key, 'enter');
        } else {
          const similar = findOrphanBySimilarity(subject);
          if (similar) upsertRoster(similar.key, 'enter');
          else recordOrphan(subject, article);
        }
      }
      return true;
    }

    // Torpor/awoken: roster-only signals, never hide the line — declutter
    // (if installed) already owns hiding/reconnect-suppression for these.
    if (TORPOR_RE.test(text)) {
      const resolved = resolveAgainstRoster(text);
      if (resolved && resolved.existing) removeRosterEntry(resolved.existing);
      return true;
    }
    if (AWOKEN_RE.test(text)) {
      const resolved = resolveAgainstRoster(text);
      if (resolved) upsertRoster(resolved.key, 'awoken');
      return true;
    }

    const materialize = MATERIALIZE_RE.exec(text);
    if (materialize) {
      // Same fixed-suffix reasoning as LOOKS_AROUND_RE — the captured group
      // is already the clean identity, named or anonymous, no extra
      // resolution needed.
      upsertRoster(materialize[1].trim(), 'enter');
      hideKeepText(article);
      return true;
    }

    // No direction word at all — genuinely can't classify, leave for
    // declutter's fallback grouping (e.g. "steps aboard the waiting train.").
    if (!DIRECTION_ANY_RE.test(text)) return true;

    const enters = ENTER_RE.test(text);
    // Has a direction word but isn't an enter — treat as a leave. No leave
    // preposition list needed at all; see the comment on DIRECTION_WORD.

    let resolved = resolveAgainstRoster(text);
    if (!resolved) {
      // Anonymous and never seen before — last resort, see if this line
      // shares a long exact leading run with another still-unidentified
      // recent line (e.g. this same anonymous character's entry, found via
      // a later exit that happens to share the same description prefix).
      const similar = findOrphanBySimilarity(text);
      if (similar) resolved = { key: similar.key, existing: roster.get(similar.key) || null };
    }
    if (!resolved) {
      // Still nothing — buffer it in case a later line (an exit, another
      // "looks around.", anything) reveals who this was.
      recordOrphan(text, article);
      return true;
    }

    if (enters) upsertRoster(resolved.key, 'enter');
    else if (resolved.existing) removeRosterEntry(resolved.existing);
    hideKeepText(article);
    return true;
  }

  function getNarrativeText(article) {
    const p = article.querySelector(NARRATIVE_SELECTOR);
    return p ? (p.textContent || '').trim() : null;
  }

  // Returns true if this article was the login-only narrative divider.
  function handleNarrativeArticle(article) {
    const text = getNarrativeText(article);
    if (text === null) return false;
    if (YOU_ARE_NOW_HERE_RE.test(text)) handleRoomTransition();
    return true;
  }

  // Returns true if this article was look-output-tagged at all (a room
  // description article's own [LOCATION] tag does NOT match this — the
  // roster listing is a separate article, see LOOK_OUTPUT_SELECTOR above).
  function handleLookOutputArticle(article) {
    const text = getLookOutputText(article);
    if (text === null) return false;
    const bullets = parseRosterBullets(text);
    if (bullets !== null) resyncRoster(bullets);
    return true;
  }

  // --------------------------------------------------------------------------
  // Mention arrows — dialogue (say/pose/LOOC) lines only
  // --------------------------------------------------------------------------

  // Confirmed live: the speaker-name span's class isn't the fixed
  // "chat-name-anonymous" seen earlier this session for one character — it's
  // a per-character class ("chat-name-color-8", "chat-name-color-12", ...),
  // with "chat-name-anonymous" apparently just one of several variants
  // (unclear whether it's a genuine fallback or specific to some character
  // state). Match the whole family by prefix instead of one fixed class.
  function getDialogueSpeaker(article) {
    const nameSpan = article.querySelector('[class^="chat-name-"]');
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
    if (handleNarrativeArticle(article)) return;
    if (handleLookOutputArticle(article)) return;
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

    // Seed immediately in case the room was already established (and its
    // arrival trigger already scrolled past) before this script mounted —
    // the next real room transition still re-adds you fresh regardless.
    if (myCharacterName) upsertRoster(myCharacterName, 'self');

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

  // --------------------------------------------------------------------------
  // Settings (opened from the userscript menu)
  // --------------------------------------------------------------------------

  // Applies a name change immediately (removing any stale entry registered
  // under the old name) rather than waiting for the next room transition.
  function promptForCharacterName() {
    const next = window.prompt(
      "Enter your character's exact display name (as other people would see it in an enter/leave line). Leave blank to stop tracking yourself:",
      myCharacterName
    );
    if (next === null) return; // cancelled
    const trimmed = next.trim();
    if (myCharacterName) {
      const oldEntry = roster.get(myCharacterName);
      if (oldEntry) removeRosterEntry(oldEntry);
    }
    myCharacterName = trimmed;
    saveMyCharacterName(myCharacterName);
    if (myCharacterName) upsertRoster(myCharacterName, 'self');
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Set my character name', promptForCharacterName);
  }
})();
