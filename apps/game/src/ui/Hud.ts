import { formatLapTime } from '../race/LapTimer';
import type { VehicleTelemetry } from '../vehicle/Vehicle';

export interface LapState {
  /** 0 until the car first crosses the start line. */
  lap: number;
  current: number;
  last: number | null;
  best: number | null;
}

export interface HudState {
  telemetry: VehicleTelemetry;
  redlineRpm: number;
  tractionControl: boolean;
  abs: boolean;
  camera: string;
  inputSource: string;
  paused: boolean;
  /** Shown under PAUSED, e.g. why the game paused itself. */
  pauseReason: string;
  /** Extra input detail for the info line (phone round trip). */
  inputDetail: string;
  lap: LapState;
}

const NO_TIME = '–:––.–––';

/**
 * Minimal HUD: lap timing top left, speed / gear / revs bottom right, a lap notification
 * top centre, and a small status line with the controls behind H.
 */
export class Hud {
  private readonly speed: HTMLElement;
  private readonly gear: HTMLElement;
  private readonly revFill: HTMLElement;
  private readonly tc: HTMLElement;
  private readonly abs: HTMLElement;
  private readonly lapNumber: HTMLElement;
  private readonly lapTime: HTMLElement;
  private readonly lastTime: HTMLElement;
  private readonly bestTime: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly toastLabel: HTMLElement;
  private readonly toastTime: HTMLElement;
  private readonly info: HTMLElement;
  private readonly help: HTMLElement;
  private readonly paused: HTMLElement;
  private readonly reason: HTMLElement;
  private fps = 60;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="hud-lap">
        <div class="hud-label">Lap <span data-el="lap-number">–</span></div>
        <div class="hud-time idle" data-el="lap-time">0:00.000</div>
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
          <div><span class="hud-label">Gear</span><span class="hud-gear" data-el="gear">1</span></div>
        </div>
      </div>
      <div class="hud-toast" data-el="toast"><div class="hud-label" data-el="toast-label"></div><div data-el="toast-time"></div></div>
      <div class="hud-help" data-el="help">
        <b>W S / ↑ ↓</b><span>Throttle · brake (hold to reverse)</span>
        <b>A D / ← →</b><span>Steer</span>
        <b>Space</b><span>Handbrake</span>
        <b>C · R · P</b><span>Camera · reset · pause</span>
        <b>T · B</b><span>Traction control · ABS</span>
      </div>
      <div class="hud-info" data-el="info"></div>
      <div class="hud-paused" data-el="paused">Paused<small data-el="reason"></small></div>
    `;
    const el = (name: string) => root.querySelector<HTMLElement>(`[data-el="${name}"]`)!;
    this.speed = el('speed');
    this.gear = el('gear');
    this.revFill = el('rev');
    this.tc = el('tc');
    this.abs = el('abs');
    this.lapNumber = el('lap-number');
    this.lapTime = el('lap-time');
    this.lastTime = el('last');
    this.bestTime = el('best');
    this.toast = el('toast');
    this.toastLabel = el('toast-label');
    this.toastTime = el('toast-time');
    this.info = el('info');
    this.help = el('help');
    this.paused = el('paused');
    this.reason = el('reason');

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
    const fraction = Math.min(t.rpm / state.redlineRpm, 1);
    this.revFill.style.transform = `scaleX(${fraction})`;
    this.revFill.classList.toggle('hot', fraction > 0.92);
    this.tc.classList.toggle('on', state.tractionControl);
    this.abs.classList.toggle('on', state.abs);

    const lap = state.lap;
    this.lapNumber.textContent = lap.lap > 0 ? String(lap.lap) : '–';
    this.lapTime.textContent = formatLapTime(lap.current);
    this.lapTime.classList.toggle('idle', lap.lap === 0);
    this.lastTime.textContent = lap.last === null ? NO_TIME : formatLapTime(lap.last);
    this.bestTime.textContent = lap.best === null ? NO_TIME : formatLapTime(lap.best);

    this.info.textContent = `${Math.round(this.fps)} fps · ${state.camera} cam · ${state.inputSource}${state.inputDetail} · H controls`;
    this.paused.style.display = state.paused ? 'flex' : 'none';
    this.reason.textContent = state.pauseReason;
  }

  /** Brief notification when a lap is completed. */
  showLap(lap: number, time: number, best: boolean): void {
    this.toastLabel.textContent = best ? `Lap ${lap} · New best` : `Lap ${lap}`;
    this.toastTime.textContent = formatLapTime(time);
    this.toast.classList.toggle('best', best);
    // Restart the animation even if the previous one is still running.
    this.toast.classList.remove('show');
    void this.toast.offsetWidth;
    this.toast.classList.add('show');
  }
}
