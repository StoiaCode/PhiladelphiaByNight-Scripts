# PbN Pair

For two (up to five) players who play together and keep stepping on each
other's toes: who answers the person who just addressed you both, who does
the introductions. Hover a chat line and:

- **✋ Mine** — "I'll answer this one." Everyone else sees *✋ Jane takes it* on that line.
- **→ Yours** — hand it over. It lights up on the others' screens, and their
  **Pair** button in the bottom-left corner turns gold (*→ 1 for you*; click it to
  jump to the line).
- **✕ Drop** — take a claim or hand-over back.

Claims and hand-overs fade after 10 minutes. Everyone in the room needs the
script; nobody else sees anything.

A line is recognised by what was said, without the speaker's name (that
differs between viewers: a name for one, a short desc for the other). If one
of you doesn't understand a language, the line looks different for you two,
but then only one of you can answer it anyway.

## Install

[`pbn-pair.user.js`](https://github.com/stoiacode/philadelphiabynight-scripts/raw/main/pair/pbn-pair.user.js)
in Violentmonkey or Tampermonkey. On the play page, click **Pair** in the
bottom-left corner:

- **Server** — your relay's address, `wss://…`
- **Shared key** — one of you clicks **Generate**, then **Copy**, and sends it to
  the others privately. Everyone pastes the same key.
- **Your name for them** — what the others see (*✋ Jane takes it*). Empty uses
  your character's name from the journal.

## The relay

A ~100-line Node server (one dependency, [`ws`](https://github.com/websockets/ws))
in [`relay/`](relay/). It passes messages between the browsers in the same
room and nothing else.

```bash
cd relay
docker compose up -d --build
```

The compose file expects an external Docker network called `pangolin` and
publishes no ports; point the reverse proxy at `pbn-pair-relay:8080` with
WebSockets enabled and TLS in front. `GET /health` answers `ok`.

### What the server sees, and doesn't

- **No chat text, ever.** The script only sends "line *hash*: claimed / handed
  over / dropped" plus your display name and a timestamp, and that is
  **encrypted in the browser** (AES-GCM) with a key derived from your shared key.
- **The room name** is a SHA-256 hash of the shared key, so the server can't
  work the key out from it.
- **Nothing is stored.** Rooms live in memory and vanish when the last person
  leaves. No content is logged.
- **Limits:** 5 people per room, 200 rooms, 2 KB per message, 30 messages per
  10 seconds per connection (more closes it), dead connections dropped after a
  missed ping. Only pages from `https://philadelphiabynight.net` may connect
  (`ALLOWED_ORIGINS` to change it). That stops other websites, not someone
  writing their own client, but without the key they can't read or forge
  anything, and messages older than two minutes are ignored.
- **The container** runs as an unprivileged user with a read-only filesystem,
  no capabilities, no privilege escalation, 64 MB of memory and 32 processes.
