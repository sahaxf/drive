import { describe, expect, it } from 'vitest';
import { GameLoop } from '../src/core/GameLoop';

function makeLoop() {
  const calls = { steps: 0, alphas: [] as number[] };
  const loop = new GameLoop(
    {
      step: () => calls.steps++,
      render: (alpha) => calls.alphas.push(alpha),
    },
    1 / 120,
  );
  return { loop, calls };
}

describe('GameLoop', () => {
  it('runs a fixed number of steps per second regardless of frame rate', () => {
    for (const fps of [30, 60, 144]) {
      const { loop, calls } = makeLoop();
      for (let f = 0; f <= fps; f++) loop.tick(f / fps);
      expect(calls.steps).toBeGreaterThanOrEqual(119);
      expect(calls.steps).toBeLessThanOrEqual(120);
    }
  });

  it('reports interpolation alpha in [0, 1)', () => {
    const { loop, calls } = makeLoop();
    for (let f = 0; f < 50; f++) loop.tick(f * 0.0137);
    for (const a of calls.alphas) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });

  it('drops long stalls instead of running thousands of catch-up steps', () => {
    const { loop, calls } = makeLoop();
    loop.tick(0);
    loop.tick(10);
    expect(calls.steps).toBe(30);
  });
});
