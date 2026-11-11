import {
  encodeInput,
  parseControlMessage,
  RTC_CHANNEL_LABEL,
  RTC_CHANNEL_OPTIONS,
  type PadMessage,
  type RtcMessage,
  type SignalMessage,
} from '@drivee/shared/controller';
import type { InputState } from '@drivee/shared/input';
import { SignalClient } from '../net/SignalClient';

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
 * The phone's side of the link. The signalling server only pairs the phone with the game
 * and carries WebRTC signalling; inputs, pings, status and buzzes travel over the data
 * channel alone. If the channel fails while the game is there, it is offered again.
 */
export class PadLink {
  state: LinkState = 'connecting';
  private signal: SignalClient | null = null;
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
    this.setState('connecting');
    this.signal = new SignalClient('pad', this.room, {
      // The server follows a join with a peer notice, which sets the real state.
      onJoin: () => {},
      onMessage: (message) => this.receiveSignal(message),
      // A data channel that's up keeps working without the signalling server.
      onOffline: () => {
        if (this.state !== 'connected') this.setState('connecting');
      },
    });
    this.signal.start();
  }

  sendInput(input: InputState): void {
    const channel = this.openChannel();
    if (!channel || channel.bufferedAmount > MAX_BUFFERED_BYTES) return;
    channel.send(encodeInput(input, this.seq));
    this.seq = (this.seq + 1) & 0xffff;
  }

  /** From the signalling server: pairing changes and the game's half of the signalling. */
  private receiveSignal(message: SignalMessage): void {
    switch (message.t) {
      case 'peer':
        this.gamePresent = message.connected;
        // A channel that's up is kept: a lapse in the game's polling doesn't mean it's gone,
        // and if it is, the channel closes and the next notice decides.
        if (this.openChannel()) break;
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
        this.signal?.stop();
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
      if (ev.candidate && this.peer === peer) this.sendSignal({ t: 'rtc-ice', candidate: ev.candidate.toJSON() });
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
        if (this.peer === peer && offer.sdp) this.sendSignal({ t: 'rtc-offer', sdp: offer.sdp });
      } catch {
        if (this.peer === peer) this.retryRtc();
      }
    })();
  }

  /** The channel died or never came up: start over while the game is still there. */
  private retryRtc(): void {
    this.stopRtc();
    if (this.stopped) return;
    if (!this.gamePresent) {
      this.setState('waiting-for-game');
      return;
    }
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

  private sendSignal(message: RtcMessage): void {
    this.signal?.send(message);
  }

  private setState(state: LinkState): void {
    if (state === this.state) return;
    this.state = state;
    this.callbacks.onState(state);
  }
}
