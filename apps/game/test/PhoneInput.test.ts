import { afterEach, describe, expect, it } from 'vitest';
import { Button, encodeInput, type InputState } from '@drivee/shared';
import { PhoneInput, PHONE_TIMEOUT_MS, type PeerLike, type SocketLike } from '../src/input/PhoneInput';

class FakeSocket implements SocketLike {
  readyState = 1;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  readonly sent: string[] = [];
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  receive(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

class FakeChannel {
  label = 'input';
  binaryType: BinaryType = 'blob';
  readyState: RTCDataChannelState = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  readonly sent: string[] = [];
  send(data: string | ArrayBuffer): void {
    if (typeof data === 'string') this.sent.push(data);
  }
  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
  close(): void {
    this.readyState = 'closed';
    this.onclose?.();
  }
  receive(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

class FakePeer implements PeerLike {
  connectionState: RTCPeerConnectionState = 'new';
  onicecandidate: ((ev: RTCPeerConnectionIceEvent) => void) | null = null;
  ondatachannel: ((ev: RTCDataChannelEvent) => void) | null = null;
  onconnectionstatechange: ((ev: Event) => void) | null = null;
  remote: RTCSessionDescriptionInit | null = null;
  readonly candidates: RTCIceCandidateInit[] = [];
  closed = false;
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remote = description;
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer-sdp' };
  }
  async setLocalDescription(): Promise<void> {}
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.candidates.push(candidate);
  }
  close(): void {
    this.closed = true;
  }
  setState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.(new Event('connectionstatechange'));
  }
  openChannel(): FakeChannel {
    const channel = new FakeChannel();
    this.ondatachannel?.({ channel } as unknown as RTCDataChannelEvent);
    return channel;
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

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('PhoneInput', () => {
  let phone: PhoneInput;
  afterEach(() => phone.disconnect());

  function setup() {
    let clock = 0;
    let socket!: FakeSocket;
    const peers: FakePeer[] = [];
    const store = new Map<string, string>();
    phone = new PhoneInput(
      (url) => (socket = new FakeSocket(url)),
      () => clock,
      { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
      'wss://game.test',
      () => {
        const peer = new FakePeer();
        peers.push(peer);
        return peer;
      },
    );
    phone.connect();
    return {
      socket: () => socket,
      advance: (ms: number) => (clock += ms),
      store,
      peers,
    };
  }

  /** The phone joins, offers, and the data channel comes up. */
  async function link(env: ReturnType<typeof setup>) {
    env.socket().receive(JSON.stringify({ t: 'peer', connected: true }));
    env.socket().receive(JSON.stringify({ t: 'rtc-offer', sdp: 'offer-sdp' }));
    await flush();
    const peer = env.peers.at(-1)!;
    const channel = peer.openChannel();
    peer.setState('connected');
    channel.open();
    return { peer, channel };
  }

  it('reports room, then paired once the data channel is up, then driving from packets', async () => {
    const env = setup();
    expect(env.socket().url).toBe('wss://game.test/controller-ws?role=host&room=');
    env.socket().receive(JSON.stringify({ t: 'room', code: 'AB2C', urls: ['https://192.168.1.5:5173/controller.html?room=AB2C'] }));
    expect(phone.status.room).toBe('AB2C');
    expect(env.store.get('drivee.controllerRoom')).toBe('AB2C');
    expect(phone.poll()).toBeNull();

    // The phone being in the room isn't enough: nothing flows until the channel is up.
    env.socket().receive(JSON.stringify({ t: 'peer', connected: true }));
    expect(phone.status.paired).toBe(false);

    const { channel } = await link(env);
    expect(phone.status.paired).toBe(true);
    channel.receive(encodeInput(input({ steer: 0.5, throttle: 1 }), 0));
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

  it('answers the WebRTC offer from the phone through the relay', async () => {
    const env = setup();
    const { peer } = await link(env);
    expect(peer.remote).toEqual({ type: 'offer', sdp: 'offer-sdp' });
    expect(env.socket().sent.map((m) => JSON.parse(m) as unknown)).toContainEqual({ t: 'rtc-answer', sdp: 'answer-sdp' });

    env.socket().receive(JSON.stringify({ t: 'rtc-ice', candidate: { candidate: 'c1', sdpMid: '0' } }));
    await flush();
    expect(peer.candidates).toEqual([{ candidate: 'c1', sdpMid: '0' }]);
  });

  it('never takes inputs or sends messages through the relay', async () => {
    const env = setup();
    env.socket().receive(JSON.stringify({ t: 'peer', connected: true }));
    env.socket().receive(encodeInput(input({ throttle: 1 }), 0));
    expect(phone.poll()).toBeNull();

    const { channel } = await link(env);
    channel.receive(encodeInput(input({ throttle: 1 }), 0));
    phone.poll();
    phone.buzz([30]);
    (phone as unknown as { sendPing(): void }).sendPing();
    expect(channel.sent).toContain(JSON.stringify({ t: 'buzz', pattern: [30] }));
    expect(channel.sent.some((m) => m.includes('"ping"'))).toBe(true);
    expect(env.socket().sent.every((m) => (JSON.parse(m) as { t: string }).t.startsWith('rtc-'))).toBe(true);
  });

  it('unpairs while the channel stalls, and drops it when it fails or the phone leaves', async () => {
    const env = setup();
    const { peer } = await link(env);
    peer.setState('disconnected');
    expect(phone.status.paired).toBe(false);
    peer.setState('connected');
    expect(phone.status.paired).toBe(true);
    peer.setState('failed');
    expect(peer.closed).toBe(true);
    expect(phone.status.paired).toBe(false);

    const second = await link(env);
    env.socket().receive(JSON.stringify({ t: 'peer', connected: false }));
    expect(second.peer.closed).toBe(true);
    expect(phone.status.paired).toBe(false);
  });

  it('replaces the connection when the phone offers again', async () => {
    const env = setup();
    const first = await link(env);
    env.socket().receive(JSON.stringify({ t: 'rtc-offer', sdp: 'offer-2' }));
    expect(first.peer.closed).toBe(true);
    expect(env.peers.length).toBe(2);
  });

  it('times out after 500 ms of silence and recovers when packets return', async () => {
    const env = setup();
    const { channel } = await link(env);
    channel.receive(encodeInput(input({ throttle: 1 }), 0));
    expect(phone.poll()).not.toBeNull();
    phone.takeEvent();

    env.advance(PHONE_TIMEOUT_MS + 1);
    expect(phone.poll()).toBeNull();
    expect(phone.status.driving).toBe(false);
    expect(phone.takeEvent()).toBe('lost');
    expect(phone.takeEvent()).toBeNull();

    // The phone reconnected: its sequence numbers restarted, which must still be accepted.
    channel.receive(encodeInput(input({ throttle: 0.5 }), 0));
    expect(phone.poll()!.throttle).toBeCloseTo(0.5, 2);
    expect(phone.takeEvent()).toBe('regained');
  });

  it('drops out-of-order packets', async () => {
    const { channel } = await link(setup());
    channel.receive(encodeInput(input({ steer: 0.2 }), 10));
    channel.receive(encodeInput(input({ steer: 0.9 }), 9));
    expect(phone.poll()!.steer).toBeCloseTo(0.2, 3);
  });

  it('keeps a button tap that came and went between two frames', async () => {
    const { channel } = await link(setup());
    channel.receive(encodeInput(input({ buttons: Button.Reset }), 1));
    channel.receive(encodeInput(input(), 2));
    expect(phone.poll()!.buttons & Button.Reset).toBeTruthy();
    expect(phone.poll()!.buttons & Button.Reset).toBeFalsy();
  });

  it('measures round-trip time from ping/pong', async () => {
    const env = setup();
    const { channel } = await link(env);
    // Drive the private ping directly rather than waiting on the 1 s timer.
    (phone as unknown as { sendPing(): void }).sendPing();
    const ping = JSON.parse(channel.sent.find((m) => m.includes('"ping"'))!) as { id: number };
    env.advance(24);
    channel.receive(JSON.stringify({ t: 'pong', id: ping.id }));
    expect(phone.status.rttMs).toBe(24);
  });
});
