import { formatDelta, formatLapTime } from '../race/LapTimer';
import type { VehicleTelemetry } from '../vehicle/Vehicle';

export interface LapState {
  /** 0 until the car first crosses the start line. */
  lap: number;
  current: number;
  last: number | null;
  /** Whether the last lap counted. */
  lastValid: boolean;
  best: number | null;
  /** The lap in progress no longer counts. */
  invalid: boolean;
  /** Seconds ahead (−) or behind (+) the best lap at this point of the track. */
  delta: number | null;
  /** Time of each sector so far, and how it compares with the best lap's (− is faster). */
  sectors: readonly (number | null)[];
  sectorDeltas: readonly (number | null)[];
}

export interface HudState {
  telemetry: VehicleTelemetry;
  redlineRpm: number;
  /** Fraction of the redline where the rev bar lights up: time to change up. */
  shiftAt: number;
  /** The driver is changing gear by hand. */
  manualGears: boolean;
  tractionControl: boolean;
  abs: boolean;
  camera: string;
  inputSource: string;
  /** Extra input detail for the info line (phone round trip). */
  inputDetail: string;
  /** The car is being driven against the racing direction. */
  wrongWay: boolean;
  lap: LapState;
}

const NO_TIME = '–:––.–––';

/**
 * Minimal HUD: lap timing top left (with the gap to the best lap and sector times), speed /
 * gear / revs bottom right, a lap notification top centre, and a small status line with
 * the controls behind H.
 */
