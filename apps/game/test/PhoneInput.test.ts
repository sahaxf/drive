import { afterEach, describe, expect, it } from 'vitest';
import { Button, encodeInput, type InputState } from '@drivee/shared';
import { PhoneInput, PHONE_TIMEOUT_MS, type SocketLike } from '../src/input/PhoneInput';

class FakeSocket implements SocketLike {
  binaryType: BinaryType = 'blob';
  readyState = 1;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  readonly sent: string[] = [];
  constructor(readonly url: string) {}
  send(data: string | ArrayBuffer): void {
    if (typeof data === 'string') this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  receive(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const input = (overrides: Partial<InputState> = {}): InputState => ({
  steer: 0,
  throttle: 0,
  brake: 0,
  handbrake: false,
  buttons: 0,
  ...overrides,
});

describe('PhoneInput', () => {
  let phone: PhoneInput;
  afterEach(() => phone.disconnect());

  function setup() {
    let clock = 0;
    let socket!: FakeSocket;
    const store = new Map<string, string>();
    phone = new PhoneInput(
      (url) => (socket = new FakeSocket(url)),
      () => clock,
      { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
      'wss://game.test',
    );
    phone.connect();
    return {
      socket: () => socket,
      advance: (ms: number) => (clock += ms),
      store,
    };
  }

  it('reports room, pairing and then driving from packets', () => {
    const { socket, store } = setup();
    expect(socket().url).toBe('wss://game.test/controller-ws?role=host&room=');
    socket().receive(JSON.stringify({ t: 'room', code: 'AB2C', urls: ['https://192.168.1.5:5173/controller.html?room=AB2C'] }));
    expect(phone.status.room).toBe('AB2C');
    expect(store.get('drivee.controllerRoom')).toBe('AB2C');
    expect(phone.poll()).toBeNull();

    socket().receive(JSON.stringify({ t: 'peer', connected: true }));
    expect(phone.status.paired).toBe(true);
    socket().receive(encodeInput(input({ steer: 0.5, throttle: 1 }), 0));
    const state = phone.poll()!;
    expect(state.steer).toBeCloseTo(0.5, 3);
    expect(state.throttle).toBe(1);
    expect(phone.status.driving).toBe(true);
    expect(phone.takeEvent()).toBe('regained');
  });

  it('asks for its old room back after a reload', () => {
    const first = setup();
    first.socket().receive(JSON.stringify({ t: 'room', code: 'XY9Z', urls: [] }));
    phone.disconnect();
    let url = '';
    phone = new PhoneInput(
      (u) => {
        url = u;
        return new FakeSocket(u);
      },
      () => 0,
      { getItem: (k) => first.store.get(k) ?? null, setItem: () => {} },
      'wss://game.test',
    );
    phone.connect();
    expect(url).toContain('room=XY9Z');
  });

  it('times out after 500 ms of silence and recovers when packets return', () => {
    const { socket, advance } = setup();
    socket().receive(encodeInput(input({ throttle: 1 }), 0));
    expect(phone.poll()).not.toBeNull();
    phone.takeEvent();

    advance(PHONE_TIMEOUT_MS + 1);
    expect(phone.poll()).toBeNull();
    expect(phone.status.driving).toBe(false);
    expect(phone.takeEvent()).toBe('lost');
    expect(phone.takeEvent()).toBeNull();

    // The phone reconnected: its sequence numbers restarted, which must still be accepted.
    socket().receive(encodeInput(input({ throttle: 0.5 }), 0));
    expect(phone.poll()!.throttle).toBeCloseTo(0.5, 2);
    expect(phone.takeEvent()).toBe('regained');
  });

  it('drops out-of-order packets', () => {
    const { socket } = setup();
    socket().receive(encodeInput(input({ steer: 0.2 }), 10));
    socket().receive(encodeInput(input({ steer: 0.9 }), 9));
    expect(phone.poll()!.steer).toBeCloseTo(0.2, 3);
  });

  it('keeps a button tap that came and went between two frames', () => {
    const { socket } = setup();
    socket().receive(encodeInput(input({ buttons: Button.Reset }), 1));
    socket().receive(encodeInput(input(), 2));
    expect(phone.poll()!.buttons & Button.Reset).toBeTruthy();
    expect(phone.poll()!.buttons & Button.Reset).toBeFalsy();
  });

  it('measures round-trip time from ping/pong', () => {
    const { socket, advance } = setup();
    socket().receive(JSON.stringify({ t: 'peer', connected: true }));
    // Drive the private ping directly rather than waiting on the 1 s timer.
    (phone as unknown as { sendPing(): void }).sendPing();
    const ping = JSON.parse(socket().sent.find((m) => m.includes('"ping"'))!) as { id: number };
    advance(24);
    socket().receive(JSON.stringify({ t: 'pong', id: ping.id }));
    expect(phone.status.rttMs).toBe(24);
  });
});
