import { CONTROLLER_WS_PATH, encodeInput, parseControlMessage, type PadMessage } from '@drivee/shared/controller';
import type { InputState } from '@drivee/shared/input';

const RECONNECT_MS = 1000;
/** Skip a send while this much is still queued: a stale input is worse than a dropped one. */
const MAX_BUFFERED_BYTES = 64;

export type LinkState = 'connecting' | 'waiting-for-game' | 'connected' | 'replaced';

export interface LinkCallbacks {
  onState(state: LinkState): void;
  onStatus(rttMs: number | null, paused: boolean): void;
  onBuzz(pattern: number[]): void;
}

/** The phone's side of the relay: streams inputs to the game, answers its pings. */
export class PadLink {
  state: LinkState = 'connecting';
  private socket: WebSocket | null = null;
  private seq = 0;
  private stopped = false;

  constructor(
    private readonly room: string,
    private readonly callbacks: LinkCallbacks,
  ) {}

  connect(): void {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}${CONTROLLER_WS_PATH}?role=pad&room=${this.room}`);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.setState('connecting');
    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      const message = parseControlMessage(ev.data);
      switch (message?.t) {
        case 'peer':
          this.setState(message.connected ? 'connected' : 'waiting-for-game');
          break;
        case 'replaced':
          this.stopped = true;
          this.setState('replaced');
          break;
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
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped) return;
      this.setState('connecting');
      setTimeout(() => this.connect(), RECONNECT_MS);
    };
  }

  sendInput(input: InputState): void {
    const socket = this.socket;
    if (this.state !== 'connected' || socket?.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
    socket.send(encodeInput(input, this.seq));
    this.seq = (this.seq + 1) & 0xffff;
  }

  private send(message: PadMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private setState(state: LinkState): void {
    if (state === this.state) return;
    this.state = state;
    this.callbacks.onState(state);
  }
}
