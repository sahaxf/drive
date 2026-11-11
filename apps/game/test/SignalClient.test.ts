import { afterEach, describe, expect, it } from 'vitest';
import type { SignalMessage } from '@drivee/shared';
import { controllerUrls, SignalClient, type SignalCallbacks } from '../src/net/SignalClient';

interface Request {
  path: string;
  body: unknown;
  respond(status: number, body?: unknown): void;
}

/** Answers requests from the test: each request waits until the test responds to it. */
class FakeServer {
  readonly requests: Request[] = [];
  private waiters: Array<() => void> = [];

  fetch = (url: string, init?: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      this.requests.push({
        path: url.replace(/^\/signal\//, ''),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        respond: (status, body) =>
          resolve(new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status })),
      });
      for (const w of this.waiters.splice(0)) w();
    });

  /** The next request not yet answered whose path starts with `prefix`. */
  async next(prefix: string): Promise<Request> {
    for (;;) {
      const i = this.requests.findIndex((r) => r.path.startsWith(prefix));
      if (i >= 0) return this.requests.splice(i, 1)[0]!;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

function recorder() {
  const joins: Array<{ code: string; lanAddresses: string[] }> = [];
  const messages: SignalMessage[] = [];
  const callbacks: SignalCallbacks = {
    onJoin: (join) => joins.push(join),
    onMessage: (message) => messages.push(message),
    onOffline: () => {},
  };
  return { joins, messages, callbacks };
}

describe('SignalClient', () => {
  let client: SignalClient;
  afterEach(() => client.stop());

  it('joins as host, then long-polls and delivers messages in order', async () => {
    const server = new FakeServer();
    const { joins, messages, callbacks } = recorder();
    client = new SignalClient('host', 'K7QX', callbacks, server.fetch);
    client.start();

    const join = await server.next('host');
    expect(join.body).toEqual({ room: 'K7QX' });
    join.respond(200, { code: 'K7QX', peer: 'p1', lanAddresses: ['192.168.1.5'] });

    const poll = await server.next('poll');
    expect(poll.path).toBe('poll?peer=p1');
    expect(joins).toEqual([{ code: 'K7QX', lanAddresses: ['192.168.1.5'] }]);
    poll.respond(200, {
      messages: [
        { t: 'peer', connected: true },
        { t: 'rtc-offer', sdp: 'x' },
      ],
    });
    await server.next('poll');
    expect(messages).toEqual([
      { t: 'peer', connected: true },
      { t: 'rtc-offer', sdp: 'x' },
    ]);
  });

  it('joins again, asking for the same room, when the server forgets it', async () => {
    const server = new FakeServer();
    const { joins, callbacks } = recorder();
    client = new SignalClient('host', '', callbacks, server.fetch);
    client.start();
    (await server.next('host')).respond(200, { code: 'AB2C', peer: 'p1', lanAddresses: [] });
    (await server.next('poll')).respond(404);

    const again = await server.next('host');
    expect(again.body).toEqual({ room: 'AB2C' });
    again.respond(200, { code: 'AB2C', peer: 'p2', lanAddresses: [] });
    expect((await server.next('poll')).path).toBe('poll?peer=p2');
    expect(joins.length).toBe(2);
  });

  it('sends one message at a time, so an offer arrives before its candidates', async () => {
    const server = new FakeServer();
    client = new SignalClient('pad', 'AB2C', recorder().callbacks, server.fetch);
    client.start();
    const join = await server.next('pad');
    expect(join.body).toEqual({ room: 'AB2C' });
    join.respond(200, { peer: 'p1' });
    await server.next('poll');

    client.send({ t: 'rtc-offer', sdp: 'x' });
    client.send({ t: 'rtc-ice', candidate: { candidate: 'c1' } });
    const offer = await server.next('send');
    expect(offer.body).toEqual({ peer: 'p1', message: { t: 'rtc-offer', sdp: 'x' } });
    await Promise.resolve();
    expect(server.requests.some((r) => r.path === 'send')).toBe(false);
    offer.respond(204);
    expect((await server.next('send')).body).toEqual({ peer: 'p1', message: { t: 'rtc-ice', candidate: { candidate: 'c1' } } });
  });

  it('says goodbye when stopped', async () => {
    const server = new FakeServer();
    client = new SignalClient('pad', 'AB2C', recorder().callbacks, server.fetch);
    client.start();
    (await server.next('pad')).respond(200, { peer: 'p1' });
    await server.next('poll');
    client.stop();
    expect((await server.next('leave')).body).toEqual({ peer: 'p1' });
  });
});

describe('controllerUrls', () => {
  it('uses the LAN addresses when the game was opened on localhost', () => {
    expect(controllerUrls({ protocol: 'https:', hostname: 'localhost', port: '5173' }, ['192.168.1.5', '10.0.0.2'], 'AB2C')).toEqual([
      'https://192.168.1.5:5173/controller.html?room=AB2C',
      'https://10.0.0.2:5173/controller.html?room=AB2C',
    ]);
  });

  it('puts the address the game was opened on first', () => {
    expect(controllerUrls({ protocol: 'https:', hostname: '10.0.0.2', port: '5173' }, ['192.168.1.5', '10.0.0.2'], 'AB2C')).toEqual([
      'https://10.0.0.2:5173/controller.html?room=AB2C',
      'https://192.168.1.5:5173/controller.html?room=AB2C',
    ]);
  });
});
