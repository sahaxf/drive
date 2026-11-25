/** Smoothing time constant for volume changes, seconds. */
const SMOOTHING = 0.03;

/**
 * The game's one audio context and master volume. Every sound connects to `output`, so
 * muting, pausing and the volume setting act on all of them at once.
 */
export class AudioMixer {
  /** Null where Web Audio is unavailable (tests, very old browsers). */
  static create(): AudioMixer | null {
    if (typeof AudioContext === 'undefined') return null;
    return new AudioMixer(new AudioContext());
  }

  readonly output: GainNode;

  private constructor(readonly ctx: AudioContext) {
    this.output = new GainNode(ctx, { gain: 0 });
    this.output.connect(ctx.destination);

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

  /** Call once per rendered frame. `volume` is 0..1; `audible` false fades everything out (paused). */
  update(volume: number, audible: boolean): void {
    this.output.gain.setTargetAtTime(audible ? volume : 0, this.ctx.currentTime, SMOOTHING);
  }
}

/** One second of white noise, to loop. */
export function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
