let shared: AudioContext | null | undefined;

/**
 * The page's one AudioContext, created on first use. Null where Web Audio is unavailable.
 *
 * Browsers only let audio start from inside a click or key press, so call this (or
 * `unlockAudio`) from such a handler before anything wants to make a sound.
 */
export function audioContext(): AudioContext | null {
  if (shared === undefined) shared = typeof AudioContext === 'undefined' ? null : new AudioContext();
  return shared;
}

/** Create and resume the context. Call synchronously from a user gesture. */
export function unlockAudio(): void {
  void audioContext()?.resume();
}
