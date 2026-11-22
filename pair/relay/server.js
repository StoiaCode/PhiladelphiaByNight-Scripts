'use strict';
// PbN Pair relay: passes small encrypted messages between the browsers in
// one "room" (up to 5). It stores nothing, logs no content, and can't read
// what it forwards: the browsers encrypt with a key the server never sees,
// and the room name is a hash of that key.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
// Only pages from these origins may connect (stops other websites; the real
// protection is the encryption and the unguessable room name).
const ORIGINS = new Set((process.env.ALLOWED_ORIGINS || 'https://philadelphiabynight.net')
  .split(',').map(s => s.trim()).filter(Boolean));
const MAX_PEERS = 5;        // per room
const MAX_ROOMS = 200;      // in total
const MAX_BYTES = 2048;     // per message
const RATE_N = 30;          // messages…
const RATE_MS = 10_000;     // …per this window, per connection
const PING_MS = 30_000;     // dead connections are dropped after one missed pong

const rooms = new Map(); // room -> Set<WebSocket>

const server = http.createServer((req, res) => {
  const ok = req.url === '/health';
  res.writeHead(ok ? 200 : 404, { 'content-type': 'text/plain' });
  res.end(ok ? 'ok' : '');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const reject = status => { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  if (!ORIGINS.has(req.headers.origin)) return reject('403 Forbidden');
  let room = '';
  try { room = new URL(req.url, 'http://relay').searchParams.get('room') || ''; } catch (e) { /* bad url */ }
  if (!/^[0-9a-f]{64}$/.test(room)) return reject('400 Bad Request');
  const peers = rooms.get(room);
  if (peers && peers.size >= MAX_PEERS) return reject('409 Conflict');
  if (!peers && rooms.size >= MAX_ROOMS) return reject('503 Service Unavailable');
  wss.handleUpgrade(req, socket, head, ws => join(ws, room));
});

// Tells everyone in the room how many are connected (no names: the server doesn't know any).
function announce(peers) {
  const msg = JSON.stringify({ sys: 'peers', n: peers.size });
  for (const p of peers) if (p.readyState === 1) p.send(msg);
}

function join(ws, room) {
  let peers = rooms.get(room);
  if (!peers) rooms.set(room, (peers = new Set()));
  peers.add(ws);
  ws.alive = true;
  ws.hits = [];
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) { ws.close(1003, 'text only'); return; }
    const now = Date.now();
    ws.hits = ws.hits.filter(t => now - t < RATE_MS);
    ws.hits.push(now);
    if (ws.hits.length > RATE_N) { ws.close(1008, 'too fast'); return; }
    const text = data.toString();
    for (const p of peers) if (p !== ws && p.readyState === 1) p.send(text);
  });
  ws.on('close', () => {
    peers.delete(ws);
    if (peers.size) announce(peers); else rooms.delete(room);
  });
  ws.on('error', () => ws.terminate());
  announce(peers);
}

setInterval(() => {
  for (const peers of rooms.values()) {
    for (const ws of peers) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }
}, PING_MS);

server.listen(PORT, () => console.log(`pbn-pair relay listening on ${PORT}`));
process.on('SIGTERM', () => { wss.clients.forEach(ws => ws.terminate()); server.close(() => process.exit(0)); });
