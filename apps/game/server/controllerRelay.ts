import type { IncomingMessage, Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Plugin } from 'vite';
// Relative path, not '@drivee/shared': Vite bundles relative imports into the config but
// hands package imports to Node, which can't load the shared package's TypeScript.
import {
  CONTROLLER_PAGE,
  CONTROLLER_WS_PATH,
  isRoomCode,
  ROOM_ALPHABET,
  ROOM_CODE_LENGTH,
  type RelayMessage,
} from '../../../packages/shared/src/controller';

/**
 * LAN relay between the game (host) and a phone controller (pad). Each game owns a room
 * with a short code; one phone at a time can join it. The relay forwards everything
 * between the two verbatim and only speaks itself to announce the room and peer changes.
 */

interface Room {
  code: string;
  host: WebSocket | null;
  pad: WebSocket | null;
}

/** Dead sockets (phone Wi-Fi dropped without a close) are found and dropped this often. */
const HEARTBEAT_MS = 10_000;

export interface RelayHandle {
  close(): void;
  /** Number of live rooms, for tests. */
  readonly roomCount: number;
}

export function attachControllerRelay(server: Server): RelayHandle {
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map<string, Room>();
  const alive = new WeakSet<WebSocket>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://relay');
    // Everything else on this server (Vite's HMR socket) is someone else's.
    if (url.pathname !== CONTROLLER_WS_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const role = url.searchParams.get('role');
      const code = (url.searchParams.get('room') ?? '').toUpperCase();
      if (role === 'host') joinAsHost(ws, req, code);
      else if (role === 'pad' && isRoomCode(code)) joinAsPad(ws, code);
      else ws.close(1008, 'bad role or room');
    });
  };
  server.on('upgrade', onUpgrade);

  function joinAsHost(ws: WebSocket, req: IncomingMessage, wanted: string): void {
    // A reloading game asks for its old code back, so a paired phone stays paired.
    let room = isRoomCode(wanted) ? rooms.get(wanted) : undefined;
    if (room?.host) room = undefined;
    if (!room) {
      const code = isRoomCode(wanted) && !rooms.has(wanted) ? wanted : freshCode();
      room = { code, host: null, pad: null };
      rooms.set(code, room);
    }
    const r = room;
    r.host = ws;
    watch(ws);
    send(ws, { t: 'room', code: r.code, urls: controllerUrls(req, r.code) });
    if (r.pad) {
      send(ws, { t: 'peer', connected: true });
      send(r.pad, { t: 'peer', connected: true });
    }
    ws.on('message', (data, isBinary) => forward(r.pad, data, isBinary));
    ws.on('close', () => {
      if (r.host !== ws) return;
      r.host = null;
      if (r.pad) send(r.pad, { t: 'peer', connected: false });
      prune(r);
    });
  }

  function joinAsPad(ws: WebSocket, code: string): void {
    // A phone may arrive before its game (e.g. the game tab is reloading): it waits in the room.
    let room = rooms.get(code);
    if (!room) {
      room = { code, host: null, pad: null };
      rooms.set(code, room);
    }
    const r = room;
    if (r.pad) {
      send(r.pad, { t: 'replaced' });
      r.pad.close(1000, 'replaced');
    }
    r.pad = ws;
    watch(ws);
    send(ws, { t: 'peer', connected: r.host !== null });
    if (r.host) send(r.host, { t: 'peer', connected: true });
    ws.on('message', (data, isBinary) => forward(r.host, data, isBinary));
    ws.on('close', () => {
      if (r.pad !== ws) return;
      r.pad = null;
      if (r.host) send(r.host, { t: 'peer', connected: false });
      prune(r);
    });
  }

  function prune(room: Room): void {
    if (!room.host && !room.pad && rooms.get(room.code) === room) rooms.delete(room.code);
  }

  function freshCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
  }

  function watch(ws: WebSocket): void {
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      rooms.clear();
    },
    get roomCount() {
      return rooms.size;
    },
  };
}

function forward(to: WebSocket | null, data: RawData, isBinary: boolean): void {
  if (to?.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary });
}

function send(ws: WebSocket, message: RelayMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

/**
 * Addresses the phone can open, best guess first. When the game was opened through a LAN
 * address that one is used; from localhost, real Wi-Fi/Ethernet adapters are preferred
 * over the virtual ones (WSL, Hyper-V, VirtualBox, Docker) Windows machines tend to have.
 */
export function controllerUrls(req: IncomingMessage, code: string): string[] {
  const secure = (req.socket as TLSSocket).encrypted === true;
  const port = req.socket.localPort;
  const hostHeader = new URL(`http://${req.headers.host ?? 'localhost'}`).hostname;
  const hosts: string[] = [];
  if (!isLoopback(hostHeader)) hosts.push(hostHeader);
  hosts.push(...lanAddresses());
  return [...new Set(hosts)].map(
    (h) => `${secure ? 'https' : 'http'}://${h.includes(':') ? `[${h}]` : h}:${port}${CONTROLLER_PAGE}?room=${code}`,
  );
}

function lanAddresses(): string[] {
  const VIRTUAL = /vethernet|wsl|virtualbox|vmware|docker|hyper-v|loopback|tailscale|zerotier|utun|bridge/i;
  const candidates: Array<{ address: string; score: number }> = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      let score = VIRTUAL.test(name) ? 0 : 10;
      if (entry.address.startsWith('192.168.')) score += 3;
      else if (entry.address.startsWith('10.')) score += 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)) score += 1;
      else if (entry.address.startsWith('169.254.')) score -= 10;
      candidates.push({ address: entry.address, score });
    }
  }
  return candidates.sort((a, b) => b.score - a.score).map((c) => c.address);
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host.startsWith('127.') || host === '[::1]' || host === '::1';
}

/** Runs the relay on Vite's own dev and preview servers (same port, same certificate). */
export function controllerRelayPlugin(): Plugin {
  return {
    name: 'drivee-controller-relay',
    configureServer(server) {
      if (server.httpServer) attachControllerRelay(server.httpServer as Server);
    },
    configurePreviewServer(server) {
      attachControllerRelay(server.httpServer as Server);
    },
  };
}
