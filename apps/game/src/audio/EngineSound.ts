import type { CarSpec } from '@drivee/shared';

type EngineSpec = Pick<CarSpec['engine'], 'idleRpm' | 'redlineRpm' | 'cylinders'>;

export interface EngineFrame {
  rpm: number;
  /** 0..1, see VehicleTelemetry.load. */
  load: number;
  /** Bouncing off the rev limiter: the note stutters as the ignition cuts in and out. */
  atLimiter: boolean;
}

export interface EngineTone {
  /** Exhaust pulse rate, Hz: the pitch of the note. */
  frequency: number;
  /** 0..1 */
  level: number;
  /** Low-pass cutoff, Hz. A loaded engine sounds brighter and harsher. */
  cutoff: number;
  /** Gain into the saturator, ≥ 1. More = more distortion. */
  drive: number;
}

/** How the engine should sound at this rpm and load. Pure, so it can be tested without audio. */
export function engineTone(engine: EngineSpec, rpm: number, load: number): EngineTone {
  const frequency = (rpm / 60) * (engine.cylinders / 2);
  const rev = clamp01((rpm - engine.idleRpm) / (engine.redlineRpm - engine.idleRpm));
  const l = clamp01(load);
  return {
    frequency,
    level: Math.min(0.25 + 0.4 * l + 0.35 * rev, 1),
    cutoff: 300 + frequency * (3 + 7 * l),
    drive: 1 + 3 * l,
  };
}

/** Master volume: the synthesized note is loud next to nothing else. */
const VOLUME = 0.1;
/** Ignition cuts per second at the limiter, and the share of each cycle the spark is on. */
const LIMITER_HZ = 16;
const LIMITER_DUTY = 0.6;
/** Smoothing time constant for parameter changes, seconds. Hides frame-rate steps. */
const SMOOTHING = 0.03;
const HARMONICS = 40;

/**
 * Synthesized engine note. A harmonic-rich oscillator at the exhaust pulse rate is
 * amplitude-modulated at half that rate (the uneven firing that makes engines burble),
 * mixed with band-passed noise for intake rasp, then saturated and low-passed according
 * to load. No samples, so it follows rpm exactly and works for any cylinder count.
 */
export class EngineSound {
  /** Null where Web Audio is unavailable (tests, very old browsers). */
  static create(engine: EngineSpec): EngineSound | null {
    if (typeof AudioContext === 'undefined') return null;
    return new EngineSound(new AudioContext(), engine);
  }

  private readonly pulse: OscillatorNode;
  private readonly halfOrder: OscillatorNode;
  private readonly noiseBand: BiquadFilterNode;
  private readonly noiseGain: GainNode;
  private readonly drive: GainNode;
  private readonly lowpass: BiquadFilterNode;
  private readonly output: GainNode;
  private limiterPhase = 0;

  private constructor(
    private readonly ctx: AudioContext,
    private readonly engine: EngineSpec,
  ) {
    this.pulse = new OscillatorNode(ctx, { frequency: 50 });
    this.pulse.setPeriodicWave(pulseWave(ctx));
    const burble = new GainNode(ctx, { gain: 0.7 });
    this.halfOrder = new OscillatorNode(ctx, { type: 'sine', frequency: 25 });
    this.halfOrder.connect(new GainNode(ctx, { gain: 0.3 })).connect(burble.gain);
    const rumble = new GainNode(ctx, { gain: 0.25 });
    this.halfOrder.connect(rumble);

    const noise = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx), loop: true });
    this.noiseBand = new BiquadFilterNode(ctx, { type: 'bandpass', Q: 1.5 });
    this.noiseGain = new GainNode(ctx, { gain: 0 });
    noise.connect(this.noiseBand).connect(this.noiseGain);

    this.drive = new GainNode(ctx, { gain: 1 });
    this.pulse.connect(burble).connect(this.drive);
    rumble.connect(this.drive);
    this.noiseGain.connect(this.drive);
    const shaper = new WaveShaperNode(ctx, { curve: saturationCurve(), oversample: '2x' });
    this.lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.8 });
    this.output = new GainNode(ctx, { gain: 0 });
    this.drive.connect(shaper).connect(this.lowpass).connect(this.output).connect(ctx.destination);

    this.pulse.start();
    this.halfOrder.start();
    noise.start();

    // Browsers start audio suspended until the page has had a click or key press.
    const unlock = () => {
      void ctx.resume();
      if (ctx.state === 'running') {
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('keydown', unlock);
      }
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    unlock();
    // No point droning on in a background tab, where the game isn't running anyway.
    document.addEventListener('visibilitychange', () => void (document.hidden ? ctx.suspend() : ctx.resume()));
  }

  /** Call once per rendered frame. `audible` false fades the engine out (paused, muted). */
  update(frame: EngineFrame, dt: number, audible: boolean): void {
    const tone = engineTone(this.engine, frame.rpm, frame.load);
    let chop = 1;
    if (frame.atLimiter) {
      this.limiterPhase = (this.limiterPhase + dt * LIMITER_HZ) % 1;
      if (this.limiterPhase > LIMITER_DUTY) chop = 0.35;
    } else {
      this.limiterPhase = 0;
    }
    // A little pitch wander at low revs makes the idle lumpy instead of a pure tone.
    const rev = clamp01((frame.rpm - this.engine.idleRpm) / (this.engine.redlineRpm - this.engine.idleRpm));
    const frequency = tone.frequency * (chop < 1 ? 0.97 : 1) * (1 + (Math.random() - 0.5) * 0.02 * (1 - rev));

    const t = this.ctx.currentTime;
    this.pulse.frequency.setTargetAtTime(frequency, t, SMOOTHING);
    this.halfOrder.frequency.setTargetAtTime(frequency / 2, t, SMOOTHING);
    this.noiseBand.frequency.setTargetAtTime(frequency * 4, t, SMOOTHING);
    this.noiseGain.gain.setTargetAtTime(0.05 + 0.3 * frame.load * rev, t, SMOOTHING);
    this.drive.gain.setTargetAtTime(tone.drive, t, SMOOTHING);
    this.lowpass.frequency.setTargetAtTime(Math.min(tone.cutoff * (chop < 1 ? 0.5 : 1), 16000), t, SMOOTHING);
    // The limiter chop needs a faster envelope than the other parameters to be heard.
    const level = audible ? tone.level * chop * VOLUME : 0;
    this.output.gain.setTargetAtTime(level, t, frame.atLimiter ? 0.005 : SMOOTHING);
  }
}

/** One exhaust pulse: strong low harmonics falling off slowly, so it buzzes rather than hums. */
function pulseWave(ctx: AudioContext): PeriodicWave {
  const real = new Float32Array(HARMONICS + 1);
  const imag = new Float32Array(HARMONICS + 1);
  for (let n = 1; n <= HARMONICS; n++) {
    // Alternating phase keeps the peak amplitude down, so less of it clips in the saturator.
    imag[n] = (n % 2 === 0 ? -1 : 1) / Math.pow(n, 0.9);
  }
  return ctx.createPeriodicWave(real, imag);
}

function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Soft clipping (tanh), normalised so full input maps to full output. */
function saturationCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(1024);
  const k = 2;
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
