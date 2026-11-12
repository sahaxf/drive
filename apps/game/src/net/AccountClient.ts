import {
  API_PATH,
  type Credentials,
  type LapRequest,
  type LapResponse,
  type SessionResponse,
  type UserView,
} from '@drivee/shared/account';
import type { FetchLike } from './SignalClient';

const TOKEN_KEY = 'drivee.session';

/** A request the server turned down, with its reason (FastAPI's `detail`). */
export class AccountError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Where the session token is kept between page loads; swappable for tests. */
export interface TokenStore {
  get(): string | null;
  set(token: string | null): void;
}

export const localTokenStore: TokenStore = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token) {
    try {
      if (token === null) localStorage.removeItem(TOKEN_KEY);
      else localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // Private mode: the player logs in again next time.
    }
  },
};

/** The player's account on the FastAPI server: sign-up, login and lap times. */
export class AccountClient {
  constructor(
    private readonly tokens: TokenStore = localTokenStore,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
  ) {}

  get loggedIn(): boolean {
    return this.tokens.get() !== null;
  }

  signUp(credentials: Credentials): Promise<UserView> {
    return this.startSession('users', credentials);
  }

  logIn(credentials: Credentials): Promise<UserView> {
    return this.startSession('login', credentials);
  }

  async logOut(): Promise<void> {
    try {
      if (this.loggedIn) await this.request('logout', { method: 'POST' });
    } catch {
      // Gone from this browser either way.
    } finally {
      this.tokens.set(null);
    }
  }

  /** The logged-in player, or null when there's no session (or the server forgot it). */
  async me(): Promise<UserView | null> {
    if (!this.loggedIn) return null;
    try {
      return (await this.request('me')) as UserView;
    } catch (error) {
      if (error instanceof AccountError && error.status === 401) {
        this.tokens.set(null);
        return null;
      }
      throw error;
    }
  }

  recordLap(lap: LapRequest): Promise<LapResponse> {
    return this.request('me/laps', { method: 'POST', body: lap }) as Promise<LapResponse>;
  }

  private async startSession(path: string, credentials: Credentials): Promise<UserView> {
    const session = (await this.request(path, { method: 'POST', body: credentials })) as SessionResponse;
    this.tokens.set(session.token);
    return session.user;
  }

  private async request(path: string, options: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const headers: Record<string, string> = {};
    const token = this.tokens.get();
    if (token) headers['authorization'] = `Bearer ${token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchFn(`${API_PATH}/${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: 'no-store',
      });
    } catch {
      throw new AccountError(0, "Can't reach the server");
    }
    if (response.ok) return response.status === 204 ? undefined : response.json();
    throw new AccountError(response.status, await errorMessage(response));
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const { detail } = (await response.json()) as { detail?: unknown };
    if (typeof detail === 'string') return capitalise(detail);
    // Validation errors are a list; the UI checks the same rules first, so keep it short.
    if (Array.isArray(detail)) return 'Check the username and password';
  } catch {
    // Not JSON: e.g. the Vite proxy's own error page when the server is down.
  }
  return response.status >= 500 ? "Can't reach the server" : `Request failed (${response.status})`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
