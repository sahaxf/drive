import type { VehicleTelemetry } from '../vehicle/Vehicle';

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
}

/** Minimal M1 HUD: speed, gear, rev bar, assist badges. The styled 90s HUD comes in M7. */
export class Hud {
  private readonly speed: HTMLElement;
  private readonly gear: HTMLElement;
  private readonly revFill: HTMLElement;
  private readonly rpm: HTMLElement;
  private readonly tc: HTMLElement;
  private readonly abs: HTMLElement;
  private readonly info: HTMLElement;
  private readonly paused: HTMLElement;
  private readonly reason: HTMLElement;
  private fps = 60;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="hud-cluster">
        <div class="hud-gear" data-el="gear">1</div>
        <div class="hud-speed"><span data-el="speed">0</span><small>km/h</small></div>
        <div class="hud-rev"><div class="hud-rev-fill" data-el="rev"></div><div class="hud-rev-red"></div></div>
        <div class="hud-rpm"><span data-el="rpm">0</span> rpm</div>
        <div class="hud-badges"><span data-el="tc">TC</span><span data-el="abs">ABS</span></div>
      </div>
      <div class="hud-info" data-el="info"></div>
      <div class="hud-help">
        W/S or ↑/↓ throttle · brake (hold at a stop to reverse) · A/D or ←/→ steer · Space handbrake<br>
        C camera · R reset · T traction control · B ABS · P pause
      </div>
      <div class="hud-paused" data-el="paused">PAUSED<small data-el="reason"></small></div>
    `;
    const el = (name: string) => root.querySelector<HTMLElement>(`[data-el="${name}"]`)!;
    this.speed = el('speed');
    this.gear = el('gear');
    this.revFill = el('rev');
    this.rpm = el('rpm');
    this.tc = el('tc');
    this.abs = el('abs');
    this.info = el('info');
    this.paused = el('paused');
    this.reason = el('reason');
  }

  update(state: HudState, frameDt: number): void {
    if (frameDt > 0) this.fps += (1 / frameDt - this.fps) * 0.05;
    const t = state.telemetry;
    this.speed.textContent = Math.round(Math.abs(t.forwardSpeed) * 3.6).toString();
    this.gear.textContent = t.gear < 0 ? 'R' : t.gear.toString();
    const fraction = Math.min(t.rpm / state.redlineRpm, 1);
    this.revFill.style.transform = `scaleX(${fraction})`;
    this.revFill.classList.toggle('hot', fraction > 0.92);
    this.rpm.textContent = (Math.round(t.rpm / 50) * 50).toString();
    this.tc.classList.toggle('on', state.tractionControl);
    this.abs.classList.toggle('on', state.abs);
    this.info.textContent = `${Math.round(this.fps)} fps · ${state.camera} cam · input: ${state.inputSource}${state.inputDetail}`;
    this.paused.style.display = state.paused ? 'flex' : 'none';
    this.reason.textContent = state.pauseReason;
  }
}
