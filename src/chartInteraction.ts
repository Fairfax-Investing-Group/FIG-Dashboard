export type LineObservation = { timestamp: number; value: number };

export function nearestObservation(points: LineObservation[], timestamp: number): LineObservation | null {
  if (!Number.isFinite(timestamp)) return null;
  return points.reduce<LineObservation | null>((nearest, point) => !nearest || Math.abs(point.timestamp - timestamp) < Math.abs(nearest.timestamp - timestamp) ? point : nearest, null);
}

/** Interpolate the displayed log-linear fit within its historical coverage only. */
export function fittedObservation(points: LineObservation[], timestamp: number): LineObservation | null {
  if (!Number.isFinite(timestamp) || !points.length || timestamp < points[0].timestamp || timestamp > points.at(-1)!.timestamp) return null;
  const exact = points.find(point => point.timestamp === timestamp);
  if (exact) return exact;
  const end = points.findIndex(point => point.timestamp > timestamp);
  const left = points[end - 1], right = points[end];
  if (!left || !right || left.value <= 0 || right.value <= 0) return null;
  const fraction = (timestamp - left.timestamp) / (right.timestamp - left.timestamp);
  return { timestamp, value: Math.exp(Math.log(left.value) + fraction * (Math.log(right.value) - Math.log(left.value))) };
}
