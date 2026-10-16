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

With a userscript manager installed, click a raw link below. The manager
will open an install screen — review it and click **Install**.

### Recommended: PbN Toolkit (everything in one)

**[`pbn-toolkit.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-toolkit.user.js)**
contains every feature described below in a single install. Each feature can
be switched on or off, and their settings live in one panel: on the play
page open the in-game **Settings** tab and click **Open PbN Toolkit** (or
press **Alt+Shift+T** anywhere on the site).

- **Already using the separate scripts?** Install the toolkit alongside them.
  For every feature the toolkit has switched on, the separate script steps
  aside automatically, so nothing shows up twice. Your saved settings carry
  over (button lists, description presets, languages, card order); the
  toolkit's panel tells you which separate scripts you can now uninstall.
- **Changes in the panel** (switching features, their settings) apply after
  a page reload; the panel offers a **Reload now** button.
- **Export / Import** in the panel backs up or moves everything the toolkit
  stores — useful because it's kept in this browser's site storage, which
  clearing the site's data would wipe.

New features are added to the toolkit.

### The separate scripts

These still work and still get fixes, so there's no need to switch if
they're doing what you want. Each one stands down by itself if the toolkit
is installed with that feature switched on.

| Script | Install |
| ------ | ------- |
| Command Buttons | [`pbn-command-buttons.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-command-buttons.user.js) |
| Typing Indicator De-Shift | [`pbn-typing-indicator-deshift.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-typing-indicator-deshift.user.js) |
| Layout Lock | [`pbn-layout-lock.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-layout-lock.user.js) |
| Chat Log | [`pbn-chat-log.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-chat-log.user.js) |
| Chat Timestamps | [`pbn-chat-timestamps.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-chat-timestamps.user.js) |
| Compass Tools | [`pbn-compass-tools.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-compass-tools.user.js) |
| Character Cards | [`pbn-character-cards.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-character-cards.user.js) |
| Description Presets | [`pbn-desc-presets.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-desc-presets.user.js) |
| Language Switcher | [`pbn-speak.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-speak.user.js) |

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

### Per-character buttons

Each character can have **its own button list** or use the **shared list**
(the one everyone starts with; an existing setup becomes the shared list
automatically).

Open the editor while playing a character and the top line reads
"*Name* uses: ( ) the shared list ( ) its own list":

- **its own list** — edit buttons only that character sees. The first time,
  it starts as a copy of the shared list, so you only change what differs.
- **the shared list** — edit the list every character without its own list
  uses. Picking this for a character that had its own list and saving
  deletes that own list (the editor says so before you save).

The bar switches automatically when you play a different character. The
character is read from the journal sidebar's title; if the editor is opened
somewhere it can't see one, it simply edits the shared list.

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

Adds a **Save Log** button to the chat tab bar. Messages are captured to memory as they arrive, and clicking the button downloads the full session as a plain `.txt` file named `pbn-log-YYYY-MM-DD-HHMMSS.txt`.

- **RP tab only.** The log matches what the RP tab shows; anything the game routes to the Activity tab is left out.
- **Recorded from the game's own message list, not the screen**, so it keeps going no matter how long the session runs or how busy the room gets. (Versions before 1.1.0 read the chat on screen and could silently stop partway through a session.)
- **Server timestamps** where the game provides them; otherwise the time the message arrived.
- **Readable lines** — names, "says,"/"exclaims,", emotes and room tags are properly spaced (`[The Assembly Hall] Seamus says, "…"`).
- **No duplicates after reconnecting** — the game's "recent activity" replay is skipped for lines already logged, but anything you missed while disconnected is kept.

Nothing is written to browser storage — the log lives in memory only and is gone when the tab closes. Messages already in the chat when the script loads are included too.

### Search

A **Search** button sits next to **Save Log**. Type to search the chat: the newest match scrolls to the middle of the chat, gets outlined, and every match is highlighted.

- **Enter** — next older match · **Shift+Enter** — next newer match (or use ▲ / ▼). The counter reads e.g. `2 / 7`, counted from the newest.
- **Esc** (or ✕) closes the search and clears the highlights.
- Case and spacing don't matter, so `vergil says` finds lines where the game runs the name and "says," together.

Search covers the messages currently in the chat. The game only keeps the last 500 on the page; anything older is still in your **Save Log** file. Messages you've hidden (below) are skipped.

### Hide

**Hide** temporarily removes messages from the chat, for clean screenshots or for backreading without a wall of whispers. Click it for:

- **Whispers**, **System messages**, **OOC & LOOC** — tick to hide every message of that kind, including ones that arrive while it's on. "Whispers" covers whispers to you, overheard whispers, and the "X whispers to Y" / "A whisper brushes…" notices.
- **Pick messages to hide…** — click messages to hide them. While picking, hidden messages stay faintly visible and struck through so you can click them back; press **Done** (or Esc) to finish. The button then shows how many you've hidden (`Hide · 3`).
- **Show all hidden** — brings everything back and turns the filters off.

