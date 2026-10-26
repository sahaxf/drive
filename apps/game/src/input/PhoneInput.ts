import {
  CONTROLLER_WS_PATH,
  decodeInput,
  isNewerSeq,
  parseControlMessage,
  type HostMessage,
  type InputState,
} from '@drivee/shared';
import type { InputSource } from './InputSystem';

/** No packet for this long while driving means the phone is gone: the game pauses. */
export const PHONE_TIMEOUT_MS = 500;
const PING_INTERVAL_MS = 1000;
const RECONNECT_MS = 1000;
const ROOM_STORAGE_KEY = 'drivee.controllerRoom';

export interface PhoneStatus {
  /** Connected to the relay (so the room code and QR are valid). */
  online: boolean;
  room: string | null;
  /** Controller page URLs for the QR code, best guess first. */
  urls: string[];
  /** A phone has joined the room. */
  paired: boolean;
  /** Inputs are arriving (the phone is calibrated and in drive mode). */
  driving: boolean;
  /** Smoothed round trip game → phone → game, ms. */
  rttMs: number | null;
}

/** The subset of the browser WebSocket this class uses, so tests can drive it. */
export interface SocketLike {
  binaryType: BinaryType;
  readonly readyState: number;
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(): void;
}

export type PhoneEvent = 'lost' | 'regained';

/**
 * Phone controller as an input source. Joins the LAN relay as the room's host; the phone
 * streams binary input packets which this turns back into an {@link InputState}.
 */
export class PhoneInput implements InputSource {
  readonly name = 'phone';
  readonly status: PhoneStatus = { online: false, room: null, urls: [], paired: false, driving: false, rttMs: null };

  private socket: SocketLike | null = null;
  private latest: InputState | null = null;
  private lastSeq = -1;
  private lastPacketAt = -Infinity;
  /** Buttons seen in any packet since the last poll, so short taps aren't lost between frames. */
  private seenButtons = 0;
  private wasDriving = false;
  private readonly events: PhoneEvent[] = [];
  private pingId = 0;
  private readonly pingsInFlight = new Map<number, number>();
  private paused = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = false;

  constructor(
    private readonly openSocket: (url: string) => SocketLike = (url) => new WebSocket(url),
    private readonly now: () => number = () => performance.now(),
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeSessionStorage(),
    private readonly baseUrl: string = defaultBaseUrl(),
  ) {}

  connect(): void {
    this.stopped = false;
    const room = this.storage?.getItem(ROOM_STORAGE_KEY) ?? '';
    const socket = this.openSocket(`${this.baseUrl}${CONTROLLER_WS_PATH}?role=host&room=${encodeURIComponent(room)}`);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      this.status.online = true;
    };
    socket.onmessage = (ev) => this.receive(ev.data);
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.status.online = false;
      this.status.paired = false;
      if (!this.stopped) setTimeout(() => this.connect(), RECONNECT_MS);
    };
    if (this.timers.length === 0) {
      this.timers.push(
        setInterval(() => {
          this.sendPing();
          this.sendStatus();
        }, PING_INTERVAL_MS),
      );
    }
  }

  disconnect(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  poll(): InputState | null {
    const fresh = this.latest !== null && this.now() - this.lastPacketAt <= PHONE_TIMEOUT_MS;
    this.status.driving = fresh;
    if (fresh !== this.wasDriving) this.events.push(fresh ? 'regained' : 'lost');
    this.wasDriving = fresh;
    if (!fresh || !this.latest) return null;
    const state = { ...this.latest, buttons: this.latest.buttons | this.seenButtons };
    this.seenButtons = 0;
    return state;
  }

  /** Driving started or stopped since the last call (null when nothing changed). */
  takeEvent(): PhoneEvent | null {
    return this.events.shift() ?? null;
  }

  /** Tell the phone whether the game is paused (it shows it). */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.sendStatus();
  }

  /** Vibrate the phone: ms on, off, on, ... */
  buzz(pattern: number[]): void {
    if (this.status.driving) this.send({ t: 'buzz', pattern });
  }

  private receive(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      const packet = decodeInput(data);
      if (!packet) return;
      // After a phone reconnects its sequence restarts, so a long silence accepts anything.
      const stale = this.now() - this.lastPacketAt > PHONE_TIMEOUT_MS;
      if (!stale && this.lastSeq >= 0 && !isNewerSeq(packet.seq, this.lastSeq)) return;
      this.lastSeq = packet.seq;
      this.latest = packet.input;
      this.seenButtons |= packet.input.buttons;
      this.lastPacketAt = this.now();
      return;
    }
    if (typeof data !== 'string') return;
    const message = parseControlMessage(data);
    switch (message?.t) {
      case 'room':
        this.status.room = message.code;
        this.status.urls = message.urls;
        this.storage?.setItem(ROOM_STORAGE_KEY, message.code);
        break;
      case 'peer':
        this.status.paired = message.connected;
        if (!message.connected) {
          this.status.rttMs = null;
          this.pingsInFlight.clear();
        } else {
          this.sendStatus();
        }
        break;
      case 'pong': {
        const sentAt = this.pingsInFlight.get(message.id);
        if (sentAt === undefined) break;
        this.pingsInFlight.delete(message.id);
        const rtt = this.now() - sentAt;
        this.status.rttMs = this.status.rttMs === null ? rtt : this.status.rttMs + (rtt - this.status.rttMs) * 0.3;
        break;
      }
    }
  }

  private sendPing(): void {
    if (!this.status.paired) return;
    // Pings that never came back (phone asleep) shouldn't pile up.
    for (const [id, at] of this.pingsInFlight) if (this.now() - at > 5000) this.pingsInFlight.delete(id);
    const id = ++this.pingId;
    this.pingsInFlight.set(id, this.now());
    this.send({ t: 'ping', id });
  }

  private sendStatus(): void {
    if (!this.status.paired) return;
    const rtt = this.status.rttMs;
    this.send({ t: 'status', rttMs: rtt === null ? null : Math.round(rtt), paused: this.paused });
  }

  private send(message: HostMessage): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }
}

function defaultBaseUrl(): string {
  if (typeof location === 'undefined') return 'ws://localhost';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}
