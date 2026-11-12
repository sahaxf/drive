/**
 * Player accounts and lap times, served by the FastAPI server (apps/signaling) under
 * {@link API_PATH} and proxied by Vite like the signalling. Mirrors
 * apps/signaling/signaling/accounts.py; keep the two in sync.
 *
 * - `POST /api/users` {@link Credentials} → 201 {@link SessionResponse} (409 if the name is taken)
 * - `POST /api/login` {@link Credentials} → {@link SessionResponse} (401 if wrong)
 * - `POST /api/logout` → 204
 * - `GET /api/me` → {@link UserView}
 * - `POST /api/me/laps` {@link LapRequest} → 201 {@link LapResponse}
 *
 * Everything but sign-up and login takes `Authorization: Bearer <token>`; 401 means the
 * session is gone (logged out, or the server restarted and forgot every account).
 */
export const API_PATH = '/api';

export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,20}$/;
export const PASSWORD_MIN_LENGTH = 6;

export interface Credentials {
  username: string;
  password: string;
}

export interface Lap {
  /** Seconds. */
  time: number;
  car: string;
  /** Unix time, s. */
  at: number;
}

export interface UserView {
  username: string;
  createdAt: number;
  /** Track id → recent laps, oldest first. */
  laps: Record<string, Lap[]>;
  /** Track id → best lap on that track. */
  best: Record<string, Lap>;
}

export interface SessionResponse {
  token: string;
  user: UserView;
}

export interface LapRequest {
  track: string;
  car: string;
  time: number;
}

export interface LapResponse {
  lap: Lap;
  best: boolean;
  user: UserView;
}