It's display-only and deliberately temporary: nothing is saved, a reload or switching chat tabs brings everything back, and your **Save Log** file still contains every message.

This script has no configurable options.

---

## PbN Chat Timestamps

Shows an `HH:MM` timestamp in front of every chat message, styled to blend in with the chat's own font rather than looking like an add-on.

Messages already on screen when the script loads are stamped with the time you loaded the page (their real arrival time isn't known), same trade-off [PbN Chat Log](#pbn-chat-log) makes for its own backfill.

The timestamp is rendered as generated content, not real text, so it never shows up duplicated inside a [PbN Chat Log](#pbn-chat-log) export — the exported file's own `[YYYY-MM-DD HH:MM:SS]` prefix is unaffected either way.

This script has no configurable options.

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

### Up / Down

The game's own Up/Down exit buttons normally sit below the whole map area and vanish entirely when a room has no vertical exit. They're replaced by an **↑ Up / ↓ Down** bar directly under the compass that's always there:

- In **Walk** mode they move you up or down, and are greyed out when that exit doesn't exist. Locked, broken and aerial exits keep the game's colour coding, and hovering shows the destination.
- In **Look** / **Search** mode both are always clickable and send `/look up`, `/search down`, etc.

This script has no configurable options.

---

## PbN Character Cards

Lets you reorder your character cards on the **My Characters** page, choose
how many appear per row, and tidies the per-card actions.

- **Reordering** — every card gets ▲ / ▼ buttons next to its View/Make
  Active/Options actions; click to move it earlier or later in the grid.
- **Cards per row** — a small +/- stepper appears above the grid to control
  how many cards fit across a row.
- **Options menu** — the **Delete** button is replaced by **Options ▾**, a
  dropdown holding Delete plus the card's **Request a recast** and **Take
  Leave** buttons (only the ones that card actually has). Those used to sit
  in their own rows above the actions; now they're out of the way. Each menu
  entry triggers the site's original button, so any confirmation dialogs work
  exactly as before.

Both the order and the per-row count are remembered per browser and
re-applied automatically the next time you open the page. If you create or
delete a character, new cards join the end of your saved order and removed
ones are quietly dropped from it — nothing to fix up by hand.

This script has no configurable options.

---

## PbN Description Presets

Save your `/setdesc` looks as named presets and swap between them in one click: hooded and revealed, disguised and not, in and out of costume.

A preset can include any mix of the four description fields: **short description**, **full description**, **arrive message** and **depart message**. Applying it only changes the fields it includes, so a "Hood up" preset can swap the descriptions while leaving your entrance and exit lines alone.

Presets are kept **per character**, so each of your characters has their own list.

### Saving a preset

1. Open `/setdesc` and set the fields the way you want this look to be.
2. In the **Presets** row at the top of the dialog, click **Save current as preset…**.
3. Name it, untick any fields this look shouldn't change, and click **Save preset**. Saving under an existing name asks before replacing it.

Clicking a preset in that row fills the dialog's fields; check them and press the dialog's own **Save**. The preset matching what's currently in the fields is highlighted. **×** deletes a preset (your actual description isn't touched).

### Switching in one click

A **masks icon** sits next to the mood icon at the right end of the command box. Click it and pick a look: the script opens `/setdesc` out of sight, fills it in and saves it, and the game confirms with its usual "description(s) have been updated" line. Whatever you were halfway through typing in the command box is put back. The look you last applied has a ✓.

If the game rejects the change (for example, a short description over its length limit), the dialog is shown so you can see why.

Presets are stored per browser/device, like the other scripts' settings. This script has no configurable options.

---

## PbN Language Switcher

Switch which language you `/speak` in with a click, and see at a glance which one you're currently using.

A **translate icon** sits with the other icons at the right end of the command box. While you're speaking anything other than English it turns gold and shows a short badge (e.g. `LAT`). Click it for a menu:

- **English and your known languages** — click one to send `/speak <language>`. The current one has a ✓.
- **1×** next to each language — "next line only": adds `[language]` to the line you're typing without changing your default (`/say hello` → `/say [spanish] hello`; an empty box starts a `/say [spanish] `).
- **Manage languages…** — tick which languages this character knows.

### Why you have to tell it your languages

The game has no command that lists which languages a character has claimed. So the script keeps that list itself, **per character**: tick your languages once under **Manage languages…**. After that it mostly maintains itself:

- When the game says **"You have learned X."** (after `/speak learn x`), X is added automatically.
- When the game says **"You will now speak in X."**, X is marked current (and added if it wasn't listed).
- **"You go back to speaking plain English."** switches the badge back.

The current language only changes when the game confirms it, so if a switch is refused the badge stays truthful. Only the game's own system lines count; another player quoting those phrases in chat doesn't affect anything.

The list is stored per browser/device. This script has no configurable options.

---

## Updating

Userscript managers check `@updateURL` periodically and offer updates
automatically. To update immediately, open your manager's dashboard, find the
script, and use its **Check for updates** action — or simply reinstall from the
links above.

## License

See the repository for license details.
