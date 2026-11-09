import type { InputState } from './input';

/**
 * Wire protocol between the phone controller, the relay server and the game.
 *
 * The relay pairs the two and carries their WebRTC signalling ({@link RtcMessage}); it
 * also announces the room and peer changes itself ({@link RelayMessage}). Everything else
 * goes over the WebRTC data channel only: inputs as small binary packets (phone → game,
 * 60 Hz) and JSON text messages ({@link HostMessage}, {@link PadMessage}).
 */

export const CONTROLLER_WS_PATH = '/controller-ws';
export const CONTROLLER_PAGE = '/controller.html';

/** Room codes avoid look-alike characters (0/O, 1/I/L) so they can be typed from the screen. */
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;

export function isRoomCode(value: string): boolean {
  return value.length === ROOM_CODE_LENGTH && [...value].every((c) => ROOM_ALPHABET.includes(c));
}

export type Role = 'host' | 'pad';

/** Sent by the relay itself. */
export type RelayMessage =
  /** To the host: the room it owns and the addresses a phone on the LAN can open. */
  | { t: 'room'; code: string; urls: string[] }
  /** The other side of the room connected or went away. */
  | { t: 'peer'; connected: boolean }
  /** A newer phone took over this room; don't reconnect. */
  | { t: 'replaced' };

/** Game → phone. */
export type HostMessage =
  | { t: 'ping'; id: number }
  | { t: 'status'; rttMs: number | null; paused: boolean }
  /** Vibration pattern (ms on, off, on, ...). */
  | { t: 'buzz'; pattern: number[] };

/** Phone → game (inputs go as binary, see {@link encodeInput}). */
export type PadMessage = { t: 'pong'; id: number };

/**
 * WebRTC signalling, the only thing the relay passes between game and phone. The phone
 * offers a data channel and the game answers.
 */
export type RtcMessage =
  | { t: 'rtc-offer'; sdp: string }
  | { t: 'rtc-answer'; sdp: string }
  | { t: 'rtc-ice'; candidate: RTCIceCandidateInit };

/** Label of the phone → game data channel. */
export const RTC_CHANNEL_LABEL = 'input';
/** Unordered and never retransmitted: a late input is worse than a lost one. */
export const RTC_CHANNEL_OPTIONS: RTCDataChannelInit = { ordered: false, maxRetransmits: 0 };

export type ControlMessage = RelayMessage | HostMessage | PadMessage | RtcMessage;

export function isRtcMessage(message: ControlMessage): message is RtcMessage {
  return message.t === 'rtc-offer' || message.t === 'rtc-answer' || message.t === 'rtc-ice';
}

export function parseControlMessage(text: string): ControlMessage | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && typeof (value as { t?: unknown }).t === 'string') {
      return value as ControlMessage;
    }
  } catch {
    // Not JSON: ignore.
  }
  return null;
}

// Binary input packet, little-endian:
//   u8  version
//   u16 sequence number (wraps)
//   i16 steer   × 32767
//   u8  throttle × 255
//   u8  brake    × 255
//   u8  buttons  (Button bits 0-6, handbrake in bit 7)
export const INPUT_PACKET_VERSION = 1;
export const INPUT_PACKET_BYTES = 8;
const HANDBRAKE_BIT = 1 << 7;

export function encodeInput(input: InputState, seq: number): ArrayBuffer {
  const buffer = new ArrayBuffer(INPUT_PACKET_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, INPUT_PACKET_VERSION);
  view.setUint16(1, seq & 0xffff, true);
  view.setInt16(3, Math.round(clamp(input.steer, -1, 1) * 32767), true);
  view.setUint8(5, Math.round(clamp(input.throttle, 0, 1) * 255));
  view.setUint8(6, Math.round(clamp(input.brake, 0, 1) * 255));
  view.setUint8(7, (input.buttons & ~HANDBRAKE_BIT & 0xff) | (input.handbrake ? HANDBRAKE_BIT : 0));
  return buffer;
}