export class Hud {
  private readonly speed: HTMLElement;
  private readonly gear: HTMLElement;
  private readonly gearLabel: HTMLElement;
  private readonly revFill: HTMLElement;
  private readonly tc: HTMLElement;
  private readonly abs: HTMLElement;
  private readonly lapNumber: HTMLElement;
  private readonly lapTime: HTMLElement;
  private readonly delta: HTMLElement;
  private readonly sectors: HTMLElement;
  private readonly lastTime: HTMLElement;
  private readonly bestTime: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly toastLabel: HTMLElement;
  private readonly toastTime: HTMLElement;
  private readonly wrongWay: HTMLElement;
  private readonly info: HTMLElement;
  private readonly help: HTMLElement;
  private fps = 60;
  private sectorsShown = '';

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="hud-lap">
        <div class="hud-label">Lap <span data-el="lap-number">–</span></div>
        <div class="hud-time idle" data-el="lap-time">0:00.000</div>
        <div class="hud-delta" data-el="delta"></div>
        <div class="hud-sectors" data-el="sectors"></div>
        <div class="hud-row"><span class="hud-label">Last</span><span data-el="last">${NO_TIME}</span></div>
        <div class="hud-row best"><span class="hud-label">Best</span><span data-el="best">${NO_TIME}</span></div>
      </div>
      <div class="hud-drive">
        <div class="hud-speed"><span data-el="speed">0</span><span class="hud-label">Km/h</span></div>
        <div class="hud-rev"><div class="hud-rev-fill" data-el="rev"></div></div>
        <div class="hud-meta">
          <div class="hud-assists">
            <span class="hud-label" data-el="tc">TC</span><span class="hud-label" data-el="abs">ABS</span>
          </div>
          <div><span class="hud-label" data-el="gear-label">Gear</span><span class="hud-gear" data-el="gear">1</span></div>
        </div>
      </div>
      <div class="hud-toast" data-el="toast"><div class="hud-label" data-el="toast-label"></div><div data-el="toast-time"></div></div>
      <div class="hud-warning" data-el="wrong-way">Wrong way</div>
      <div class="hud-help" data-el="help">
        <b>W S / ↑ ↓</b><span>Throttle · brake (hold to reverse)</span>
        <b>A D / ← →</b><span>Steer</span>
        <b>Space</b><span>Handbrake</span>
        <b>E · Q</b><span>Gear up · down (manual gears)</span>
        <b>C · R · P</b><span>Camera · reset · pause</span>
        <b>T · B</b><span>Traction control · ABS</span>
      </div>
      <div class="hud-info" data-el="info"></div>
    `;
    const el = (name: string) => root.querySelector<HTMLElement>(`[data-el="${name}"]`)!;
    this.speed = el('speed');
    this.gear = el('gear');
    this.gearLabel = el('gear-label');
    this.revFill = el('rev');
    this.tc = el('tc');
    this.abs = el('abs');
    this.lapNumber = el('lap-number');
    this.lapTime = el('lap-time');
    this.delta = el('delta');
    this.sectors = el('sectors');
    this.lastTime = el('last');
    this.bestTime = el('best');
    this.toast = el('toast');
    this.toastLabel = el('toast-label');
    this.toastTime = el('toast-time');
    this.wrongWay = el('wrong-way');
    this.info = el('info');
    this.help = el('help');

    // A UI-only key, so it lives here rather than in the game's input bindings.
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyH' && !e.repeat) this.help.classList.toggle('open');
    });
  }

  update(state: HudState, frameDt: number): void {
    if (frameDt > 0) this.fps += (1 / frameDt - this.fps) * 0.05;
    const t = state.telemetry;
    this.speed.textContent = Math.round(Math.abs(t.forwardSpeed) * 3.6).toString();
    this.gear.textContent = t.gear < 0 ? 'R' : t.gear.toString();
    this.gearLabel.textContent = state.manualGears ? 'Manual' : 'Gear';
    const fraction = Math.min(t.rpm / state.redlineRpm, 1);
    this.revFill.style.transform = `scaleX(${fraction})`;
    this.revFill.classList.toggle('hot', fraction > state.shiftAt);
    this.tc.classList.toggle('on', state.tractionControl);
    this.abs.classList.toggle('on', state.abs);

    const lap = state.lap;
    this.lapNumber.textContent = lap.lap > 0 ? `${lap.lap}${lap.invalid ? ' · Invalid' : ''}` : '–';
    this.lapTime.textContent = formatLapTime(lap.current);
    this.lapTime.classList.toggle('idle', lap.lap === 0);
    this.lapTime.classList.toggle('invalid', lap.invalid);
    this.delta.textContent = lap.delta === null ? '' : formatDelta(lap.delta);
    this.delta.classList.toggle('faster', lap.delta !== null && lap.delta < 0);
    this.delta.classList.toggle('slower', lap.delta !== null && lap.delta >= 0);
    this.updateSectors(lap);
    this.lastTime.textContent = lap.last === null ? NO_TIME : formatLapTime(lap.last);
    this.lastTime.classList.toggle('invalid', lap.last !== null && !lap.lastValid);
    this.bestTime.textContent = lap.best === null ? NO_TIME : formatLapTime(lap.best);

    this.wrongWay.classList.toggle('show', state.wrongWay);
    this.info.textContent = `${Math.round(this.fps)} fps · ${state.camera} cam · ${state.inputSource}${state.inputDetail} · H controls`;
  }

  /** Brief notification when a lap is completed. */
  showLap(lap: number, time: number, best: boolean, valid = true): void {
    this.toastLabel.textContent = !valid ? `Lap ${lap} · Invalid` : best ? `Lap ${lap} · New best` : `Lap ${lap}`;
    this.toastTime.textContent = formatLapTime(time);
    this.toast.classList.toggle('best', best);
    this.toast.classList.toggle('invalid', !valid);
    // Restart the animation even if the previous one is still running.
    this.toast.classList.remove('show');
    void this.toast.offsetWidth;
    this.toast.classList.add('show');
  }

  /** One chip per sector: its time once driven, coloured by how it compares with the best lap. */
  private updateSectors(lap: LapState): void {
    const key = lap.sectors.map((s, i) => `${s?.toFixed(3) ?? ''}:${lap.sectorDeltas[i]?.toFixed(3) ?? ''}`).join('|');
    if (key === this.sectorsShown) return;
    this.sectorsShown = key;
    this.sectors.replaceChildren(
      ...lap.sectors.map((time, i) => {
        const chip = document.createElement('span');
        chip.className = 'hud-sector';
        const delta = lap.sectorDeltas[i] ?? null;
        if (time !== null) chip.classList.add(delta === null ? 'set' : delta < 0 ? 'faster' : 'slower');
        const label = document.createElement('span');
        label.className = 'hud-label';
        label.textContent = `S${i + 1}`;
        const value = document.createElement('span');
        value.textContent = time === null ? '–' : time.toFixed(1);
        chip.append(label, value);
        return chip;
      }),
    );
  }
}
