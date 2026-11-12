import { PASSWORD_MIN_LENGTH, USERNAME_PATTERN, type CarSpec, type TrackSpec, type UserView } from '@drivee/shared';
import { AccountError, type AccountClient } from '../net/AccountClient';
import { formatLapTime } from '../race/LapTimer';

type Mode = 'login' | 'signup';

/** How long each aerial shot stays up before fading to the next, ms. */
const SHOT_INTERVAL_MS = 7000;

/**
 * The first screen: aerial stills of a track with the car on it, fading from one to the
 * next, and the player's account.
 * Logged out it offers login or sign-up; logged in, Play goes on to track selection.
 */
export class TitleScreen {
  private readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private mode: Mode = 'login';
  private busy = false;
  private readonly backdrop: HTMLElement;
  private readonly dots: HTMLElement;
  private readonly slides: HTMLImageElement[] = [];
  private current = -1;
  private timer = 0;
  private readonly alt: string;

  constructor(
    parent: HTMLElement,
    private readonly account: AccountClient,
    track: TrackSpec,
    car: CarSpec,
    /** Produces the pictures as URLs, one call of `onShot` each (see heroShots). */
    shots: (onShot: (url: string) => void) => Promise<void>,
    private readonly onPlay: () => void,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'title';
    this.root.innerHTML = `
      <div class="title-backdrop"></div>
      <div class="title-shade"></div>
      <div class="title-side">
        <header class="title-brand">Drivee</header>
        <div class="title-caption" data-el="caption"></div>
        <section class="title-panel" aria-live="polite"></section>
      </div>
      <div class="title-dots" data-el="dots"></div>
      <div class="title-status" data-el="status">Rendering the scene…</div>
    `;
    // Text from track and car files goes in as text, never as HTML.
    this.root.querySelector('[data-el="caption"]')!.textContent = `${track.meta.name} · ${car.name}`;
    this.alt = `${car.name} on ${track.meta.name}`;
    this.backdrop = this.root.querySelector<HTMLElement>('.title-backdrop')!;
    this.dots = this.root.querySelector<HTMLElement>('[data-el="dots"]')!;
    this.panel = this.root.querySelector<HTMLElement>('.title-panel')!;
    parent.appendChild(this.root);

    const status = this.root.querySelector<HTMLElement>('[data-el="status"]')!;
    shots((url) => void this.addShot(url, status))
      .catch((error: unknown) => {
        // The page still works without the pictures.
        console.error(error);
      })
      .finally(() => status.remove());

    this.renderLoading();
    void this.account
      .me()
      .then((user) => (user ? this.renderPlayer(user) : this.renderForm()))
      .catch((error: unknown) => this.renderForm(message(error)));
  }

  private async addShot(url: string, status: HTMLElement): Promise<void> {
    const img = document.createElement('img');
    img.className = 'title-shot';
    img.alt = this.alt;
    img.src = url;
    await img.decode().catch(() => {});
    const index = this.slides.length;
    this.slides.push(img);
    this.backdrop.appendChild(img);
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'title-dot';
    dot.setAttribute('aria-label', `Show picture ${index + 1}`);
    dot.addEventListener('click', () => this.show(index));
    this.dots.appendChild(dot);
    this.root.classList.toggle('many', this.slides.length > 1);
    if (index === 0) {
      this.root.classList.add('ready');
      status.textContent = 'Rendering more views…';
      this.show(0);
    }
  }

