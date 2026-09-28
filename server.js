const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8765);
const GAME_FILE = process.env.GAME_FILE || path.join(__dirname, 'index.html');
const PREMADE = {
  'public-alpha': { name: 'PUBLIC ALPHA // NIGHTFALL RELAY', mode: 'ffa', map: 'plaza', teamSize: 1, maxPlayers: 2 },
  'community-ctf': { name: 'COMMUNITY CTF // NIGHTFALL RELAY', mode: 'ctf', map: 'harbor', teamSize: 1, maxPlayers: 2 }
};
const rooms = new Map();
for (const [code, config] of Object.entries(PREMADE)) rooms.set(code, { ...config, code, persistent: true, clients: new Map() });

function roomFor(code, mode = 'ffa', map = 'plaza', teamSize = 1) {
  code = String(code || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32) || 'public-alpha';
  if (!rooms.has(code)) rooms.set(code, { code, name: `NIGHTFALL // ${code.toUpperCase()}`, mode, map, teamSize: Math.max(1, Math.min(3, Number(teamSize) || 1)), maxPlayers: Math.max(2, Math.min(6, (Number(teamSize) || 1) * 2)), persistent: false, clients: new Map() });
  return rooms.get(code);
}
function send(ws, data) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function broadcast(room, data, except = null) { for (const c of room.clients.values()) if (c.ws !== except) send(c.ws, data); }
function roster(room) {
  const players = [{ id: 'server', host: true, color: 'cyan', team: 0 }];
  for (const c of room.clients.values()) players.push({ id: c.id, host: false, color: c.color, team: c.team, ready: c.ready });
  return { t: 'roster', players, hostId: 'server', teamSize: room.teamSize };
}
function leave(client) {
  if (!client || !client.room) return;
  const room = client.room;
  room.clients.delete(client.id);
  client.room = null;
  broadcast(room, roster(room));
  if (!room.persistent && room.clients.size === 0) rooms.delete(room.code);
}
function join(ws, msg) {
  const room = roomFor(msg.room, msg.mode, msg.map, msg.teamSize);
  if (room.clients.size >= room.maxPlayers) return send(ws, { t: 'serverfull' });
  const id = `op-${crypto.randomBytes(3).toString('hex')}`;
  const teams = [...room.clients.values()].filter(c => c.team === 0).length <= [...room.clients.values()].filter(c => c.team === 1).length ? 0 : 1;
  const client = { ws, id, room, color: ['cyan','amber','violet','red','green'].includes(msg.color) ? msg.color : 'cyan', team: teams, ready: false };
  room.clients.set(id, client);
  ws.client = client;
  send(ws, { t: 'welcome', id, hostId: 'server', teamSize: room.teamSize, mode: room.mode, map: room.map, server: room.name });
  send(ws, roster(room));
  broadcast(room, { t: 'server-online', name: room.name, room: room.code });
}
function handle(ws, raw) {
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  if (!ws.client) { if (msg.t === 'join') join(ws, msg); return; }
  const c = ws.client, room = c.room;
  if (!room) return;
  if (msg.t === 'ping') return send(ws, { t: 'ping' });
  if (msg.t === 'ready') { c.ready = true; broadcast(room, roster(room)); const ready = room.clients.size >= 2 && [...room.clients.values()].every(x => x.ready); if (ready) broadcast(room, { t: 'ready', id: c.id }); return; }
  if (msg.t === 'setup') {
    if (typeof msg.mode === 'string') room.mode = msg.mode;
    if (typeof msg.map === 'string') room.map = msg.map;
    if (msg.teamSize) { room.teamSize = Math.max(1, Math.min(3, Number(msg.teamSize) || 1)); room.maxPlayers = room.teamSize * 2; }
    broadcast(room, { ...msg, from: c.id }); broadcast(room, roster(room)); return;
  }
  if (msg.t === 'leave') { leave(c); return; }
  const packet = { ...msg, id: msg.id || c.id, from: c.id };
  broadcast(room, packet, ws);
}

const gameHtml = fs.readFileSync(GAME_FILE);
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, rooms: [...rooms.values()].map(r => ({ code: r.code, name: r.name, players: r.clients.size, maxPlayers: r.maxPlayers })) })); }
  if (req.url === '/api/servers') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify([...rooms.values()].map(r => ({ code: r.code, name: r.name, mode: r.mode, map: r.map, players: r.clients.size, maxPlayers: r.maxPlayers, online: true })))); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); res.end(gameHtml);
});
const wss = new WebSocket.Server({ noServer: true });
wss.on('connection', ws => { ws.on('message', data => handle(ws, data.toString())); ws.on('close', () => leave(ws.client)); ws.on('error', () => leave(ws.client)); });
server.on('upgrade', (req, socket, head) => { if (req.url !== '/ws') return socket.destroy(); wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); });
server.listen(PORT, '0.0.0.0', () => console.log(`Nightfall relay listening on 0.0.0.0:${PORT}`));
