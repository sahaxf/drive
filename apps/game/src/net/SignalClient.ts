import {
  CONTROLLER_PAGE,
  SIGNAL_PATH,
  type HostJoinResponse,
  type PadJoinResponse,
  type PollResponse,
  type RtcMessage,
  type SignalMessage,
} from '@drivee/shared/controller';

/** Wait this long before retrying a request that failed (server down or restarting). */
const RETRY_MS = 1000;

export type SignalRole = 'host' | 'pad';

export interface SignalCallbacks {
  /**
   * Joined the room, or joined again after the server forgot this session (it restarted,
   * or the page slept too long). `lanAddresses` is only filled in for the host.
   */
  onJoin(join: { code: string; lanAddresses: string[] }): void;
  /** Peer notices from the server and signalling from the other side, in order. */
  onMessage(message: SignalMessage): void;
  /** A request to the server failed; it keeps retrying. */
  onOffline(): void;
}

/** What the game and the phone need from a signalling connection, so tests can fake it. */
export interface Signal {
  start(): void;
  stop(): void;
  send(message: RtcMessage): void;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * One side of a room on the signalling server, over plain HTTP: join, then long-poll for
 * messages while posting our own. Only used to set up the WebRTC data channel.
 */
export class SignalClient implements Signal {
  private peer: string | null = null;
  private running = false;
  private poll: AbortController | null = null;
  /** Sends go one at a time, so the other side sees an offer before its candidates. */
  private outbox: Promise<void> = Promise.resolve();
  private readonly onPageHide = () => this.leave();

  constructor(
    private readonly role: SignalRole,
    private room: string,
    private readonly callbacks: SignalCallbacks,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
    private readonly base = '',
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide);
    void this.run();
  }

  stop(): void {
    this.running = false;
    this.poll?.abort();
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
    this.leave();
  }

  send(message: RtcMessage): void {
    this.outbox = this.outbox.then(async () => {
      const peer = this.peer;
      if (!peer || !this.running) return;
      try {
        await this.post('send', { peer, message });
      } catch {
        // Signalling that didn't arrive just means the data channel doesn't come up; the
        // phone offers again after a timeout.
      }
    });
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        if (!this.peer) await this.join();
        const messages = await this.receive();
        if (!this.running) return;
        if (messages === null) {
          // The server doesn't know us (any more): join again.
          this.peer = null;
          continue;
        }
        for (const message of messages) this.callbacks.onMessage(message);
      } catch {
        if (!this.running) return;
        this.callbacks.onOffline();
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  }

  private async join(): Promise<void> {
    if (this.role === 'host') {
      const joined = (await this.post('host', { room: this.room })) as HostJoinResponse;
      this.peer = joined.peer;
      this.room = joined.code;
      this.callbacks.onJoin({ code: joined.code, lanAddresses: joined.lanAddresses });
    } else {
      const joined = (await this.post('pad', { room: this.room })) as PadJoinResponse;
      this.peer = joined.peer;
      this.callbacks.onJoin({ code: this.room, lanAddresses: [] });
    }
  }

  /** Long-poll for our messages; null when the server doesn't know our peer id. */
  private async receive(): Promise<SignalMessage[] | null> {
    const poll = new AbortController();
    this.poll = poll;
    const response = await this.fetchFn(`${this.base}${SIGNAL_PATH}/poll?peer=${encodeURIComponent(this.peer!)}`, {
      signal: poll.signal,
      cache: 'no-store',
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`poll failed: ${response.status}`);
    return ((await response.json()) as PollResponse).messages;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await this.fetchFn(`${this.base}${SIGNAL_PATH}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }

  /** Tell the server we're gone, so the other side hears it now rather than after a timeout. */
  private leave(): void {
    const peer = this.peer;
    this.peer = null;
    if (!peer) return;
    const url = `${this.base}${SIGNAL_PATH}/leave`;
    const body = JSON.stringify({ peer });
    // A beacon still goes out while the page unloads, where a fetch may be cancelled.
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.(url, new Blob([body], { type: 'application/json' }))) {
      return;
    }
    void this.fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(
      () => {},
    );
  }
}

/**
 * Controller page URLs for the QR code, best guess first. When the game was opened through
 * a LAN address that one comes first; from localhost, the server's LAN addresses.
 */
export function controllerUrls(
  page: { protocol: string; hostname: string; port: string },
  lanAddresses: string[],
  code: string,
): string[] {
  const hosts: string[] = [];
  if (!isLoopback(page.hostname)) hosts.push(page.hostname);
  hosts.push(...lanAddresses);
  const port = page.port ? `:${page.port}` : '';
  return [...new Set(hosts)].map(
    (h) => `${page.protocol}//${h.includes(':') && !h.startsWith('[') ? `[${h}]` : h}${port}${CONTROLLER_PAGE}?room=${code}`,
  );
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host.startsWith('127.') || host === '[::1]' || host === '::1';
}