  /** Fade to picture `index`, then move on by itself after a while. */
  private show(index: number): void {
    if (!this.root.isConnected || this.slides.length === 0) return;
    this.current = index % this.slides.length;
    this.slides.forEach((img, i) => img.classList.toggle('active', i === this.current));
    [...this.dots.children].forEach((dot, i) => dot.classList.toggle('active', i === this.current));
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.show(this.current + 1), SHOT_INTERVAL_MS);
  }

  private renderLoading(): void {
    this.panel.innerHTML = `<div class="title-hint">Checking your session…</div>`;
  }

  private renderForm(error = ''): void {
    const signup = this.mode === 'signup';
    this.panel.innerHTML = `
      <div class="title-tabs" role="tablist">
        <button type="button" role="tab" data-mode="login" aria-selected="${!signup}">Log in</button>
        <button type="button" role="tab" data-mode="signup" aria-selected="${signup}">Create account</button>
      </div>
      <form class="title-form" novalidate>
        <label>
          <span>Username</span>
          <input name="username" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="20" required />
        </label>
        <label>
          <span>Password</span>
          <input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" maxlength="128" required />
        </label>
        <div class="title-error" data-el="error"></div>
        <button type="submit" class="title-primary">${signup ? 'Create account' : 'Log in'}</button>
        <div class="title-hint">${
          signup ? `3–20 letters, digits, - or _ · password ${PASSWORD_MIN_LENGTH}+ characters` : 'New here? Create an account to save your lap times.'
        }</div>
      </form>
    `;
    const errorLine = this.panel.querySelector<HTMLElement>('[data-el="error"]')!;
    errorLine.textContent = error;
    for (const tab of this.panel.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      tab.addEventListener('click', () => {
        if (this.busy || tab.dataset['mode'] === this.mode) return;
        this.mode = tab.dataset['mode'] as Mode;
        this.renderForm();
      });
    }
    const form = this.panel.querySelector<HTMLFormElement>('form')!;
    form.querySelector<HTMLInputElement>('input[name="username"]')!.focus();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit(form, errorLine);
    });
  }

  private async submit(form: HTMLFormElement, errorLine: HTMLElement): Promise<void> {
    if (this.busy) return;
    const data = new FormData(form);
    const username = String(data.get('username') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const problem = this.mode === 'signup' ? signUpProblem(username, password) : !username || !password ? 'Enter your username and password' : '';
    if (problem) {
      errorLine.textContent = problem;
      return;
    }
    this.busy = true;
    form.classList.add('busy');
    errorLine.textContent = '';
    try {
      const credentials = { username, password };
      const user = this.mode === 'signup' ? await this.account.signUp(credentials) : await this.account.logIn(credentials);
      this.renderPlayer(user);
    } catch (error) {
      errorLine.textContent = message(error);
    } finally {
      this.busy = false;
      form.classList.remove('busy');
    }
  }

  private renderPlayer(user: UserView): void {
    const bests = Object.values(user.best);
    const laps = Object.values(user.laps).reduce((n, list) => n + list.length, 0);
    const fastest = bests.length ? Math.min(...bests.map((b) => b.time)) : null;
    this.panel.innerHTML = `
      <div class="title-welcome">
        <div class="title-label">Signed in as</div>
        <div class="title-user" data-el="user"></div>
      </div>
      <dl class="title-stats">
        <dt>Laps</dt><dd>${laps}</dd>
        <dt>Tracks</dt><dd>${bests.length}</dd>
        <dt>Fastest</dt><dd class="${fastest === null ? '' : 'best'}">${fastest === null ? '–:––.–––' : formatLapTime(fastest)}</dd>
      </dl>
      <button type="button" class="title-primary title-play" data-el="play">Play</button>
      <button type="button" class="title-link" data-el="logout">Log out</button>
    `;
    this.panel.querySelector('[data-el="user"]')!.textContent = user.username;
    const play = this.panel.querySelector<HTMLButtonElement>('[data-el="play"]')!;
    play.addEventListener('click', () => this.onPlay());
    play.focus();
    this.panel.querySelector('[data-el="logout"]')!.addEventListener('click', async () => {
      this.renderLoading();
      await this.account.logOut();
      this.mode = 'login';
      this.renderForm();
    });
  }
}

/** What's wrong with a new account's details, or '' when they're fine (the server checks again). */
export function signUpProblem(username: string, password: string): string {
  if (!USERNAME_PATTERN.test(username)) return 'Username: 3–20 letters, digits, - or _';
  if (password.length < PASSWORD_MIN_LENGTH) return `Password: at least ${PASSWORD_MIN_LENGTH} characters`;
  return '';
}

function message(error: unknown): string {
  if (error instanceof AccountError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
