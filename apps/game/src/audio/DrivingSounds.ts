import { IMPACT_THRESHOLD } from '../input/haptics';
import { noiseBuffer } from './AudioMixer';

/** What the tyre sounds need to know about a wheel. */
export interface SlideWheel {
  grounded: boolean;
  locked: boolean;
  spinning: boolean;
  /** Slip angle, rad. */
  slipAngle: number;
  /** Grip multiplier of the surface under the wheel (1 = asphalt). */
  surfaceGrip: number;
  /** Normal load, N. */
  load: number;
}

/** Slip angle where a tyre starts to squeal, and where it is fully howling, rad. */
const SQUEAL_ONSET = 0.08;
const SQUEAL_FULL = 0.22;
/** Only hard surfaces squeal: grass and dirt (lower grip) just slide. */
const HARD_SURFACE_GRIP = 0.9;

/**
 * How much the tyres are sliding on tarmac, 0..1: the loudest wheel, weighted by how hard
 * it is pressed into the road. Spinning wheels count at any speed (a burnout from rest);
 * sideways slip and lock-ups fade in with speed.
 */
export function tyreSlide(wheels: readonly SlideWheel[], speed: number, nominalLoad: number): number {
  const moving = clamp01((speed - 2) / 6);
  let slide = 0;
  for (const w of wheels) {
    if (!w.grounded || w.surfaceGrip < HARD_SURFACE_GRIP) continue;
    const sideways = clamp01((Math.abs(w.slipAngle) - SQUEAL_ONSET) / (SQUEAL_FULL - SQUEAL_ONSET));
    const amount = w.spinning ? 1 : (w.locked ? 1 : sideways) * moving;
    slide = Math.max(slide, amount * clamp01(w.load / nominalLoad));
  }
  return slide;
}

export interface NoiseTone {
  /** 0..1 */
  level: number;
  /** Centre or cutoff frequency of the filter shaping the noise, Hz. */
  frequency: number;
}

/** Tyre squeal: a narrow band of noise that rises in pitch with speed. */
export function squealTone(slide: number, speed: number): NoiseTone {
  return { level: Math.pow(clamp01(slide), 1.5), frequency: 750 + 450 * clamp01(speed / 50) };
}

/** Wind rush: silent at a crawl, growing with the square of speed and getting brighter. */
export function windTone(speed: number): NoiseTone {
  const s = clamp01(Math.abs(speed) / 90);
  return { level: s * s, frequency: 250 + 2200 * s };
}

/** Metres between kerb stripes: the rumble's pitch is the rate they pass under the tyre. */
const KERB_STRIPE = 1;

/** Kerb rumble: a low buzz at the rate the stripes go by. */
export function kerbTone(onKerb: boolean, speed: number): NoiseTone {
  const moving = clamp01((Math.abs(speed) - 2) / 6);
  return { level: onKerb ? moving : 0, frequency: Math.min(Math.max(Math.abs(speed) / KERB_STRIPE, 12), 90) };
}

/** Loudness of a hit, 0 (not one) to 1, from the velocity change in one physics step, m/s. */
export function impactLevel(impact: number): number {
  return impact <= IMPACT_THRESHOLD ? 0 : clamp01(0.25 + (impact - IMPACT_THRESHOLD) / 6);
}

export interface DrivingFrame {
  /** See {@link tyreSlide}. */
  slide: number;
  /** m/s */
  speed: number;
  onKerb: boolean;
  /** Largest velocity change in a single physics step since the last frame, m/s. */
  impact: number;
}

// Loudness of each layer next to the engine note.
const SQUEAL_VOLUME = 0.16;
const WIND_VOLUME = 0.5;
// Kerbs are felt more than heard: a faint, dull thrum under everything else.
const KERB_VOLUME = 0.1;
const IMPACT_VOLUME = 0.5;
const SMOOTHING = 0.05;
/** Quiet time after a hit, so one crash is one thump. */
const IMPACT_HOLD = 0.25;

/**
 * Everything the car sounds like besides its engine: tyre squeal, wind, kerb rumble and
 * impacts. All synthesized from filtered noise and one oscillator, like the engine note,
 * so there are no samples to load.
 */
export class DrivingSounds {
  private readonly noise: AudioBuffer;
  private readonly squealBand: BiquadFilterNode;
  private readonly squealGain: GainNode;
  private readonly windFilter: BiquadFilterNode;
  private readonly windGain: GainNode;
  private readonly kerb: OscillatorNode;
  private readonly kerbGain: GainNode;
  private hold = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly destination: AudioNode,
  ) {
    this.noise = noiseBuffer(ctx);
    const source = new AudioBufferSourceNode(ctx, { buffer: this.noise, loop: true });

    this.squealBand = new BiquadFilterNode(ctx, { type: 'bandpass', Q: 7, frequency: 900 });
    this.squealGain = new GainNode(ctx, { gain: 0 });
    source.connect(this.squealBand).connect(this.squealGain).connect(destination);

    this.windFilter = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.5, frequency: 300 });
    this.windGain = new GainNode(ctx, { gain: 0 });
    source.connect(this.windFilter).connect(this.windGain).connect(destination);

    this.kerb = new OscillatorNode(ctx, { type: 'triangle', frequency: 30 });
    this.kerbGain = new GainNode(ctx, { gain: 0 });
    this.kerb.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 110 })).connect(this.kerbGain).connect(destination);

    source.start();
    this.kerb.start();
  }

  /** Call once per rendered frame. */
  update(frame: DrivingFrame, dt: number): void {
    const t = this.ctx.currentTime;
    const squeal = squealTone(frame.slide, frame.speed);
    // A slight wobble keeps the squeal from sounding like a pure whistle.
    this.squealBand.frequency.setTargetAtTime(squeal.frequency * (1 + (Math.random() - 0.5) * 0.06), t, SMOOTHING);
    this.squealGain.gain.setTargetAtTime(squeal.level * SQUEAL_VOLUME, t, SMOOTHING);

    const wind = windTone(frame.speed);
    this.windFilter.frequency.setTargetAtTime(wind.frequency, t, SMOOTHING);
    this.windGain.gain.setTargetAtTime(wind.level * WIND_VOLUME, t, SMOOTHING);

    const kerb = kerbTone(frame.onKerb, frame.speed);
    this.kerb.frequency.setTargetAtTime(kerb.frequency, t, SMOOTHING);
    this.kerbGain.gain.setTargetAtTime(kerb.level * KERB_VOLUME, t, 0.02);

    this.hold = Math.max(this.hold - dt, 0);
    const hit = impactLevel(frame.impact);
    if (hit > 0 && this.hold === 0) {
      this.hold = IMPACT_HOLD;
      this.thump(hit);
    }
  }

  /** A short burst of low noise that dies away: a hit on the bodywork. */
  private thump(level: number): void {
    const t = this.ctx.currentTime;
    const source = new AudioBufferSourceNode(this.ctx, { buffer: this.noise });
    const filter = new BiquadFilterNode(this.ctx, { type: 'lowpass', frequency: 250 + 500 * level });
    const gain = new GainNode(this.ctx, { gain: level * IMPACT_VOLUME });
    gain.gain.setValueAtTime(level * IMPACT_VOLUME, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    source.connect(filter).connect(gain).connect(this.destination);
    source.start(t, Math.random() * 0.5, 0.35);
  }
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
