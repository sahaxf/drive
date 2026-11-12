import { describe, expect, it } from 'vitest';
import { AccountClient, AccountError, type TokenStore } from '../src/net/AccountClient';
import { signUpProblem } from '../src/ui/TitleScreen';

function memoryTokens(initial: string | null = null): TokenStore & { value: string | null } {
  return {
    value: initial,
    get() {
      return this.value;
    },
    set(token) {
      this.value = token;
    },
  };
}

const user = { username: 'racer', createdAt: 0, laps: {}, best: {} };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('AccountClient', () => {
  it('keeps the token from a login and sends it afterwards', async () => {
    const tokens = memoryTokens();
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new AccountClient(tokens, async (url, init) => {
      calls.push({ url, init });
      if (url === '/api/login') return json(200, { token: 'tok', user });
      if (url === '/api/me/laps') return json(201, { lap: { time: 90, car: 'c', at: 1 }, best: true, user });
      return json(404, {});
    });

    expect(await client.logIn({ username: 'racer', password: 'hunter22' })).toEqual(user);
    expect(tokens.value).toBe('tok');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ username: 'racer', password: 'hunter22' });

    const result = await client.recordLap({ track: 't', car: 'c', time: 90 });
    expect(result.best).toBe(true);
    expect((calls[1]!.init!.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
  });

  it('forgets a session the server no longer knows', async () => {
    const tokens = memoryTokens('stale');
    const client = new AccountClient(tokens, async () => json(401, { detail: 'not logged in' }));
    expect(await client.me()).toBeNull();
    expect(tokens.value).toBeNull();
    // Without a token it doesn't ask at all.
    expect(await new AccountClient(memoryTokens(), () => Promise.reject(new Error('no'))).me()).toBeNull();
  });

  it("reports the server's reason, or that it can't be reached", async () => {
    const taken = new AccountClient(memoryTokens(), async () => json(409, { detail: 'that username is taken' }));
    await expect(taken.signUp({ username: 'racer', password: 'hunter22' })).rejects.toMatchObject({
      status: 409,
      message: 'That username is taken',
    });
    const down = new AccountClient(memoryTokens(), () => Promise.reject(new TypeError('Failed to fetch')));
    const error = await down.logIn({ username: 'a', password: 'b' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountError);
    expect((error as AccountError).status).toBe(0);
  });

  it('logs out locally even when the server is gone', async () => {
    const tokens = memoryTokens('tok');
    await new AccountClient(tokens, () => Promise.reject(new Error('down'))).logOut();
    expect(tokens.value).toBeNull();
  });
});

describe('signUpProblem', () => {
  it('checks the same rules as the server', () => {
    expect(signUpProblem('racer_1', 'hunter22')).toBe('');
    expect(signUpProblem('ab', 'hunter22')).toMatch(/Username/);
    expect(signUpProblem('has space', 'hunter22')).toMatch(/Username/);
    expect(signUpProblem('racer', 'short')).toMatch(/Password/);
  });
});