export function decodeInput(data: ArrayBuffer | ArrayBufferView): { seq: number; input: InputState } | null {
  const view =
    data instanceof ArrayBuffer ? new DataView(data) : new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.byteLength !== INPUT_PACKET_BYTES || view.getUint8(0) !== INPUT_PACKET_VERSION) return null;
  const buttons = view.getUint8(7);
  return {
    seq: view.getUint16(1, true),
    input: {
      steer: view.getInt16(3, true) / 32767,
      throttle: view.getUint8(5) / 255,
      brake: view.getUint8(6) / 255,
      handbrake: (buttons & HANDBRAKE_BIT) !== 0,
      buttons: buttons & ~HANDBRAKE_BIT,
    },
  };
}

/** True if `seq` is newer than `last`, allowing for the 16-bit wrap. */
export function isNewerSeq(seq: number, last: number): boolean {
  const diff = (seq - last) & 0xffff;
  return diff !== 0 && diff < 0x8000;
}

// ---------------------------------------------------------------------------------------
// Tilt steering

export interface SteeringConfig {
  /** Tilt around the calibrated centre that is ignored, degrees. */
  deadzoneDeg: number;
  /** Tilt that gives full lock, degrees. */
  maxLockDeg: number;
  /** 0 = linear, 1 = fully cubic (fine control near centre, fast near lock). */
  curve: number;
}

/**
 * Hands holding a phone wobble by a degree or two. A wide lock range and a strong curve
 * keep that wobble to a tiny steer value, so the car tracks straight at speed.
 */
export const DEFAULT_STEERING: SteeringConfig = { deadzoneDeg: 2.5, maxLockDeg: 40, curve: 0.4 };

/**
 * Wheel angle of a phone held like a steering wheel, from the gravity vector in device
 * coordinates (m/s², pointing up when at rest, as `GravitySensor` and
 * `accelerationIncludingGravity` report it). `screenAngle` is `screen.orientation.angle`.
 * Positive = turned clockwise (right). Returns null when the phone is too close to flat
 * for the angle to mean anything.
 */
export function wheelAngleDeg(gx: number, gy: number, screenAngleDeg: number): number | null {
  const a = (screenAngleDeg * Math.PI) / 180;
  const right = gx * Math.cos(a) - gy * Math.sin(a);
  const up = gx * Math.sin(a) + gy * Math.cos(a);
  // Tipped far back, little gravity is left in the screen plane and the angle gets noisy.
  if (Math.hypot(right, up) < 3) return null;
  return (Math.atan2(-right, up) * 180) / Math.PI;
}

/** Signed difference a - b wrapped to (-180, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Calibrated tilt (degrees from centre) → steer value in -1..1. */
export function shapeSteering(tiltDeg: number, config: SteeringConfig): number {
  const magnitude = Math.abs(tiltDeg);
  if (magnitude <= config.deadzoneDeg) return 0;
  const span = Math.max(config.maxLockDeg - config.deadzoneDeg, 1e-3);
  const x = Math.min((magnitude - config.deadzoneDeg) / span, 1);
  const curve = clamp(config.curve, 0, 1);
  return Math.sign(tiltDeg) * ((1 - curve) * x + curve * x * x * x);
}

/**
 * One-euro filter (Casiez et al. 2012): heavy smoothing when the signal is still, almost
 * none when it moves fast, so jitter goes away without adding lag to quick steering.
 */
export class OneEuroFilter {
  private value: number | null = null;
  private derivative = 0;

  constructor(
    /** Cutoff at rest, Hz. Lower = smoother, laggier. */
    private readonly minCutoff = 1.2,
    /** How fast the cutoff rises with speed (per °/s). Higher = less lag on quick moves. */
    private readonly beta = 0.05,
    private readonly derivativeCutoff = 1,
  ) {}

  reset(): void {
    this.value = null;
    this.derivative = 0;
  }

  /** `dt` in seconds. */
  filter(x: number, dt: number): number {
    if (this.value === null || dt <= 0) {
      this.value = x;
      return x;
    }
    const dx = (x - this.value) / dt;
    this.derivative += smoothing(dt, this.derivativeCutoff) * (dx - this.derivative);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.derivative);
    this.value += smoothing(dt, cutoff) * (x - this.value);
    return this.value;
  }
}

function smoothing(dt: number, cutoffHz: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
