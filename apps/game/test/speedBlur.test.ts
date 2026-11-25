import { describe, expect, it } from 'vitest';
import { SPEED_BLUR_FULL, SPEED_BLUR_START, speedBlurAmount } from '../src/render/SpeedBlur';

describe('speed blur', () => {
  it('is off at town speeds and full at top speed', () => {
    expect(speedBlurAmount(0)).toBe(0);
    expect(speedBlurAmount(SPEED_BLUR_START)).toBe(0);
    expect(speedBlurAmount(SPEED_BLUR_FULL)).toBe(1);
    expect(speedBlurAmount(200)).toBe(1);
  });

  it('builds up smoothly with speed', () => {
    const mid = speedBlurAmount((SPEED_BLUR_START + SPEED_BLUR_FULL) / 2);
    expect(mid).toBeCloseTo(0.5);
    expect(speedBlurAmount(30)).toBeLessThan(speedBlurAmount(40));
  });
});
