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
| Compass Tools | [`pbn-compass-tools.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/scripts/pbn-compass-tools.user.js) |

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

## Updating

Userscript managers check `@updateURL` periodically and offer updates
automatically. To update immediately, open your manager's dashboard, find the
script, and use its **Check for updates** action — or simply reinstall from the
links above.

## License

See the repository for license details.
