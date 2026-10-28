/**
 * SVG path of a closed track seen from above, fitted into a `size`×`size` box with
 * `padding` around it, aspect ratio kept. Points are [x, y, z]; x is drawn rightwards,
 * z downwards (z = south in the world), so the map reads like a real circuit map.
 */
export function minimapPath(points: ReadonlyArray<readonly [number, number, number]>, size = 100, padding = 6): string {
  const { project } = fit(points, size, padding);
  return `${points.map((p, i) => `${i === 0 ? 'M' : 'L'}${project(p).map(round).join(' ')}`).join(' ')} Z`;
}

/** Map position of a point on the same fitted map (for markers like the start line). */
export function minimapPoint(
  points: ReadonlyArray<readonly [number, number, number]>,
  point: readonly [number, number, number],
  size = 100,
  padding = 6,
): [number, number] {
  return fit(points, size, padding).project(point);
}

function fit(points: ReadonlyArray<readonly [number, number, number]>, size: number, padding: number) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, , z] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const span = Math.max(maxX - minX, maxZ - minZ, 1e-6);
  const scale = (size - padding * 2) / span;
  // Centre the shorter side.
  const offsetX = (size - (maxX - minX) * scale) / 2;
  const offsetZ = (size - (maxZ - minZ) * scale) / 2;
  return {
    project: ([x, , z]: readonly [number, number, number]): [number, number] => [
      offsetX + (x - minX) * scale,
      offsetZ + (z - minZ) * scale,
    ],
  };
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
