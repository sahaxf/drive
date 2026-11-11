import {
  decodeInput,
  isNewerSeq,
  parseControlMessage,
  RTC_CHANNEL_LABEL,
  type HostMessage,
  type InputState,
  type RtcMessage,
  type SignalMessage,
} from '@drivee/shared';
import { controllerUrls, SignalClient, type Signal, type SignalCallbacks } from '../net/SignalClient';
import type { InputSource } from './InputSystem';

/** No packet for this long while driving means the phone is gone: the game pauses. */
export const PHONE_TIMEOUT_MS = 500;
const PING_INTERVAL_MS = 1000;
const ROOM_STORAGE_KEY = 'drivee.controllerRoom';

export interface PhoneStatus {
  /** Reaching the signalling server (so the room code and QR are valid). */
  online: boolean;
  room: string | null;
  /** Controller page URLs for the QR code, best guess first. */
  urls: string[];
  /** A phone is linked: its WebRTC data channel is up. */
  paired: boolean;
  /** Inputs are arriving (the phone is calibrated and in drive mode). */
  driving: boolean;
  /** Smoothed round trip game → phone → game, ms. */
  rttMs: number | null;
}

/** Where the game page was opened from, for the controller URLs. */
export type PageLocation = Pick<Location, 'protocol' | 'hostname' | 'port'>;

/** The subset of RTCPeerConnection this class uses, so tests can drive it. */
export interface PeerLike {
  readonly connectionState: RTCPeerConnectionState;
  onicecandidate: ((ev: RTCPeerConnectionIceEvent) => void) | null;
  ondatachannel: ((ev: RTCDataChannelEvent) => void) | null;
  onconnectionstatechange: ((ev: Event) => void) | null;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  close(): void;
}

export type PhoneEvent = 'lost' | 'regained';

/**
 * Phone controller as an input source. Joins the signalling server as the room's host,
 * which only hands out the room code and passes WebRTC signalling: the phone offers a data
 * channel, this answers, and everything else travels over that channel alone. The phone
 * streams binary input packets on it which this turns back into an {@link InputState}.
 */
export class PhoneInput implements InputSource {
  readonly name = 'phone';
  readonly status: PhoneStatus = {
    online: false,
    room: null,
    urls: [],
    paired: false,
    driving: false,
    rttMs: null,
  };

  private signal: Signal | null = null;
  private peer: PeerLike | null = null;
  private channel: RTCDataChannel | null = null;
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

  constructor(
    private readonly createSignal: (room: string, callbacks: SignalCallbacks) => Signal = (room, callbacks) =>
      new SignalClient('host', room, callbacks),
    private readonly now: () => number = () => performance.now(),
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeSessionStorage(),
    private readonly page: PageLocation = defaultPage(),
    private readonly createPeer: () => PeerLike | null = defaultPeer,
  ) {}

  connect(): void {
    if (this.signal) return;
    // A reloading game asks for its old code back, so a paired phone stays paired.
    const room = this.storage?.getItem(ROOM_STORAGE_KEY) ?? '';
    this.signal = this.createSignal(room, {
      onJoin: ({ code, lanAddresses }) => {
        this.status.online = true;
        this.status.room = code;
        this.status.urls = controllerUrls(this.page, lanAddresses, code);
        this.storage?.setItem(ROOM_STORAGE_KEY, code);
      },
      onMessage: (message) => {
        this.status.online = true;
        this.receiveSignal(message);
      },
      // A data channel that's up keeps working without the signalling server.
      onOffline: () => {
        this.status.online = false;
      },
    });
    this.signal.start();
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
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.signal?.stop();
    this.signal = null;
    this.status.online = false;
    this.stopRtc();
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
    if (message?.t !== 'pong') return;
    const sentAt = this.pingsInFlight.get(message.id);
    if (sentAt === undefined) return;
    this.pingsInFlight.delete(message.id);
    const rtt = this.now() - sentAt;
    this.status.rttMs = this.status.rttMs === null ? rtt : this.status.rttMs + (rtt - this.status.rttMs) * 0.3;
  }

  /**
   * From the signalling server: the phone's half of the signalling. Peer notices are left
   * alone: a phone joining is its cue to offer, and a phone leaving closes the channel
   * itself, whereas a dropped poll on either side shouldn't cut a channel that still works.
   */
  private receiveSignal(message: SignalMessage): void {
    switch (message.t) {
      case 'rtc-offer':
        void this.answer(message.sdp);
        break;
      case 'rtc-ice':
        this.peer?.addIceCandidate(message.candidate).catch(() => {});
        break;
    }
  }

  private async answer(offerSdp: string): Promise<void> {
    // A new offer means the phone started over (it reconnected): drop the old connection.
    this.stopRtc();
    const peer = this.createPeer();
    if (!peer) return;
    this.peer = peer;
    peer.onicecandidate = (ev) => {
      if (ev.candidate && this.peer === peer) this.sendSignal({ t: 'rtc-ice', candidate: ev.candidate.toJSON() });
    };
    peer.onconnectionstatechange = () => {
      if (this.peer !== peer) return;
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') this.stopRtc();
      else this.refreshLink();
    };
    peer.ondatachannel = (ev) => {
      const channel = ev.channel;
      if (this.peer !== peer || channel.label !== RTC_CHANNEL_LABEL) return;
      channel.binaryType = 'arraybuffer';
      this.channel = channel;
      channel.onopen = channel.onclose = () => {
        if (this.channel === channel) this.refreshLink();
      };
      channel.onmessage = (e) => this.receive(e.data);
      this.refreshLink();
    };
    try {
      await peer.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      if (this.peer === peer && answer.sdp) this.sendSignal({ t: 'rtc-answer', sdp: answer.sdp });
    } catch {
      if (this.peer === peer) this.stopRtc();
    }
  }

  private stopRtc(): void {
    const peer = this.peer;
    this.peer = null;
    this.channel = null;
    peer?.close();
    this.refreshLink();
  }

  /** The data channel while it can carry traffic (Wi-Fi blips leave it open but stalled). */
  private openChannel(): RTCDataChannel | null {
    const channel = this.channel;
    return channel?.readyState === 'open' && this.peer?.connectionState === 'connected' ? channel : null;
  }

  private refreshLink(): void {
    const paired = this.openChannel() !== null;
    if (paired === this.status.paired) return;
    this.status.paired = paired;
    if (paired) {
      this.sendStatus();
    } else {
      this.status.rttMs = null;
      this.pingsInFlight.clear();
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
    this.openChannel()?.send(JSON.stringify(message));
  }

  private sendSignal(message: RtcMessage): void {
    this.signal?.send(message);
  }
}

function defaultPage(): PageLocation {
  return typeof location === 'undefined' ? { protocol: 'https:', hostname: 'localhost', port: '' } : location;
}

function defaultPeer(): PeerLike | null {
  // Phone and game share a LAN, so host candidates reach each other without STUN.
  return typeof RTCPeerConnection === 'undefined' ? null : new RTCPeerConnection();
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}
