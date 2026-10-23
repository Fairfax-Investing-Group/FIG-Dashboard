export type LineObservation = { timestamp: number; value: number };
export type PixelPoint = { x: number; y: number };

export function nearestObservation(points: LineObservation[], timestamp: number): LineObservation | null {
  if (!Number.isFinite(timestamp)) return null;
  return points.reduce<LineObservation | null>((nearest, point) => !nearest || Math.abs(point.timestamp - timestamp) < Math.abs(nearest.timestamp - timestamp) ? point : nearest, null);
}

/** Sample a line continuously within its historical range. */
export function interpolatedObservation(points: LineObservation[], timestamp: number, scale: 'linear' | 'log' = 'linear'): LineObservation | null {
  if (!Number.isFinite(timestamp) || !points.length || timestamp < points[0].timestamp || timestamp > points.at(-1)!.timestamp) return null;
  const exact = points.find(point => point.timestamp === timestamp);
  if (exact) return exact;
  const index = points.findIndex(point => point.timestamp > timestamp);
  const left = points[index - 1], right = points[index];
  if (!left || !right || (scale === 'log' && (left.value <= 0 || right.value <= 0))) return null;
  const fraction = (timestamp - left.timestamp) / (right.timestamp - left.timestamp);
  const value = scale === 'log' ? Math.exp(Math.log(left.value) + fraction * (Math.log(right.value) - Math.log(left.value))) : left.value + fraction * (right.value - left.value);
  return Number.isFinite(value) ? { timestamp, value } : null;
}

/** Hit-test rendered segments in pixels, respecting gaps and a small hover radius. */
export function nearestChartLine<T extends string>(lines: { id: T; points: (PixelPoint | null)[]; priority?: number }[], pointer: PixelPoint, radius = 18): T | null {
  let nearest: T | null = null;
  let distance = radius * radius;
  let priority = -Infinity;
  for (const line of lines) {
    let previous: PixelPoint | null = null;
    for (const point of line.points) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        previous = null;
        continue;
      }
      const start = previous ?? point;
      const dx = point.x - start.x, dy = point.y - start.y;
      const length = dx * dx + dy * dy;
      const fraction = length === 0 ? 0 : Math.max(0, Math.min(1, ((pointer.x - start.x) * dx + (pointer.y - start.y) * dy) / length));
      const squared = (pointer.x - start.x - fraction * dx) ** 2 + (pointer.y - start.y - fraction * dy) ** 2;
      const candidatePriority = line.priority ?? 0;
      if (squared < radius * radius && (candidatePriority > priority || (candidatePriority === priority && squared < distance))) {
        nearest = line.id;
        distance = squared;
        priority = candidatePriority;
      }
      previous = point;
    }
  }
  return nearest;
}
