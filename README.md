# PhiladelphiaByNight Userscripts

A small collection of userscripts that improve the [Philadelphia by Night](https://philadelphiabynight.net/)
web client. All scripts only run on `https://philadelphiabynight.net/*` and
require no account or server-side setup.

## Requirements

A userscript manager browser extension:

- [**Violentmonkey**](https://violentmonkey.github.io/) (recommended, free, open source)
- [**Tampermonkey**](https://www.tampermonkey.net/)
- Greasemonkey (Firefox) should also work

## Installation

With a userscript manager installed, click a script's raw link below. The
manager will open an install screen — review it and click **Install**.

| Script | Install |
| ------ | ------- |
| Command Buttons | [`pbn-command-buttons.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-command-buttons.user.js) |
| Typing Indicator De-Shift | [`pbn-typing-indicator-deshift.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-typing-indicator-deshift.user.js) |
| Layout Lock | [`pbn-layout-lock.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-layout-lock.user.js) |
| Chat Log | [`pbn-chat-log.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-chat-log.user.js) |
| Chat Declutter | [`pbn-chat-declutter.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-chat-declutter.user.js) |
| Room Presence | [`pbn-room-presence.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-room-presence.user.js) |
| Compass Tools | [`pbn-compass-tools.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-compass-tools.user.js) |
| Craft Helper | [`pbn-craft-helper.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-craft-helper.user.js) |

Each script declares `@updateURL`/`@downloadURL`, so your manager will pull
updates automatically when this repo changes. After installing, reload any
open Philadelphia by Night tab.

---

## PbN Command Buttons

Adds a row of quick-command buttons (OOC, Say, Emote, Roll, …) just above the
MUSH command input, so common commands are one click away instead of a typed
prefix.

### Using the buttons

Buttons behave in one of three ways, depending on how each command is configured:

- **Paste** (default) — clicking inserts the command (e.g. `/say `) into the
  input with a trailing space, ready for you to type the rest, then press Enter
  yourself. If you already typed something, it's kept; switching from one
  paste-command to another swaps the leading command instead of stacking them
  (e.g. `/say hello` → click **Emote** → `/emote hello`).
- **Submit** — clicking sends the command immediately, no typing needed (used
  for things like **Hide**, **Roll**, **Char**).
- **Expand** — the first click opens a small inline text field; type your
  argument and press Enter (or click the button again) to send `cmd + text`.
  Press Escape or click elsewhere to cancel.

### Editing the command list (no script editing)

You can change which buttons appear — and what they do — entirely in the
browser. Edits are saved permanently by your userscript manager and survive
reloads and browser restarts.

1. Click your userscript manager's toolbar icon (Violentmonkey/Tampermonkey).
2. Choose **"Edit command buttons"** from the script's menu.
3. A JSON editor opens. Adjust the list and click **Save** — the button bar
   updates instantly.

Each entry is an object with these fields:

| Field | Required | Meaning |
| ----- | -------- | ------- |
| `label` | yes | The text shown on the button. |
| `cmd` | yes | The command pasted/sent (e.g. `/say`). |
| `submit` | no | `true` = send immediately on click. |
| `expand` | no | `true` = open an input field for an argument first. |

`submit` and `expand` are mutually exclusive — set at most one. Omit both for a
plain paste button.

Example:

```json
[
  { "label": "OOC",   "cmd": "/ooc" },
  { "label": "Say",   "cmd": "/say" },
  { "label": "Hide",  "cmd": "/hide", "submit": true },
  { "label": "Look",  "cmd": "/look", "expand": true }
]
```

The editor validates your JSON before saving and shows an error if anything is
malformed, so a typo won't break the bar. **Reset to defaults** reloads the
built-in list into the editor (click **Save** to apply it). **Cancel**,
Escape, or clicking outside the panel discards changes.

> Note: settings are stored per browser/device, so if you play on more than one
> machine you'll configure each once.

### Advanced (in-script) options

A couple of settings still live at the top of the script for power users:

- `INPUT_SELECTOR` — leave `''` for auto-detection of the command box. If
  auto-detect picks the wrong field, set a CSS selector here (e.g.
  `'textarea[aria-label="Command"]'`).
- `SWAP_LEADING_COMMAND` — `true` (default) makes switching paste-commands
  replace the leading command instead of stacking.

---

## PbN Typing Indicator De-Shift

Stops the "X is typing…" indicator from pushing the command input around. By
default the indicator is floated just above the input box so it no longer
shifts your layout while you type.

This script has no in-page UI; behavior is controlled by two constants at the
top of the script:

- `HIDE_ENTIRELY` — `false` (default) floats the indicator above the input so
  it never moves the box. Set `true` to hide the indicator completely (zero
  shift, but you lose the visual cue).
- `GAP` — gap in pixels between the indicator and the top of the input
  (default `4`).

To change these, edit the script in your userscript manager's dashboard.

---

## PbN Layout Lock

Locks the play page to exactly the height of your browser window so there is
never a page-level scrollbar. The chat log shrinks to fill whatever space is
left after the command bar and tab controls, and scrolls internally. The right
info panel (room description, map, etc.) scrolls independently — if a room
description is long enough to force a scroll, it only scrolls that panel, not
the whole page.

This script has no configurable options.

---

## PbN Chat Log

Adds a **Save Log** button to the chat tab bar. Messages are captured to memory as they arrive (timestamped at the moment they appear), and clicking the button downloads the full session as a plain `.txt` file named `pbn-log-YYYY-MM-DD-HHMMSS.txt`.

Nothing is written to browser storage — the log lives in memory only and is gone when the tab closes. Messages already on screen when the script loads are backfilled with the session-start timestamp.

This script has no configurable options.

---

## PbN Chat Declutter

Cuts down on `[SYSTEM]` spam without dropping any information.

- **Per-actor movement grouping** — every `[SYSTEM]` narrative line renders in a muted grey tone as soon as it arrives, so none of it stands out the way an important system message would, even lines about characters that can't be identified at all. Each actor gets their own independent grouping thread, so a busy room's dialogue and other people's movement no longer breaks anyone's block — Coyote Duran's arrival and his exit ten messages later (with a dozen unrelated lines in between) still collapse into one compact block: the name shown once, each original line as its own short row, all in that same tone. A thread stays open for about a screen's worth of chat lines (dialogue included) since it was last extended; once that much has scrolled by, the next matching line starts a fresh block instead of silently growing a stale one.
  - **Follow-chains** bridge the group even when a follower has no proper name — some characters show an anonymous/masked description instead ("an immaculately dressed, but horribly unkempt lady") — as long as their line names who they're following.
  - **Anonymous characters without a follow-chain** can still be linked to themselves two ways: "X looks around." is never customized with flavor text (unlike enter/leave lines), so it reliably reveals X's description as an identity even when X has no name — and if an earlier unidentified line (like their entry) matches that description, it gets folded in retroactively. Even without a "looks around." at all, two custom-flavored lines about the same anonymous character (e.g. an entry and an exit, both heavily customized) still get linked if they share a long identical leading description — the fixed part always comes first, and whatever the two lines have in common in that leading run *is* the description, however different the flavor text after it gets.
- **Torpor/awoken await** — when someone else's SYSTEM line says they entered torpor, it's held back for a bit. If a matching "has awoken" line for the same person shows up within that window, both are suppressed entirely (it was just a flaky disconnect). If nothing shows up in time, the torpor message is revealed as normal. Your own torpor/awoken lines are never held back.
- **Non-movement SYSTEM content is left alone entirely.** Some `[SYSTEM]` messages aren't about anyone's movement at all — a "Daily News" feature, for instance, posts a headline, a multi-sentence article body, and bracket-tagged metadata as their own SYSTEM lines. None of that gets dimmed, grouped, or matched against — it renders exactly as the game intended.

This only changes what's *shown* — every original message is left fully intact in the page (just visually hidden when folded into a block), so [PbN Chat Log](#pbn-chat-log)'s exported session log is unaffected and still contains every line.

This script has no in-page UI. A few settings live at the top for power users:

- `TORPOR_AWAIT_MS` — how long to wait for a matching "awoken" line before revealing a torpor message, in milliseconds (default `30000`, i.e. 30 seconds).
- `SCREEN_WORTH_LINES` — how many chat lines (any type) an actor's thread can go without being extended before it's considered stale (default `18`). A rough approximation of "still visible without scrolling" — tune to taste.
- `NAME_MIN_WORDS` — minimum number of Title-Case words required to treat the start of a SYSTEM line as a real character name (default `1`, since single-word character names exist).
- `MIN_LCP_LEN` — minimum shared leading-text length (characters) before two unidentified anonymous lines are inferred to be the same character (default `20`). Lower risks merging two different people who happen to open similarly; higher misses shorter descriptions.

The exact wording the server uses for "entered torpor" and "has awoken" messages hasn't been directly observed yet — if the torpor await doesn't trigger on a real message, check the `TORPOR_RE`/`AWOKEN_RE` patterns near the top of the script and adjust them to match. (Follow messages and "looks around." are confirmed from real traffic.)

**If [PbN Room Presence](#pbn-room-presence) is also installed and active**, Chat Declutter stops dimming/grouping enter, leave, looks-around, looks-at, and whisper lines outright, deferring all of that handling to Room Presence instead. Torpor/awoken and non-movement passthrough are unaffected either way, and grouping continues normally for movement lines Room Presence's heuristics don't recognize.

---

## PbN Room Presence

Instead of trying to make `[SYSTEM]` movement spam *look* clean in the chat (Chat Declutter's approach), this tracks who's actually in the room as real state, so the spam can be removed from the chat entirely.

- **A "currently present" roster**, shown in a new **Present** tab next to the room panel — built incrementally from enter/leave lines, and periodically corrected by `/look`'s own "You see: • Name • Name…" listing, which self-heals any drift from a missed or unparseable enter/leave line. Enter/leave detection isn't perfect — a line with genuinely no direction phrasing at all (or, confirmed from real traffic, one describing boarding a vehicle — "steps aboard the waiting train" — rather than moving in a direction) is left alone rather than guessed at, and the next `/look` catches up.
- **Anonymous characters can be tracked from a single mention with no anchor at all**, not just from a "looks around." line — if a masked character's very first message can't be resolved on its own (nothing to isolate their description from the flavor text around it), it's held onto quietly, and the moment *any* later message about them shares a long stretch of identical leading text, both resolve each other and they're added. Still can't self-resolve from one isolated mention with no second message ever following it — `/look` remains the backstop for that.
- **Entering/waking from torpor count as leaving/entering too** — a torpored character isn't really present for RP purposes, so "entered torpor" removes them from the roster and "has awoken" brings them back. This is read-only, though: it never hides the torpor/awoken line itself — [PbN Chat Declutter](#pbn-chat-declutter)'s own hiding and flaky-reconnect suppression for these lines is unaffected either way.
- **The roster resets on every room change**, not just on `/look` — the game's own self-referential "You move ... to ..." line (or, only on initial login, the one-time "-- You are now here --" divider) is used as the signal that whatever was tracked belonged to the *previous* room and is now stale.
- **Your own character can be included too** (see "Setting your character name" below), since you can never be inferred automatically: self-referential lines only ever say "You", and you never appear in your own `/look` listing.
- **Enter, leave, and "looks around" lines are hidden from chat entirely** once Room Presence is tracking — the Present tab is the only visible trace of that activity.
- **Momentary arrows for "looks at" and "whispers to."** Instead of a chat line, a line is drawn from the actor's row to the target's row in the Present tab and fades out after a few seconds. If the Present tab isn't open when one of these happens, the arrow is skipped (not queued) — the line is still hidden from chat either way.
- **Mention arrows** — when someone's dialogue names another currently-present person, the same kind of arrow draws from speaker to mentioned person. Only matches named (non-anonymous) roster members, word-bounded and case-sensitive, to avoid false-positiving on ordinary words that happen to match part of someone's name.

### Setting your character name

Click your userscript manager's toolbar icon (Violentmonkey/Tampermonkey) and choose **"Set my character name"** from the script's menu, then enter your character's exact display name. This is stored in userscript storage, not the script's source — so it survives updates instead of fighting with `@updateURL` the way editing the script file directly would. Leave it blank to stop tracking yourself; everyone else keeps working normally either way. The change applies immediately, no reload needed.

A few more settings live at the top of the script for power users, same convention as every other script in this repo (see [Advanced (in-script) options](#advanced-in-script-options) under Command Buttons). Editing these directly has the same trade-off as editing any userscript's source: your manager may treat the file as locally modified and stop auto-updating it until you either revert the edit or manually re-apply it after each update. That's an acceptable trade for settings almost nobody needs to touch; it's why `MY_CHARACTER_NAME` specifically doesn't work this way — every single installer needs to set it.

- `ARROW_FADE_MS` — how long a drawn arrow stays visible before fading out (default `5000`, i.e. 5 seconds).
- `MIN_MENTION_NAME_LEN` — minimum registered-name length before a substring match in dialogue counts as a mention (default `4`).
- `MATCH_FIRST_NAME_ONLY` — `false` (default) requires a dialogue mention to match someone's full registered name; set `true` to also accept a bare first name (more mentions caught, more false positives from ordinary words that happen to be someone's first name).

**Confirmed live**, including a full pass against a real `/look`: the roster listing is its own separate message (`<p class="look-output">`, not the `[LOCATION]`-tagged room description), an empty room renders "There is no one else of note here." instead of a bullet list, and dialogue speaker names use a per-character class (`chat-name-color-N`, not a single fixed class) — mention-matching accounts for this. **Still an open caveat:** the exact markup of the game's own Info/Actions/Settings tab bar hasn't been inspected, which is why the Present tab is rendered as an independent panel docked over that area rather than a true sibling tab — it doesn't depend on that markup at all, so this is a cosmetic-only gap, not a functional one.

---

## PbN Compass Tools

Shows the destination room name when you hover over an open compass direction, and adds a **Walk / Look / Search** mode toggle above the compass.

### Destination tooltips

Open compass directions (those that lead somewhere) show a tooltip with the room name on hover — extracted from the button's `aria-label` (`"Go north to Walk-In Freezer"` → tooltip `"Walk-In Freezer"`).

### Mode toggle

Three pill buttons appear above the compass:

- **Walk** (default) — compass clicks navigate normally, exactly as before.
- **Look** — clicking a direction sends `/look <direction>` to the command input instead of walking.
- **Search** — clicking a direction sends `/search <direction>` instead of walking.

The active mode is highlighted. The toggle persists for the session (resets to Walk on page reload). It works on every compass instance and survives SPA navigation.

This script has no configurable options.

---

## PbN Craft Helper

Adds a small panel above the command input to handle the multi-step crafting workflow without typing.

### Layout

```
Craft [▲]
[recipe name input          ] [▶ Start]   3 started
[Continue] [Careful] [Controlled] [Rush] [Abandon]
```

- **Recipe field** — type the recipe name once; it's saved in your browser and pre-filled on every reload.
- **▶ Start** — sends `craft start <recipe>`. Also triggers when you press Enter in the recipe field.
- **Continue** — sends `craft continue` (used twice per cycle: once after starting, once after choosing).
- **Careful / Controlled / Rush** — sends the corresponding `craft choose` command.
- **Abandon** — sends `craft cancel` to abort mid-craft.
- **Counter** — tracks how many crafts you've started this session. Click it to reset to zero.
- **▲ / ▼** — collapses or expands the panel.

The panel starts expanded and collapses to a single header line when you don't need it.

---

## Updating

Userscript managers check `@updateURL` periodically and offer updates
automatically. To update immediately, open your manager's dashboard, find the
script, and use its **Check for updates** action — or simply reinstall from the
links above.

## License

See the repository for license details.
