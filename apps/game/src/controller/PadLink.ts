import {
  CONTROLLER_WS_PATH,
  encodeInput,
  parseControlMessage,
  RTC_CHANNEL_LABEL,
  RTC_CHANNEL_OPTIONS,
  type PadMessage,
  type RtcMessage,
} from '@drivee/shared/controller';
import type { InputState } from '@drivee/shared/input';

const RECONNECT_MS = 1000;
/** A data channel that isn't up by then (ICE stuck checking) is torn down and offered again. */
const RTC_TIMEOUT_MS = 8000;
/** Skip a send while this much is still queued: a stale input is worse than a dropped one. */
const MAX_BUFFERED_BYTES = 64;

/**
 * `linking`: the game is in the room and the data channel is being set up. Only
 * `connected` (channel up) carries inputs.
 */
export type LinkState = 'connecting' | 'waiting-for-game' | 'linking' | 'connected' | 'replaced';

export interface LinkCallbacks {
  onState(state: LinkState): void;
  onStatus(rttMs: number | null, paused: boolean): void;
  onBuzz(pattern: number[]): void;
}

/**
 * The phone's side of the link. The relay only pairs the phone with the game and carries
 * WebRTC signalling; inputs, pings, status and buzzes travel over the data channel alone.
 * If the channel fails while the game is there, it is offered again.
 */
export class PadLink {
  state: LinkState = 'connecting';
  private socket: WebSocket | null = null;
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private gamePresent = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private stopped = false;

  constructor(
    private readonly room: string,
    private readonly callbacks: LinkCallbacks,
  ) {}

  connect(): void {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}${CONTROLLER_WS_PATH}?role=pad&room=${this.room}`);
    this.socket = socket;
    this.setState('connecting');
    socket.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.receiveSignal(ev.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.gamePresent = false;
      this.stopRtc();
      if (this.stopped) return;
      this.setState('connecting');
      setTimeout(() => this.connect(), RECONNECT_MS);
    };
  }

  sendInput(input: InputState): void {
    const channel = this.openChannel();
    if (!channel || channel.bufferedAmount > MAX_BUFFERED_BYTES) return;
    channel.send(encodeInput(input, this.seq));
    this.seq = (this.seq + 1) & 0xffff;
  }

  /** From the relay: pairing changes and the game's half of the signalling. */
  private receiveSignal(text: string): void {
    const message = parseControlMessage(text);
    switch (message?.t) {
      case 'peer':
        this.gamePresent = message.connected;
        if (message.connected) {
          this.setState('linking');
          this.startRtc();
        } else {
          this.stopRtc();
          this.setState('waiting-for-game');
        }
        break;
      case 'replaced':
        this.stopped = true;
        this.stopRtc();
        this.setState('replaced');
        break;
      case 'rtc-answer':
        this.peer?.setRemoteDescription({ type: 'answer', sdp: message.sdp }).catch(() => this.retryRtc());
        break;
      case 'rtc-ice':
        this.peer?.addIceCandidate(message.candidate).catch(() => {});
        break;
    }
  }

  /** From the game, over the data channel. */
  private receive(text: string): void {
    const message = parseControlMessage(text);
    switch (message?.t) {
      case 'ping':
        this.send({ t: 'pong', id: message.id });
        break;
      case 'status':
        this.callbacks.onStatus(message.rttMs, message.paused);
        break;
      case 'buzz':
        this.callbacks.onBuzz(message.pattern);
        break;
    }
  }

  private startRtc(): void {
    this.stopRtc();
    if (typeof RTCPeerConnection === 'undefined') return;
    // Phone and game share a LAN, so host candidates reach each other without STUN.
    const peer = new RTCPeerConnection();
    const channel = peer.createDataChannel(RTC_CHANNEL_LABEL, RTC_CHANNEL_OPTIONS);
    channel.binaryType = 'arraybuffer';
    this.peer = peer;
    this.channel = channel;
    this.retryTimer = setTimeout(() => this.retryRtc(), RTC_TIMEOUT_MS);
    peer.onicecandidate = (ev) => {
      if (ev.candidate && this.peer === peer) this.signal({ t: 'rtc-ice', candidate: ev.candidate.toJSON() });
    };
    peer.onconnectionstatechange = () => {
      if (this.peer !== peer) return;
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') this.retryRtc();
      else this.refreshState();
    };
    channel.onopen = () => {
      if (this.channel === channel) this.refreshState();
    };
    channel.onclose = () => {
      if (this.channel === channel) this.retryRtc();
    };
    channel.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.receive(ev.data);
    };
    void (async () => {
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        if (this.peer === peer && offer.sdp) this.signal({ t: 'rtc-offer', sdp: offer.sdp });
      } catch {
        if (this.peer === peer) this.retryRtc();
      }
    })();
  }

  /** The channel died or never came up: start over while the game is still there. */
  private retryRtc(): void {
    this.stopRtc();
    if (!this.gamePresent || this.stopped) return;
    this.setState('linking');
    this.retryTimer = setTimeout(() => this.startRtc(), RECONNECT_MS);
  }

  private stopRtc(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const peer = this.peer;
    this.peer = null;
    this.channel = null;
    peer?.close();
  }

  /** The data channel while it can carry traffic (Wi-Fi blips leave it open but stalled). */
  private openChannel(): RTCDataChannel | null {
    const channel = this.channel;
    return channel?.readyState === 'open' && this.peer?.connectionState === 'connected' ? channel : null;
  }

  private refreshState(): void {
    if (!this.gamePresent) return;
    const up = this.openChannel() !== null;
    if (up && this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.setState(up ? 'connected' : 'linking');
  }

  private send(message: PadMessage): void {
    this.openChannel()?.send(JSON.stringify(message));
  }

  private signal(message: RtcMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private setState(state: LinkState): void {
    if (state === this.state) return;
    this.state = state;
    this.callbacks.onState(state);
  }
}
