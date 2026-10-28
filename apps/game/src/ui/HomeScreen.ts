import type { TrackSpec } from '@drivee/shared';
import { formatLapTime } from '../race/LapTimer';
import { loadSettings, nextShadowQuality, saveSettings } from '../settings';
import { loadBestLap, trackStats } from '../tracks';
import { minimapPath, minimapPoint } from './minimap';

// Standard Gamepad API buttons (same mapping as GamepadInput).
const BTN_A = 0;
const BTN_Y = 3;
const BTN_DPAD_LEFT = 14;
const BTN_DPAD_RIGHT = 15;
const STICK_THRESHOLD = 0.6;
const LAST_TRACK_KEY = 'drivee.lastTrack';

/**
 * Track selection: one card per track with a map, length, elevation and best lap.
 * Mouse, keyboard (← → Enter) and gamepad (D-pad / stick, A) all work.
 */
export class HomeScreen {
  private readonly root: HTMLElement;
  private readonly cards: HTMLElement[] = [];
  private selected = 0;
  private padHeld = new Set<string>();
  private running = true;
  private readonly settings = loadSettings();
  private readonly shadowsLabel: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly tracks: TrackSpec[],
    private readonly onChoose: (trackId: string) => void,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'home';
    this.root.innerHTML = `
      <header class="home-title">Drivee</header>
      <div class="home-label">Choose a track</div>
      <div class="home-cards"></div>
      <button type="button" class="home-setting"><span class="home-setting-label">Shadows</span> ◂ <span data-el="shadows"></span> ▸</button>
      <footer class="home-hint">← → Select · Enter Drive · G Shadows</footer>
    `;
    const list = this.root.querySelector('.home-cards')!;
    tracks.forEach((spec, i) => {
      const card = this.card(spec);
      card.addEventListener('mouseenter', () => this.select(i));
      card.addEventListener('click', () => this.choose(i));
      list.appendChild(card);
      this.cards.push(card);
    });
    this.shadowsLabel = this.root.querySelector<HTMLElement>('[data-el="shadows"]')!;
    this.shadowsLabel.textContent = this.settings.shadows;
    this.root.querySelector('.home-setting')!.addEventListener('click', () => this.cycleShadows());
    parent.appendChild(this.root);

    const last = safeGet(LAST_TRACK_KEY);
    this.select(Math.max(0, tracks.findIndex((t) => t.meta.id === last)));
    window.addEventListener('keydown', this.onKey);
    requestAnimationFrame(this.pollGamepad);
  }

  private card(spec: TrackSpec): HTMLElement {
    const points = spec.centreline.points.map((c) => c.p);
    const { length, elevationRange } = trackStats(spec);
    const best = loadBestLap(spec.meta.id);
    const startPoint = points[nearestControlPoint(spec)]!;
    const [sx, sy] = minimapPoint(points, startPoint);

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'home-card';
    card.innerHTML = `
      <svg class="home-map" viewBox="0 0 100 100" aria-hidden="true">
        <path d="${minimapPath(points)}" />
        <circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="2.2" />
      </svg>
      <div class="home-name"></div>
      <dl class="home-stats">
        <dt>Length</dt><dd>${(length / 1000).toFixed(2)} km</dd>
        <dt>Elevation</dt><dd>${Math.round(elevationRange)} m</dd>
        <dt>Best</dt><dd class="${best === null ? '' : 'best'}">${best === null ? '–:––.–––' : formatLapTime(best)}</dd>
      </dl>
      <div class="home-credits"></div>
    `;
    // Text from track files goes in as text, never as HTML.
    card.querySelector('.home-name')!.textContent = spec.meta.name;
    card.querySelector('.home-credits')!.textContent = spec.meta.credits ?? '';
    return card;
  }

  private select(index: number): void {
    this.selected = (index + this.cards.length) % this.cards.length;
    this.cards.forEach((card, i) => card.classList.toggle('selected', i === this.selected));
  }

  private choose(index: number): void {
    if (!this.running) return;
    this.running = false;
    window.removeEventListener('keydown', this.onKey);
    const id = this.tracks[index]!.meta.id;
    safeSet(LAST_TRACK_KEY, id);
    this.onChoose(id);
  }

  private cycleShadows(): void {
    this.settings.shadows = nextShadowQuality(this.settings.shadows);
    saveSettings(this.settings);
    this.shadowsLabel.textContent = this.settings.shadows;
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.code === 'KeyG' && !e.repeat) this.cycleShadows();
    if (e.code === 'ArrowRight' || e.code === 'KeyD') this.select(this.selected + 1);
    else if (e.code === 'ArrowLeft' || e.code === 'KeyA') this.select(this.selected - 1);
    else if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      this.choose(this.selected);
    }
  };

  private readonly pollGamepad = (): void => {
    if (!this.running) return;
    const pad = navigator.getGamepads?.().find((p) => p?.connected && p.mapping === 'standard');
    if (pad) {
      const x = pad.axes[0] ?? 0;
      const pressed = {
        left: (pad.buttons[BTN_DPAD_LEFT]?.pressed ?? false) || x < -STICK_THRESHOLD,
        right: (pad.buttons[BTN_DPAD_RIGHT]?.pressed ?? false) || x > STICK_THRESHOLD,
        a: pad.buttons[BTN_A]?.pressed ?? false,
        y: pad.buttons[BTN_Y]?.pressed ?? false,
      };
      // Act on the press, not while held.
      const edge = (name: keyof typeof pressed) => pressed[name] && !this.padHeld.has(name);
      if (edge('left')) this.select(this.selected - 1);
      if (edge('right')) this.select(this.selected + 1);
      if (edge('a')) this.choose(this.selected);
      if (edge('y')) this.cycleShadows();
      this.padHeld = new Set(Object.entries(pressed).filter(([, v]) => v).map(([k]) => k));
    }
    requestAnimationFrame(this.pollGamepad);
  };
}

/** Control point closest to the start/finish line (start distance measured along the points). */
function nearestControlPoint(spec: TrackSpec): number {
  const points = spec.centreline.points;
  let travelled = 0;
  for (let i = 0; i < points.length; i++) {
    if (travelled >= spec.race.startDistance) return i;
    const p = points[i]!.p;
    const q = points[(i + 1) % points.length]!.p;
    travelled += Math.hypot(q[0] - p[0], q[2] - p[2]);
  }
  return 0;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore.
  }
}
