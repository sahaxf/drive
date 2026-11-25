import type { CarSpec } from '@drivee/shared';
import { noiseBuffer } from './AudioMixer';

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
  /** Crankshaft rotation rate, Hz: the engine orders that give the note its growl. */
  crankFrequency: number;
  /** 0..1 */
  level: number;
  /** Low-pass cutoff, Hz. A loaded engine sounds brighter and harsher. */
  cutoff: number;
  /** Gain into the saturator, ≥ 1. More = more distortion. */
  drive: number;
  /** Level of the intake and exhaust rasp (noise), 0..1. */
  rasp: number;
}

/** How the engine should sound at this rpm and load. Pure, so it can be tested without audio. */
export function engineTone(engine: EngineSpec, rpm: number, load: number): EngineTone {
  const frequency = (rpm / 60) * (engine.cylinders / 2);
  const rev = clamp01((rpm - engine.idleRpm) / (engine.redlineRpm - engine.idleRpm));
  const l = clamp01(load);
  return {
    frequency,
    crankFrequency: rpm / 60,
    level: Math.min(0.25 + 0.4 * l + 0.35 * rev, 1),
    // Even off the throttle several harmonics get through: fewer and the note turns into a hum.
    cutoff: 500 + frequency * (4 + 8 * l),
    // Always into the saturator a little: it is what mixes the pulse and crank orders into a growl.
    drive: 1.6 + 3 * l,
    rasp: 0.06 + 0.12 * rev + 0.3 * l * rev,
  };
}

/** Level into the mixer: the saturated note is loud next to the other sounds. */
const VOLUME = 0.1;
/** Ignition cuts per second at the limiter, and the share of each cycle the spark is on. */
const LIMITER_HZ = 16;
const LIMITER_DUTY = 0.6;
/** Smoothing time constant for parameter changes, seconds. Hides frame-rate steps. */
const SMOOTHING = 0.03;
const HARMONICS = 40;
const CRANK_HARMONICS = 24;
/** Random pitch flutter from one frame to the next: this much at any revs, more at idle. */
const FLUTTER = { always: 0.008, idle: 0.02 };

/**
 * Synthesized engine note. A harmonic-rich oscillator at the exhaust pulse rate is
 * amplitude-modulated at half that rate (the uneven firing that makes engines burble) and
 * mixed with a second one at the crankshaft's own rate, whose harmonics fall between the
 * pulse's (the engine orders: without them the note is a clean, organ-like tone at speed).
 * Band-passed noise adds intake rasp; the lot is saturated and low-passed according to
 * load. No samples, so it follows rpm exactly and works for any cylinder count.
 */
export class EngineSound {
  private readonly pulse: OscillatorNode;
  private readonly halfOrder: OscillatorNode;
  private readonly crank: OscillatorNode;
  private readonly noiseBand: BiquadFilterNode;
  private readonly noiseGain: GainNode;
  private readonly drive: GainNode;
  private readonly lowpass: BiquadFilterNode;
  private readonly output: GainNode;
  private limiterPhase = 0;

  constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
    private readonly engine: EngineSpec,
  ) {
    this.pulse = new OscillatorNode(ctx, { frequency: 50 });
    this.pulse.setPeriodicWave(pulseWave(ctx));
    const burble = new GainNode(ctx, { gain: 0.7 });
    this.halfOrder = new OscillatorNode(ctx, { type: 'sine', frequency: 25 });
    this.halfOrder.connect(new GainNode(ctx, { gain: 0.3 })).connect(burble.gain);
    this.crank = new OscillatorNode(ctx, { frequency: 15 });
    this.crank.setPeriodicWave(crankWave(ctx));
    const orders = new GainNode(ctx, { gain: 0.4 });
    this.crank.connect(orders);

    const noise = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx), loop: true });
    this.noiseBand = new BiquadFilterNode(ctx, { type: 'bandpass', Q: 1.5 });
    this.noiseGain = new GainNode(ctx, { gain: 0 });
    noise.connect(this.noiseBand).connect(this.noiseGain);

    this.drive = new GainNode(ctx, { gain: 1 });
    this.pulse.connect(burble).connect(this.drive);
    orders.connect(this.drive);
    this.noiseGain.connect(this.drive);
    const shaper = new WaveShaperNode(ctx, { curve: saturationCurve(), oversample: '2x' });
    this.lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.8 });
    this.output = new GainNode(ctx, { gain: 0 });
    this.drive.connect(shaper).connect(this.lowpass).connect(this.output).connect(destination);

    this.pulse.start();
    this.halfOrder.start();
    this.crank.start();
    noise.start();
  }

  /** Call once per rendered frame. */
  update(frame: EngineFrame, dt: number): void {
    const tone = engineTone(this.engine, frame.rpm, frame.load);
    let chop = 1;
    if (frame.atLimiter) {
      this.limiterPhase = (this.limiterPhase + dt * LIMITER_HZ) % 1;
      if (this.limiterPhase > LIMITER_DUTY) chop = 0.35;
    } else {
      this.limiterPhase = 0;
    }
    // Pitch never holds perfectly still: a lumpy idle, and at speed a rough note rather than a pure tone.
    const rev = clamp01((frame.rpm - this.engine.idleRpm) / (this.engine.redlineRpm - this.engine.idleRpm));
    const flutter = 1 + (Math.random() - 0.5) * (FLUTTER.always + FLUTTER.idle * (1 - rev));
    const pitch = (chop < 1 ? 0.97 : 1) * flutter;
    const frequency = tone.frequency * pitch;

    const t = this.ctx.currentTime;
    this.pulse.frequency.setTargetAtTime(frequency, t, SMOOTHING);
    this.halfOrder.frequency.setTargetAtTime(frequency / 2, t, SMOOTHING);
    this.crank.frequency.setTargetAtTime(tone.crankFrequency * pitch, t, SMOOTHING);
    this.noiseBand.frequency.setTargetAtTime(frequency * 4, t, SMOOTHING);
    this.noiseGain.gain.setTargetAtTime(tone.rasp, t, SMOOTHING);
    this.drive.gain.setTargetAtTime(tone.drive, t, SMOOTHING);
    this.lowpass.frequency.setTargetAtTime(Math.min(tone.cutoff * (chop < 1 ? 0.5 : 1), 16000), t, SMOOTHING);
    // The limiter chop needs a faster envelope than the other parameters to be heard.
    this.output.gain.setTargetAtTime(tone.level * chop * VOLUME, t, frame.atLimiter ? 0.005 : SMOOTHING);
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

/** One turn of the crankshaft: every engine order, the low ones strongest. */
function crankWave(ctx: AudioContext): PeriodicWave {
  const real = new Float32Array(CRANK_HARMONICS + 1);
  const imag = new Float32Array(CRANK_HARMONICS + 1);
  for (let n = 1; n <= CRANK_HARMONICS; n++) {
    // Mixed phases, so the orders don't line up into one sharp click per turn.
    const phase = n * n * 0.7;
    real[n] = Math.cos(phase) / Math.pow(n, 0.8);
    imag[n] = Math.sin(phase) / Math.pow(n, 0.8);
  }
  return ctx.createPeriodicWave(real, imag);
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
