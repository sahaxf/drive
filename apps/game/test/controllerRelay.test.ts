import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { decodeInput, encodeInput, parseControlMessage, type ControlMessage } from '@drivee/shared';
import { attachControllerRelay, type RelayHandle } from '../server/controllerRelay';

/** A ws client that queues what it receives so tests can await messages in order. */
class Client {
  readonly ws: WebSocket;
  private readonly queue: Array<string | Buffer> = [];
  private waiters: Array<(m: string | Buffer) => void> = [];
  readonly closed: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data, isBinary) => {
      const m = isBinary ? (data as Buffer) : data.toString();
      const waiter = this.waiters.shift();
      if (waiter) waiter(m);
      else this.queue.push(m);
    });
    this.closed = new Promise((resolve) => this.ws.on('close', () => resolve()));
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  next(): Promise<string | Buffer> {
    const m = this.queue.shift();
    if (m !== undefined) return Promise.resolve(m);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async nextMessage(): Promise<ControlMessage> {
    const m = await this.next();
    if (typeof m !== 'string') throw new Error('expected text');
    return parseControlMessage(m)!;
  }
}

describe('controller relay', () => {
  let server: Server;
  let relay: RelayHandle;
  let base: string;
  const clients: Client[] = [];

  beforeEach(async () => {
    server = createServer();
    relay = attachControllerRelay(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/controller-ws`;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.ws.terminate();
    relay.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const connect = async (query: string) => {
    const c = new Client(`${base}?${query}`);
    clients.push(c);
    await c.opened();
    return c;
  };

  it('pairs a phone with the game and relays inputs and messages both ways', async () => {
    const host = await connect('role=host');
    const room = await host.nextMessage();
    expect(room.t).toBe('room');
    if (room.t !== 'room') return;
    expect(room.code).toMatch(/^[A-Z2-9]{4}$/);
    expect(room.urls.every((u) => u.startsWith('http://') && u.endsWith(`/controller.html?room=${room.code}`))).toBe(
      true,
    );

    const pad = await connect(`role=pad&room=${room.code}`);
    expect(await pad.nextMessage()).toEqual({ t: 'peer', connected: true });
    expect(await host.nextMessage()).toEqual({ t: 'peer', connected: true });

    pad.ws.send(encodeInput({ steer: -0.25, throttle: 1, brake: 0, handbrake: false, buttons: 0 }, 7));
    const packet = await host.next();
    expect(typeof packet).not.toBe('string');
    const decoded = decodeInput(packet as Buffer)!;
    expect(decoded.seq).toBe(7);
    expect(decoded.input.steer).toBeCloseTo(-0.25, 3);

    host.ws.send(JSON.stringify({ t: 'ping', id: 3 }));
    expect(await pad.nextMessage()).toEqual({ t: 'ping', id: 3 });
    pad.ws.send(JSON.stringify({ t: 'pong', id: 3 }));
    expect(await host.nextMessage()).toEqual({ t: 'pong', id: 3 });

    pad.ws.close();
    expect(await host.nextMessage()).toEqual({ t: 'peer', connected: false });
  });

  it('lets a phone wait for a game that is reloading, and the game reclaim its code', async () => {
    const pad = await connect('role=pad&room=K7QX');
    expect(await pad.nextMessage()).toEqual({ t: 'peer', connected: false });
    const host = await connect('role=host&room=K7QX');
    const room = await host.nextMessage();
    expect(room).toMatchObject({ t: 'room', code: 'K7QX' });
    expect(await host.nextMessage()).toEqual({ t: 'peer', connected: true });
    expect(await pad.nextMessage()).toEqual({ t: 'peer', connected: true });

    host.ws.close();
    expect(await pad.nextMessage()).toEqual({ t: 'peer', connected: false });
    const again = await connect('role=host&room=K7QX');
    expect(await again.nextMessage()).toMatchObject({ t: 'room', code: 'K7QX' });
  });

  it('gives a second game tab its own room instead of stealing a live one', async () => {
    const first = await connect('role=host');
    const room = await first.nextMessage();
    const second = await connect(`role=host&room=${room.t === 'room' ? room.code : ''}`);
    const other = await second.nextMessage();
    expect(other.t).toBe('room');
    expect(other.t === 'room' && room.t === 'room' && other.code !== room.code).toBe(true);
  });

  it('hands the room to a newer phone and tells the old one to stop', async () => {
    const host = await connect('role=host');
    const room = await host.nextMessage();
    const code = room.t === 'room' ? room.code : '';
    const oldPad = await connect(`role=pad&room=${code}`);
    await oldPad.nextMessage();
    await host.nextMessage();

    const newPad = await connect(`role=pad&room=${code}`);
    expect(await oldPad.nextMessage()).toEqual({ t: 'replaced' });
    await oldPad.closed;
    expect(await newPad.nextMessage()).toEqual({ t: 'peer', connected: true });
  });

  it('cleans up empty rooms and refuses bad requests', async () => {
    const host = await connect('role=host');
    await host.nextMessage();
    expect(relay.roomCount).toBe(1);
    host.ws.close();
    await host.closed;
    await new Promise((r) => setTimeout(r, 20));
    expect(relay.roomCount).toBe(0);

    const bad = new Client(`${base}?role=pad&room=nope`);
    clients.push(bad);
    await bad.closed;
    expect(relay.roomCount).toBe(0);
  });
});
