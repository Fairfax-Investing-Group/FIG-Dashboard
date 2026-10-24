import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis, usePlotArea, useXAxisScale, useYAxisScale, useXAxisInverseScale, ZIndexLayer } from 'recharts';
import type { AnnualRow, MarketQuote, Metric, Study } from './types';
import { annualGrowth, fiveYearAverage, fiveYearEstimate, logLinearRegression } from './financialMath';
import { nearestChartLine, nearestObservation, interpolatedObservation } from './chartInteraction';
import { trailingFinancials } from './trailingFinancials';
import { FIRST_HISTORY_YEAR, reportingYear, reportingYearOffset } from './reportingYears';
import ValuationPage from './ValuationPage';
import NewsPage from './NewsPage';
import { ExclusionYear, ExclusionValue, ExclusionHelp, isValueExcluded, metricExcludedYears, valueId, type TableExclusions } from './ExclusionControls';

const metrics: { key: FinancialChartKey; title: string; color: string; note: string }[] = [
  { key: 'sales', title: 'Sales', color: '#2563eb', note: 'Annual revenue' },
  { key: 'eps', title: 'Earnings per share', color: '#7c3aed', note: 'Diluted EPS' },
  { key: 'pretaxProfit', title: 'Pre-tax profit', color: '#0d9488', note: 'Annual income before tax' },
  { key: 'freeCashFlowPerShare', title: 'FCF / Share', color: '#0d9488', note: 'Free cash flow per diluted share' },
  { key: 'bookValuePerShare', title: 'BV / Share', color: '#d97706', note: 'Common equity per period-end share' },
];

function money(value: number | null, currency: string | null, eps = false): string {
  if (value === null) return '—';
  return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: eps ? 2 : 0, maximumFractionDigits: eps ? 2 : 0 }).format(value)}${currency ? ` ${currency}` : ''}`;
}
function displayDate(date: string) {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

type FinancialChartKey = Metric | 'bookValuePerShare' | 'freeCashFlowPerShare';
type ChartKey = FinancialChartKey | 'close';
type ChartLineId = `${ChartKey}:actual` | `${FinancialChartKey}:fit`;
type ChartPoint = { timestamp: number; reportedAt?: number; quarter?: number; fiscalYear?: number; displayYear?: number } & Partial<Record<ChartKey, number | null>>;
const chartSeries: { key: ChartKey; title: string; label: string; color: string }[] = [
  { key: 'sales', title: 'Sales', label: 'Sales', color: '#36a655' },
  { key: 'eps', title: 'Split-normalized EPS', label: 'EPS', color: '#d946cf' },
  { key: 'pretaxProfit', title: 'Pre-tax profit', label: 'PTP', color: '#2874d0' },
  { key: 'bookValuePerShare', title: 'Book Value / Share', label: 'BV/Share', color: '#d97706' },
  { key: 'freeCashFlowPerShare', title: 'Free Cash Flow / Share', label: 'FCF/Share', color: '#0d9488' },
  { key: 'close', title: 'Split-normalized price', label: 'Price', color: '#64748b' },
];
const timestamp = (value: string) => Date.parse(`${value}T00:00:00Z`);
const chartDate = (value: number) => displayDate(new Date(value).toISOString().slice(0, 10));
const quarterlyDotFill = (color: string) => `#${[1, 3, 5].map(offset => Math.round(parseInt(color.slice(offset, offset + 2), 16) * 0.3 + 255 * 0.7).toString(16).padStart(2, '0')).join('')}`;

type HoverLine = {
  id: ChartLineId;
  name: string;
  points: { timestamp: number; value: number | null }[];
  observations: { timestamp: number; value: number }[];
  color: string;
  formatValue: (value: number) => string;
  periods: Record<number, string>;
};
type HoveredObservation = { id: ChartLineId; timestamp: number; clientX: number; clientY: number };
type PointerPosition = { svg: SVGSVGElement; clientX: number; clientY: number };

function SeriesBaselines({ labels }: { labels: { key: ChartKey; value: number }[] }) {
  const area = usePlotArea(), yScale = useYAxisScale();
  if (!area || !yScale) return null;
  return <ZIndexLayer zIndex={2000}><g pointerEvents="none" aria-hidden="true">{labels.map(label => <g key={label.key} className={`draggable-series-${label.key}`}><line x1={area.x} x2={area.x + area.width} y1={yScale(label.value)} y2={yScale(label.value)} stroke="#e8edf0"/></g>)}</g></ZIndexLayer>;
}

function LineHoverLayer({ lines, onMove }: { lines: HoverLine[]; onMove: (key: ChartKey, delta: number) => void }) {
  const area = usePlotArea();
  const xScale = useXAxisScale(), yScale = useYAxisScale(), xInverse = useXAxisInverseScale();
  const [hovered, setHovered] = useState<HoveredObservation | null>(null);
  const frame = useRef<number | null>(null);
  const pendingPointer = useRef<PointerPosition | null>(null);
  const drag = useRef<{ key: ChartKey; startY: number; delta: number; min: number; max: number; elements: SVGElement[] } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Pixel geometry and formatters remain cached while only the hover overlay moves.
  const targets = useMemo(() => lines.map(line => ({ ...line,
    validPoints: line.points.filter((point): point is { timestamp: number; value: number } => point.value !== null),
    priority: line.id.endsWith(':actual') ? 1 : 0,
    pixels: line.points.map(point => {
      const x = xScale?.(point.timestamp), y = point.value === null ? undefined : yScale?.(point.value);
      return x === undefined || y === undefined ? null : { x, y };
    }),
  })), [lines, xScale, yScale]);
  const pixels = useMemo(() => targets.map(line => ({ id: line.id, priority: line.priority, points: line.pixels })), [targets]);

  // Drag previews move SVG groups without recalculating chart data each frame.
  useLayoutEffect(() => {
    if (!drag.current) return;
    for (const element of drag.current.elements) element.style.transform = '';
    drag.current = null;
  }, [lines]);

  function clearHover() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    pendingPointer.current = null;
    setHovered(null);
  }
  useEffect(() => {
    window.addEventListener('scroll', clearHover, true);
    window.addEventListener('resize', clearHover);
    return () => {
      window.removeEventListener('scroll', clearHover, true);
      window.removeEventListener('resize', clearHover);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  function hitAt(pointer: PointerPosition) {
    const bounds = pointer.svg.getBoundingClientRect();
    const x = (pointer.clientX - bounds.left) * (pointer.svg.viewBox.baseVal.width || bounds.width) / bounds.width;
    const y = (pointer.clientY - bounds.top) * (pointer.svg.viewBox.baseVal.height || bounds.height) / bounds.height;
    const id = nearestChartLine(pixels, { x, y });
    const line = targets.find(line => line.id === id);
    const time = Number(xInverse?.(x));
    const observation = line ? id?.endsWith(':fit') ? interpolatedObservation(line.validPoints, time) : nearestObservation(line.validPoints, time) : null;
    return id && observation ? { id, timestamp: observation.timestamp, clientX: pointer.clientX, clientY: pointer.clientY } : null;
  }
  function pointerPosition(event: { currentTarget: SVGRectElement; clientX: number; clientY: number }): PointerPosition | null {
    const svg = event.currentTarget.closest('svg');
    return svg ? { svg, clientX: event.clientX, clientY: event.clientY } : null;
  }
  function previewDrag(pointer: PointerPosition) {
    const current = drag.current;
    if (!current) return;
    const bounds = pointer.svg.getBoundingClientRect();
    const scale = (pointer.svg.viewBox.baseVal.height || bounds.height) / bounds.height;
    current.delta = Math.max(current.min, Math.min(current.max, (pointer.clientY - current.startY) * scale));
    for (const element of current.elements) element.style.transform = `translateY(${current.delta}px)`;
  }
  function startDrag(event: React.PointerEvent<SVGRectElement>) {
    if (event.button !== 0 || !area) return;
    const pointer = pointerPosition(event);
    const hit = pointer ? hitAt(pointer) : null;
    if (!pointer || !hit) return;
    clearHover();
    const key = hit.id.split(':')[0] as ChartKey;
    const ys = targets.filter(line => line.id.startsWith(`${key}:`)).flatMap(line => line.pixels.flatMap(point => point ? [point.y] : []));
    drag.current = { key, startY: pointer.clientY, delta: 0, min: Math.min(0, area.y - Math.min(...ys)), max: Math.max(0, area.y + area.height - Math.max(...ys)), elements: [...new Set([...pointer.svg.querySelectorAll<SVGElement>(`.draggable-series-${key}`)].map(element =>
      // Recharts portals dots separately from curves; move their whole group.
      element.closest<SVGElement>('.recharts-line-dots') ?? element))] };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }
  function endDrag(event: React.PointerEvent<SVGRectElement>, cancel = false) {
    const current = drag.current;
    if (!current) return;
    const pointer = pointerPosition(event);
    if (pointer && !cancel) previewDrag(pointer);
    clearHover();
    setDragging(false);
    if (!cancel && current.delta !== 0 && yScale) {
      const unitHeight = yScale(0)! - yScale(1)!;
      onMove(current.key, -current.delta / unitHeight);
    } else {
      for (const element of current.elements) element.style.transform = '';
      drag.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function queuePointer(event: { currentTarget: SVGRectElement; clientX: number; clientY: number }) {
    pendingPointer.current = pointerPosition(event);
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const pointer = pendingPointer.current;
      if (pointer && drag.current) previewDrag(pointer);
      else setHovered(pointer ? hitAt(pointer) : null);
    });
  }
  const target = targets.find(line => line.id === hovered?.id);
  const regression = target?.id.endsWith(':fit');
  const marked = target && hovered ? regression ? interpolatedObservation(target.validPoints, hovered.timestamp) : nearestObservation(target.validPoints, hovered.timestamp) : null;
  const observation = target && hovered ? regression ? interpolatedObservation(target.observations, hovered.timestamp, 'log') : nearestObservation(target.observations, hovered.timestamp) : null;
  if (!area || !xScale || !yScale || !xInverse) return null;
  return <>
    <ZIndexLayer zIndex={2500}><g className="line-hover-layer">
      <rect data-testid="line-hover-area" x={area.x} y={area.y} width={area.width} height={area.height} fill="transparent" style={{ cursor: dragging ? 'grabbing' : hovered ? 'grab' : 'crosshair', touchAction: 'none' }} onPointerMove={queuePointer} onPointerDown={startDrag} onPointerUp={event => endDrag(event)} onPointerLeave={() => { if (!drag.current) clearHover(); }} onPointerCancel={event => endDrag(event, true)} onMouseMove={event => event.stopPropagation()} onTouchMove={event => event.stopPropagation()}/>
      {marked && target && <g pointerEvents="none"><line x1={xScale(marked.timestamp)} x2={xScale(marked.timestamp)} y1={area.y} y2={area.y + area.height} stroke={target.color} strokeOpacity={0.25} strokeDasharray="3 4"/><circle cx={xScale(marked.timestamp)} cy={yScale(marked.value)} r={3} fill={target.color} stroke="white" strokeWidth={1.2}/></g>}
    </g></ZIndexLayer>
    {hovered && target && observation && createPortal(<div role="tooltip" style={{ position: 'fixed', left: 0, top: 0, width: 'max-content', transform: `translate3d(${hovered.clientX}px, ${hovered.clientY}px, 0)`, willChange: 'transform', pointerEvents: 'none', zIndex: 1000 }}><div className="overlay-tooltip"><b>{target.name}</b><span>{target.periods[observation.timestamp] ?? new Date(observation.timestamp).getUTCFullYear()}</span><b style={{ color: target.color }}>{target.formatValue(observation.value)}</b></div></div>, document.body)}
  </>;
}

function YearTick({ x = 0, y = 0, payload, excludedYears, onToggle }: { x?: number; y?: number; payload?: { value: number }; excludedYears: number[]; onToggle: (year: number) => void }) {
  if (!payload) return null;
  const year = new Date(Number(payload.value)).getUTCFullYear();
  const excluded = excludedYears.includes(year);
  return <g transform={`translate(${x},${y})`} className={`year-tick${excluded ? ' is-excluded' : ''}`} role="button" tabIndex={0} aria-label={`${excluded ? 'Include' : 'Exclude'} ${year} in growth calculations`} aria-pressed={!excluded} onClick={() => onToggle(year)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(year); } }}>
    <title>{`${excluded ? 'Include' : 'Exclude'} ${year} in growth calculations`}</title><rect x={-16} y={-4} width={32} height={22} rx={5} fill="transparent"/><text y={6} textAnchor="middle" fontSize={10} fontWeight={500} fill={excluded ? '#a5adb6' : '#7c8793'} textDecoration={excluded ? 'line-through' : undefined}>{String(year).slice(-2)}</text>
  </g>;
}

const OverlayChart = memo(function OverlayChart({ annual, study, excludedYears, onToggleYear, onRestoreYears, excludedValues, onResetExclusions, pending = false }: { pending?: boolean; annual: AnnualRow[]; study: Study; excludedYears: number[]; excludedValues: string[]; onToggleYear: (year: number) => void; onRestoreYears: () => void; onResetExclusions: () => void }) {
  const [offsets, setOffsets] = useState<Partial<Record<ChartKey, number>>>({});
  const [hidden, setHidden] = useState<ChartLineId[]>([]);
  const yearOffset = reportingYearOffset(annual);
  const financials: ChartPoint[] = annual.map(row => ({ timestamp: Date.UTC(reportingYear(row, yearOffset), 0, 1), displayYear: reportingYear(row, yearOffset), reportedAt: timestamp(row.periodEnd), fiscalYear: row.fiscalYear ?? Number(row.periodEnd.slice(0, 4)), sales: row.sales, eps: row.eps, pretaxProfit: row.pretaxProfit, bookValuePerShare: row.bookValuePerShare ?? null, freeCashFlowPerShare: row.freeCashFlowPerShare ?? null }));
  const lastAnnualDate = annual.map(row => row.periodEnd).sort().at(-1);
  const trailingQuarters = trailingFinancials(annual, (study.quarterly ?? []).map(row => ({ ...row,
    eps: study.epsAdjustment?.status === 'normalized' && row.epsSplitFactor != null && row.epsSplitFactor > 0 ? row.eps : null,
  })));
  const quarters: ChartPoint[] = lastAnnualDate ? trailingQuarters.filter(row => row.periodEnd > lastAnnualDate && (!row.form || ['10-Q', '10-Q/A', '6-K', '6-K/A'].includes(row.form))).map(row => ({
    timestamp: timestamp(row.periodEnd), quarter: row.quarter, fiscalYear: row.fiscalYear, displayYear: reportingYear(row, yearOffset),
    sales: row.sales, eps: study.epsAdjustment?.status === 'normalized' && row.epsSplitFactor != null && row.epsSplitFactor > 0 ? row.eps : null,
    pretaxProfit: row.pretaxProfit, bookValuePerShare: row.bookValuePerShare ?? null, freeCashFlowPerShare: row.freeCashFlowPerShare ?? null,
  })) : [];
  const prices: ChartPoint[] = study.prices.filter(point => Number(point.date.slice(0, 4)) >= FIRST_HISTORY_YEAR).map(point => ({ timestamp: timestamp(point.date), close: point.close }));
  const points = new Map<number, ChartPoint>();
  for (const point of [...financials, ...quarters, ...prices]) points.set(point.timestamp, { ...points.get(point.timestamp), ...point });
  const timeline = [...points.values()].sort((a, b) => a.timestamp - b.timestamp);
  const series = chartSeries.map(definition => {
    const metric = definition.key === 'close' && study.priceInterval === '1wk' ? { ...definition, title: 'Split-normalized price · Weekly closes' } : definition;
    const source = (metric.key === 'close' ? prices : [...financials, ...quarters]).slice().sort((a, b) => a.timestamp - b.timestamp);
    const baseline = source.find(point => point[metric.key] != null && point[metric.key] !== 0)?.[metric.key];
    const data = source.map(point => ({ ...point, [metric.key]: point[metric.key] == null ? null : baseline == null ? (point[metric.key] === 0 ? 0 : null) : point[metric.key]! / Math.abs(baseline) * 100 }));
    const annualPoints = data.filter(point => point.quarter == null).map(point => ({ periodEnd: new Date(point.timestamp).toISOString().slice(0, 10), value: point[metric.key] ?? null }));
    const includedRegression = metric.key === 'close' ? null : logLinearRegression(annualPoints, metricExcludedYears({ excludedYears, excludedValues }, metric.key), annualPoints.map(point => point.periodEnd));
    // Keep a clearly labelled reference fit if exclusions leave too few points.
    // Growth calculations in the table still become unavailable in that case.
    const regression = includedRegression ?? (metric.key !== 'close' && metricExcludedYears({ excludedYears, excludedValues }, metric.key).length > 0 ? logLinearRegression(annualPoints) : null);
    const referenceFit = includedRegression === null && regression !== null;
    const regressionData: ChartPoint[] = regression?.fitted.map(point => ({ timestamp: timestamp(point.periodEnd), [metric.key]: point.value })) ?? [];
    const latest = source.filter(point => point.quarter == null && point[metric.key] != null).at(-1);
    return { ...metric, data, rawData: source, referenceFit, regressionRaw: regressionData.map(point => ({ timestamp: point.timestamp, [metric.key]: point[metric.key]! * Math.abs(baseline!) / 100 })), regressionData, regressionRate: includedRegression?.growthRate ?? null, latest, baselineDate: source.find(point => point[metric.key] != null && point[metric.key] !== 0)?.reportedAt ?? source.find(point => point[metric.key] != null && point[metric.key] !== 0)?.timestamp };
  });
  const lines = series.flatMap(metric => {
    const actual = metric.rawData.filter(point => point[metric.key] != null && (metric.key === 'close' || !isValueExcluded({ excludedYears, excludedValues }, metric.key, point.displayYear ?? new Date(point.timestamp).getUTCFullYear()))).map(point => ({ timestamp: point.timestamp, value: point[metric.key]! }));
    const fit = metric.regressionRaw.map(point => ({ timestamp: point.timestamp, value: point[metric.key]! }));
    return [
      ...(actual.length ? [{ id: `${metric.key}:actual` as ChartLineId, key: metric.key, name: `${metric.title} · Actual`, color: metric.color, kind: 'actual' as const, observations: actual }] : []),
      ...(fit.length ? [{ id: `${metric.key}:fit` as ChartLineId, key: metric.key, name: `${metric.title} · ${metric.referenceFit ? 'Reference fit' : 'Regression'}`, color: metric.color, kind: 'fit' as const, observations: fit }] : []),
    ];
  });
  const visibleLines = lines.filter(line => !hidden.includes(line.id));
  const visible = series.filter(metric => visibleLines.some(line => line.key === metric.key));
  const lineVisible = (id: ChartLineId) => lines.some(line => line.id === id) && !hidden.includes(id);
  function toggleLine(id: ChartLineId) {
    setHidden(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  }
  const values = visible.flatMap(metric => metric.data.map(point => point[metric.key] ?? null));
  const hasData = values.some(value => value !== null);
  const firstYear = timeline.length ? new Date(timeline[0].timestamp).getUTCFullYear() : new Date().getFullYear();
  const lastYear = Math.max(2031, timeline.length ? new Date(timeline.at(-1)!.timestamp).getUTCFullYear() : firstYear);
  const yearTicks = Array.from({ length: lastYear - firstYear + 1 }, (_, index) => Date.UTC(firstYear + index, 0, 1));
  // Apply logarithms before positioning each series in its vertical band. Bands
  // overlap to give rises and dips substantial vertical range in one chart.
  const bandHeight = 3.4;
  const originalSpaced = series.map((metric, index) => {
    const available = metric.data.map(point => point[metric.key]).filter((value): value is number => value != null);
    if (!available.length) return metric;
    const signed = available.some(value => value <= 0);
    const log = (value: number) => signed ? Math.sign(value) * Math.log1p(Math.abs(value)) : Math.log(value);
    // Keep full-history bounds so excluding points never shifts remaining points.
    const logged = available.map(log);
    const min = Math.min(...logged);
    const range = Math.max(...logged) - min;
    const bottom = series.length - index - 1 + 0.15;
    return {
      ...metric,
      data: metric.data.map(point => ({
        ...point,
        [metric.key]: point[metric.key] == null ? null : bottom + (range === 0 ? bandHeight / 2 : (log(point[metric.key]!) - min) / range * bandHeight),
      })),
      regressionData: metric.regressionData.map(point => ({ ...point, [metric.key]: bottom + (range === 0 ? bandHeight / 2 : (log(point[metric.key]!) - min) / range * bandHeight) })),
    };
  });
  const isolatedPoints = visible.length === 1 ? originalSpaced.filter(metric => metric.key === visible[0].key).flatMap(metric => metric.data.map(point => point[metric.key]).filter((value): value is number => value != null)) : [];
  const spaced = originalSpaced.map(metric => ({ ...metric,
    // Remove excluded observations rather than leaving null placeholders, so
    // both the rendered line and hover geometry connect their surviving neighbors.
    data: metric.data.filter(point => metric.key === 'close' || !isValueExcluded({ excludedYears, excludedValues }, metric.key, point.displayYear ?? new Date(point.timestamp).getUTCFullYear())).map(point => ({ ...point, [metric.key]: point[metric.key] == null ? null : point[metric.key]! + (offsets[metric.key] ?? 0) })),
    regressionData: metric.regressionData.map(point => ({ ...point, [metric.key]: point[metric.key]! + (offsets[metric.key] ?? 0) })),
  }));
  const hoverLines: HoverLine[] = visibleLines.map(line => {
    const metric = spaced.find(metric => metric.key === line.key)!;
    const data = line.kind === 'fit' ? metric.regressionData : metric.data;
    const millions = line.key === 'sales' || line.key === 'pretaxProfit';
    const currency = line.key === 'close' ? study.priceCurrency : study.financialCurrency;
    const formatter = new Intl.NumberFormat('en-US', { ...(currency ? { style: 'currency' as const, currency, currencyDisplay: 'narrowSymbol' as const } : {}), minimumFractionDigits: millions ? 0 : 2, maximumFractionDigits: millions ? 0 : 2 });
    return { id: line.id, name: line.kind === 'fit' ? line.name : metric.title, observations: line.observations, color: line.color, periods: Object.fromEntries(metric.rawData.map(point => [point.timestamp, line.key === 'close' ? `${study.priceInterval === '1wk' ? 'Week of ' : ''}${chartDate(point.timestamp)}` : point.quarter == null ? String(new Date(point.timestamp).getUTCFullYear()) : `Q${point.quarter} ${point.displayYear ?? point.fiscalYear} · ${line.key === 'bookValuePerShare' ? 'Quarter-end' : 'TTM'}`])), formatValue: (value: number) => `${formatter.format(millions ? value / 1_000_000 : value)}${millions ? 'M' : ''}`, points: data.map(point => ({ timestamp: point.timestamp, value: point[line.key] ?? null })) };
  });
  const domain: [number, number] = isolatedPoints.length ? [Math.min(...isolatedPoints) - 0.2, Math.max(...isolatedPoints) + 0.2] : [0, series.length - 1 + bandHeight + 0.3];
  const baselines = spaced.filter(metric => visibleLines.some(line => line.key === metric.key)).flatMap(metric => {
    const first = metric.data.find(point => point[metric.key] != null);
    return first ? [{ key: metric.key, value: first[metric.key]! }] : [];
  });
  return <section className="chart-card overlay-chart" aria-label="Combined historical chart">
    <div className="chart-workspace">
    <aside className="chart-series-legend" aria-label="Individual line visibility">{series.map(metric => <div key={metric.key} className={`chart-series-item${pending || visibleLines.some(line => line.key === metric.key) ? '' : ' is-hidden'}`}>
      <span title={`${metric.title} · ${metric.latest ? `As of ${chartDate(metric.latest.reportedAt ?? metric.latest.timestamp)}` : 'Unavailable'}`}><i style={{ background: metric.color }}/>{metric.label}</span>
      <div className="line-toggles">{lines.filter(line => line.key === metric.key).map(line => {
        const action = hidden.includes(line.id) ? 'Show' : 'Hide';
        return <button key={line.id} title={`${action} ${line.name}`} aria-label={`${action} ${line.name}`} aria-pressed={!hidden.includes(line.id)} onClick={() => toggleLine(line.id)}><i style={{ background: metric.color, opacity: line.kind === 'fit' ? 0.4 : 1 }}/>{action === 'Hide' ? 'H' : 'S'}{line.kind === 'fit' ? 'F' : 'A'}</button>;
      })}</div>
    </div>)}<div className="sidebar-chart-controls">{study.priceInterval === '1wk' && <p className="legend-control-key">Price: weekly closes</p>}<p className="legend-control-key">HA/SA: Hide/Show Actual · HF/SF: Hide/Show Fit</p><div><button onClick={() => { setOffsets({}); setHidden([]); onResetExclusions(); }}>Reset chart</button>{excludedYears.length > 0 && <button onClick={onRestoreYears}>Restore years</button>}</div></div></aside>
    <div className="chart-main">
    {hasData ? <div className="chart-canvas overlay-canvas"><ResponsiveContainer width="100%" height="100%"><LineChart data={timeline} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
      <CartesianGrid vertical horizontal stroke="#edf1f5" syncWithTicks/>
      <XAxis dataKey="timestamp" type="number" scale="time" domain={[Date.UTC(firstYear, 0, 1), Date.UTC(lastYear, 11, 31)]} padding={{ left: 18, right: 0 }} ticks={yearTicks} tick={<YearTick excludedYears={excludedYears} onToggle={onToggleYear}/>} tickLine={false} axisLine={false} tickMargin={4} interval={0} height={22}/>
      <YAxis domain={domain} type="number" scale="linear" width={8} ticks={[]} tick={false} axisLine={{ stroke: '#e1e7e4' }} tickLine={false} allowDataOverflow/>
      <SeriesBaselines labels={baselines}/>
      {spaced.filter(metric => metric.key !== 'close' && lineVisible(`${metric.key}:fit`)).map(metric => <Line className={`draggable-series-${metric.key}`} key={`${metric.key}-regression`} data={metric.regressionData} type="linear" dataKey={metric.key} name={`${metric.title} log-linear fit`} stroke={metric.color} strokeWidth={1} strokeOpacity={0.4} dot={false} activeDot={false} tooltipType="none" legendType="none" isAnimationActive={false} style={{ cursor: 'grab' }}/>)}
      {spaced.filter(metric => lineVisible(`${metric.key}:actual`)).map(metric => <Line className={`draggable-series-${metric.key}`} key={metric.key} data={metric.data} type="linear" dataKey={metric.key} name={metric.title} stroke={metric.color} strokeWidth={metric.key === 'close' ? 0.8 : 1.5} strokeOpacity={metric.key === 'close' ? 0.65 : 1} dot={metric.key === 'close' ? false : ({ cx, cy, payload }) => typeof cx !== 'number' || typeof cy !== 'number' || !Number.isFinite(cx) || !Number.isFinite(cy) ? <g/> : <circle key={payload.timestamp} className={`draggable-series-${metric.key}`} data-fiscal-year={payload.fiscalYear} data-display-year={payload.displayYear} data-period={payload.quarter == null ? 'annual' : 'quarterly'} cx={cx} cy={cy} r={payload.quarter == null ? 2.2 : 2.8} fill={payload.quarter == null ? metric.color : quarterlyDotFill(metric.color)} strokeWidth={1.2} stroke={metric.color}><title>{metric.title} · {payload.quarter == null ? `Year ${payload.displayYear ?? payload.fiscalYear} · Year ended ${chartDate(payload.reportedAt ?? payload.timestamp)}` : `Q${payload.quarter} ${payload.displayYear ?? payload.fiscalYear} · ${metric.key === 'bookValuePerShare' ? 'Quarter-end' : 'Trailing 12 months'}`}</title></circle>} activeDot={false} connectNulls={false} isAnimationActive={false} style={{ cursor: 'grab' }}/>)}
      <LineHoverLayer lines={hoverLines} onMove={(key, delta) => { setOffsets(current => ({ ...current, [key]: (current[key] ?? 0) + delta })); }}/>
    </LineChart></ResponsiveContainer></div> : pending ? <div className="chart-canvas overlay-canvas chart-pending" aria-label="Historical chart"/> : <div className="chart-empty">{lines.length ? 'All lines are hidden. Use Show in the sidebar or Reset chart to restore them.' : 'No comparable history is available. Refresh to try again.'}</div>}
    </div>
    <aside className="company-description-panel" aria-labelledby="company-description-title"><div className="company-description-content"><h2 id="company-description-title">About {study.company.ticker}</h2>{study.overview?.Description?.trim() ? study.overview.Description.trim().split(/\n+/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>) : !pending && <p>Company description is unavailable in this study.</p>}</div></aside>
    </div>
  </section>;
});

type FinancialForecasts = { sales: string; eps: string };
const pendingAnnualRows: AnnualRow[] = Array.from({ length: 10 }, (_, index) => ({
  periodEnd: `${FIRST_HISTORY_YEAR + index}-12-31`, sales: null, eps: null, pretaxProfit: null,
  salesSource: null, epsSource: null, pretaxProfitSource: null,
}));

function FinancialTable({ annual, study, controls, forecasts, onForecastChange, pending = false }: { pending?: boolean; annual: AnnualRow[]; study: Study; controls: TableExclusions; forecasts: FinancialForecasts; onForecastChange: (key: keyof FinancialForecasts, value: string) => void }) {
  const { excludedYears } = controls;
  const placeholders = pending && annual.length === 0;
  const rows = placeholders ? pendingAnnualRows : [...annual].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  const yearOffset = reportingYearOffset(annual);
  const currency = study.financialCurrency === 'USD' ? '$' : study.financialCurrency || '';
  const totalUnit = currency ? `${currency}M` : 'millions';
  const perShareUnit = currency ? ` (${currency})` : '';
  const labels: Record<FinancialChartKey, string> = {
    sales: `Historical sales (${totalUnit})`,
    eps: `Historical EPS${perShareUnit}`,
    pretaxProfit: `Pre-tax profit (${totalUnit})`,
    freeCashFlowPerShare: `FCF / Share${perShareUnit}`,
    bookValuePerShare: `BV / Share${perShareUnit}`,
  };
  return <section className="financial-table-section fundamentals" aria-labelledby="financial-table-title">
    <div className="fundamentals-title"><h2 id="financial-table-title">Fundamental Company Data</h2><span>Annual financials</span></div>
    <ExclusionHelp controls={controls}/>
    <div className="financial-table-scroll"><table>
      <caption className="sr-only">Annual company data by fiscal year, historical annualized growth, forecast assumptions, and five-year estimates. EPS is split-normalized.</caption>
      <thead><tr><th scope="col"><span className="sr-only">Metric</span></th>{rows.map(row => <th scope="col" key={row.periodEnd} className={excludedYears.includes(reportingYear(row, yearOffset)) ? 'excluded-year-heading' : undefined} title={placeholders ? undefined : `Fiscal year ended ${displayDate(row.periodEnd)}${excludedYears.includes(reportingYear(row, yearOffset)) ? ' · Excluded from growth' : ''}`}><>{placeholders ? <span className="pending-period" aria-label="Reporting year pending">—</span> : <ExclusionYear year={reportingYear(row, yearOffset)} controls={controls}/>}</></th>)}<th scope="col" className="calculated-column">Growth (%)</th><th scope="col">Forecast (%)</th><th scope="col">5 Yr Est</th></tr></thead>
      <tbody>{metrics.map(metric => {
        const perShare = metric.key !== 'sales' && metric.key !== 'pretaxProfit';
        const scale = perShare ? 1 : 1_000_000;
        const supported = rows.filter(row => row[metric.key] != null);
        const included = supported.filter(row => !isValueExcluded(controls, metric.key, reportingYear(row, yearOffset)));
        const first = included[0];
        const latest = included.at(-1);
        const growth = annualGrowth(rows.map(row => ({ periodEnd: `${reportingYear(row, yearOffset)}-01-01`, value: row[metric.key] ?? null })), metricExcludedYears(controls, metric.key));
        const forecastKey = metric.key === 'sales' || metric.key === 'eps' ? metric.key : null;
        const estimate = forecastKey ? fiveYearEstimate(latest?.[metric.key] ?? null, forecasts[forecastKey]) : null;
        return <tr key={metric.key}>
          <th scope="row">{labels[metric.key]}</th>
          {rows.map(row => {
            const excluded = isValueExcluded(controls, metric.key, reportingYear(row, yearOffset));
            const value = money(row[metric.key] == null ? null : row[metric.key]! / scale, null, perShare);
            return <td key={row.periodEnd} className={excluded ? 'excluded-year-value' : undefined} title={excluded ? 'Excluded from growth calculations' : undefined}><ExclusionValue metric={metric.key} year={reportingYear(row, yearOffset)} name={metric.title} available={row[metric.key] != null} controls={controls}>{value}</ExclusionValue></td>;
          })}
          <td className="calculated-column" title={first && included.at(-1) ? `Log-linear regression across included fiscal years: ${displayDate(first.periodEnd)} to ${displayDate(included.at(-1)!.periodEnd)}` : undefined}>{growth === null ? '—' : `${growth.toFixed(1)}%`}</td>
          <td className="forecast-cell">{forecastKey ? <input type="number" step="0.1" min="-100" value={forecasts[forecastKey]} placeholder="—" aria-label={`${metric.title} annual forecast percentage`} onChange={event => onForecastChange(forecastKey, event.target.value)}/> : '—'}</td>
          <td className="estimate-cell">{money(estimate === null ? null : estimate / scale, null, perShare)}</td>
        </tr>;
      })}</tbody>
    </table>{!rows.length && <p className="table-empty">Annual financials could not be loaded for this company.</p>}</div>
  </section>;
}

function ManagementTrend({ values, name, lowerIsBetter = false }: { values: (number | null)[]; name: string; lowerIsBetter?: boolean }) {
  const available = values.flatMap((value, index) => value === null ? [] : [{ value, index }]);
  if (available.length < 2) return <span className="trend-unavailable">—</span>;
  const width = 152, height = 20, padding = 3;
  const min = Math.min(0, ...available.map(point => point.value)), max = Math.max(0, ...available.map(point => point.value));
  const x = (index: number) => padding + index / Math.max(1, values.length - 1) * (width - padding * 2);
  const y = (value: number) => max === min ? height / 2 : height - padding - (value - min) / (max - min) * (height - padding * 2);
  const path = available.map((point, index) => `${index ? 'L' : 'M'}${x(point.index)},${y(point.value)}`).join(' ');
  const first = available[0], last = available.at(-1)!;
  const improved = lowerIsBetter ? last.value <= first.value : last.value >= first.value;
  const color = improved ? '#238454' : '#cc4850';
  return <svg className="management-trend" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${name}: ${first.value.toFixed(1)}% to ${last.value.toFixed(1)}%`}>
    <line x1={padding} x2={width - padding} y1={y(0)} y2={y(0)} stroke="#d5dfd9"/>
    <path d={`${path} L${x(last.index)},${y(0)} L${x(first.index)},${y(0)} Z`} fill={color} fillOpacity={0.18}/>
    <path d={path} stroke={color} strokeWidth={1.8} fill="none" strokeLinejoin="round"/>
    {[first, last].map((point, index) => <circle key={index} cx={x(point.index)} cy={y(point.value)} r={2.2} fill={color}/>)}
  </svg>;
}

const ManagementTable = memo(function ManagementTable({ annual, pending = false }: { annual: AnnualRow[]; pending?: boolean }) {
  const [excludedYears, setExcludedYears] = useState<number[]>([]);
  const [excludedValues, setExcludedValues] = useState<string[]>([]);
  const controls: TableExclusions = {
    scope: 'management', excludedYears, excludedValues,
    onToggleYear: year => setExcludedYears(current => current.includes(year) ? current.filter(value => value !== year) : [...current, year]),
    onToggleValue: (metric, year) => {
      const id = valueId(metric, year);
      setExcludedValues(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
    },
    onResetExclusions: () => { setExcludedYears([]); setExcludedValues([]); },
  };
  const placeholders = pending && annual.length === 0;
  const rows = placeholders ? pendingAnnualRows : [...annual].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  const yearOffset = reportingYearOffset(annual);
  const definitions = [
    { key: 'pretaxMargin' as const, name: '% Pre-Tax Profit on Sales', lowerIsBetter: false },
    { key: 'returnOnEquity' as const, name: '% Return on Equity', lowerIsBetter: false },
    { key: 'debtToCapital' as const, name: '% Debt to Capital', lowerIsBetter: true },
  ];
  const percentage = (value: number | null) => value === null ? '—' : `${value.toFixed(1)}%`;
  return <section className="financial-table-section fundamentals management" aria-labelledby="management-table-title">
    <div className="fundamentals-title"><h2 id="management-table-title">Evaluate Management</h2><span>Profitability & capital</span></div>
    <ExclusionHelp controls={controls}/>
    <div className="financial-table-scroll"><table>
      <caption className="sr-only">Annual management ratios, latest five-year averages, and historical trends.</caption>
      <thead><tr><th scope="col"><span className="sr-only">Metric</span></th>{rows.map(row => <th scope="col" key={row.periodEnd}><>{placeholders ? <span className="pending-period" aria-label="Reporting year pending">—</span> : <ExclusionYear year={reportingYear(row, yearOffset)} controls={controls}/>}</></th>)}<th scope="col" className="calculated-column">5 Yr Avg</th><th scope="col">Trend</th></tr></thead>
      <tbody>{definitions.map(metric => {
        const values = rows.map(row => isValueExcluded(controls, metric.key, reportingYear(row, yearOffset)) ? null : row[metric.key] ?? null);
        return <tr key={metric.key}><th scope="row">{metric.name}</th>
          {rows.map((row, index) => <td key={row.periodEnd} className={index >= rows.length - 5 ? 'recent-ratio' : undefined}><ExclusionValue metric={metric.key} year={reportingYear(row, yearOffset)} name={metric.name} available={row[metric.key] != null} controls={controls}>{percentage(row[metric.key] ?? null)}</ExclusionValue></td>)}
          <td className="calculated-column management-average">{percentage(fiveYearAverage(values))}</td>
          <td className="management-trend-cell"><ManagementTrend values={values} name={metric.name} lowerIsBetter={metric.lowerIsBetter}/></td>
        </tr>;
      })}</tbody>
    </table>{!rows.length && <p className="table-empty">Annual financials could not be loaded for this company.</p>}</div>
  </section>;
});

function useMarketQuote(ticker: string) {
  const [quote, setQuote] = useState<MarketQuote | null>(null);
  const [quoteStatus, setQuoteStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  useEffect(() => {
    if (!ticker) return;
    let active = true;
    let controller: AbortController | null = null;
    setQuote(null);
    setQuoteStatus('loading');
    async function update() {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(`/api/quotes/${encodeURIComponent(ticker)}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Quote unavailable');
        const value = await response.json() as MarketQuote;
        if (!('regular' in value) || !('postMarket' in value)) throw new Error('Invalid quote');
        if (active) { setQuote(value); setQuoteStatus('ok'); }
      } catch (error) {
        if (active && !(error instanceof Error && error.name === 'AbortError')) setQuoteStatus('error');
      }
    }
    void update();
    const interval = window.setInterval(() => { if (!document.hidden) void update(); }, 60_000);
    const onVisible = () => { if (!document.hidden) void update(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { active = false; controller?.abort(); window.clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); };
  }, [ticker]);
  return { quote, quoteStatus };
}

const CompanyHeader = memo(function CompanyHeader({ study, quote, quoteStatus, pending = false }: { study: Study; quote: MarketQuote | null; quoteStatus: 'loading' | 'ok' | 'error'; pending?: boolean }) {
  const overview = study.overview ?? {};
  const latest = study.prices.at(-1), previous = study.prices.at(-2);
  const live = quote && (!study.priceCurrency || quote.currency === study.priceCurrency) ? quote : null;
  const priceCurrency = study.priceCurrency ?? live?.currency;
  const regular = live?.regular;
  const post = live?.postMarket;
  const closingPrice = regular?.price ?? latest?.close;
  const change = regular ? regular.change : study.priceInterval !== '1wk' && latest && previous ? latest.close - previous.close : null;
  const percent = regular ? regular.percent : change !== null && previous && previous.close > 0 ? change / previous.close * 100 : null;
  const signed = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
  const quoteDate = (value: string) => new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' });
  const price = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat('en-US', {
    ...(priceCurrency ? { style: 'currency', currency: priceCurrency, currencyDisplay: 'narrowSymbol' } : {}),
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(value);
  const compact = (millions: number | null | undefined, currency = false) => millions == null ? '—' : new Intl.NumberFormat('en-US', {
    notation: 'compact', maximumFractionDigits: 1,
    ...(currency && priceCurrency ? { style: 'currency', currency: priceCurrency, currencyDisplay: 'narrowSymbol' } : {}),
  }).format(millions * 1e6);
  const low = overview.LowPriceTtm, high = overview.HighPriceTtm;
  const hasRange = low != null && high != null && high >= low;
  const position = hasRange && high > low && closingPrice != null ? Math.max(0, Math.min(100, (closingPrice - low) / (high - low) * 100)) : null;
  return <header className="company-overview">
    <div className="company-profile">
      <div className="company-identity"><span className="company-ticker">{study.company.ticker}</span><div><h1>{study.company.name}</h1><div className="company-classification">{[study.company.exchange, overview.SectorDesc, overview.IndustryDesc].filter(Boolean).join(' · ') || 'Classification unavailable'}</div></div></div>
    </div>
    <div className="company-quote">
      <div className="regular-market-quote"><strong>{price(closingPrice)}</strong><span className={`quote-change ${change === null || change === 0 ? '' : change > 0 ? 'positive' : 'negative'}`}>{change === null ? pending ? '—' : 'Daily change unavailable' : `${signed(change)}${percent === null ? '' : ` (${percent > 0 ? '+' : ''}${percent.toFixed(1)}%)`}`}</span><small className="quote-date">{regular?.time ? quoteDate(regular.time) : latest ? study.priceInterval === '1wk' ? `Week of ${displayDate(latest.date)} · Weekly close` : `${displayDate(latest.date)} · Close` : pending ? '—' : 'Closing price unavailable'}</small></div>
      <div className="post-market-quote" aria-live="polite"><span className="post-market-label">Post-market</span>{post ? <><div><b>{price(post.price)}</b><span className={`quote-change ${post.change === 0 ? '' : post.change > 0 ? 'positive' : 'negative'}`}>{signed(post.change)} ({signed(post.percent)}%)</span></div><small>{quoteDate(post.time)}{quoteStatus === 'error' ? ' · Update unavailable' : ''}</small></> : <small>{quoteStatus === 'loading' ? '—' : quoteStatus === 'error' ? 'Temporarily unavailable' : 'No after-hours quote available'}</small>}</div>
    </div>
    <div className="company-range"><span>52-Week Range</span><div className={`range-track ${hasRange ? '' : 'unavailable'}`} aria-label={hasRange ? `52-week range: ${price(low)} to ${price(high)}. Latest close: ${price(latest?.close)}` : '52-week range unavailable'}>{hasRange && <div className="range-fill"/>}{position !== null && <i style={{ left: `${position}%` }}/>}</div><div className="range-values"><span>{price(low)}</span><span>{price(high)}</span></div></div>
    <dl className="company-statistics">{[
      ['Market Cap', compact(overview.MarketCap, true)], ['Beta', overview.beta == null ? '—' : overview.beta.toFixed(2)],
      ['Average Volume (3M)', compact(overview.AverageVolume)],
    ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </header>;
});

const emptyYears: number[] = [];
const emptyValues: string[] = [];

export default function StudyPage({ study, onBack, onRefresh, onFundamentalsReady, detailsStatus = 'idle', onRetryDetails, fundamentalsStatus = 'idle', fundamentalsError, onRetryFundamentals }: {
  study: Study; onBack: () => void; onRefresh: () => void;
  fundamentalsStatus?: 'idle' | 'loading' | 'error'; fundamentalsError?: string | null; onRetryFundamentals?: () => void;
  onFundamentalsReady?: (id: string) => void; detailsStatus?: 'idle' | 'loading' | 'error'; onRetryDetails?: () => void;
}) {
  useEffect(() => { onFundamentalsReady?.(study.id); }, [study.id, onFundamentalsReady]);
  const pending = fundamentalsStatus !== 'idle';
  const tabs = [{ key: 'fundamentals', label: 'Analyzing Fundamentals' }, { key: 'valuation', label: 'Valuation' }, { key: 'news', label: 'Recent News' }] as const;
  const [tab, setTab] = useState<(typeof tabs)[number]['key']>('fundamentals');
  const [forecastsByStudy, setForecastsByStudy] = useState<Record<string, FinancialForecasts>>({});
  const forecasts = forecastsByStudy[study.id] ?? { sales: '', eps: '' };
  const updateForecast = (key: keyof FinancialForecasts, value: string) => setForecastsByStudy(current => ({ ...current, [study.id]: { ...(current[study.id] ?? { sales: '', eps: '' }), [key]: value } }));
  const { quote, quoteStatus } = useMarketQuote(study.company.ticker);
  const [yearExclusions, setYearExclusions] = useState<Record<string, number[]>>({});
  const excludedYears = yearExclusions[study.id] ?? emptyYears;
  const [valueExclusions, setValueExclusions] = useState<Record<string, string[]>>({});
  const excludedValues = valueExclusions[study.id] ?? emptyValues;
  const toggleValue = useCallback((metric: string, year: number) => setValueExclusions(current => {
    const values = current[study.id] ?? [], id = valueId(metric, year);
    return { ...current, [study.id]: values.includes(id) ? values.filter(value => value !== id) : [...values, id] };
  }), [study.id]);
  const restoreYears = useCallback(() => setYearExclusions(current => ({ ...current, [study.id]: [] })), [study.id]);
  const resetExclusions = useCallback(() => { restoreYears(); setValueExclusions(current => ({ ...current, [study.id]: [] })); }, [study.id, restoreYears]);
  const toggleYear = useCallback((year: number) => setYearExclusions(current => {
    const years = current[study.id] ?? [];
    return { ...current, [study.id]: years.includes(year) ? years.filter(item => item !== year) : [...years, year] };
  }), [study.id]);
  const controls: TableExclusions = { excludedYears, excludedValues, onToggleYear: toggleYear, onToggleValue: toggleValue, onResetExclusions: resetExclusions };
  useEffect(() => {
    document.title = `${study.company.ticker} · Stock Study`;
    return () => { document.title = 'Stock Search'; };
  }, [study.company.ticker]);
  const normalized = study.epsAdjustment?.status === 'normalized';
  const annual = useMemo(() => {
    const offset = reportingYearOffset(study.annual);
    return study.annual.filter(row => reportingYear(row, offset) >= FIRST_HISTORY_YEAR).map(row => ({
      ...row, eps: normalized && row.epsSplitFactor != null && Number.isFinite(row.epsSplitFactor) && row.epsSplitFactor > 0 ? row.eps : null,
    }));
  }, [study.annual, normalized]);
  const latestEPS = [...annual].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)).filter(row => row.eps !== null && !isValueExcluded(controls, 'eps', reportingYear(row, reportingYearOffset(annual)))).at(-1)?.eps ?? null;
  const highEPSForecast = fiveYearEstimate(latestEPS, forecasts.eps);
  const errors = Object.values(study.sources).map(source => source.error).filter(Boolean);
  return <main className="study-page" aria-busy={fundamentalsStatus === 'loading'}>
    <nav className="study-nav" aria-label="Study navigation"><button className="back-button" onClick={onBack}>← Company search</button><div className="study-tabs" role="tablist" aria-label="Study sections">{tabs.map(item => <button key={item.key} id={`tab-${item.key}`} type="button" role="tab" aria-selected={tab === item.key} aria-controls={`panel-${item.key}`} tabIndex={tab === item.key ? 0 : -1} onClick={() => setTab(item.key)} onKeyDown={event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const index = tabs.findIndex(entry => entry.key === item.key);
        const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length].key;
        setTab(next);
        document.getElementById(`tab-${next}`)?.focus();
      }
    }}>{item.label}</button>)}</div><div className="study-header-actions">{pending ? <span className="export-button" aria-disabled="true">Export JSON ↓</span> : <a className="export-button" href={`/api/studies/${study.id}`} download={`${study.company.ticker}-study.json`}>Export JSON ↓</a>}<button className="primary-button" disabled={fundamentalsStatus === 'loading'} onClick={onRefresh}>↻ Refresh study</button></div></nav>
    <CompanyHeader study={study} quote={quote} quoteStatus={quoteStatus} pending={pending}/>
    {fundamentalsStatus === 'error' && <aside className="study-background-status" role="alert">{fundamentalsError ?? 'Financial data could not be loaded.'} <button type="button" className="text-button" onClick={onRetryFundamentals}>Retry</button></aside>}
    {detailsStatus === 'error' && <aside className="study-background-status" role="alert">Additional study data could not be loaded. Your fundamentals remain available. <button type="button" className="text-button" onClick={onRetryDetails}>Retry</button></aside>}
    {(errors.length > 0 || study.warnings.length > 0) && <aside className="data-notice" aria-label="Data availability"><strong>Data availability</strong><ul>{[...errors, ...study.warnings].map((warning, i) => <li key={i}>{warning}</li>)}</ul>{errors.length > 0 && <button className="text-button" onClick={onRefresh}>Retry both sources</button>}</aside>}
    {!pending && !study.epsAdjustment && <aside className="data-notice">Split-normalized EPS is unavailable in this saved study. <button className="text-button" onClick={onRefresh}>Refresh study to normalize EPS</button>.</aside>}
    <div id="panel-fundamentals" role="tabpanel" aria-labelledby="tab-fundamentals" hidden={tab !== 'fundamentals'}>
      <OverlayChart key={`chart-${study.id}`} annual={annual} study={study} pending={pending} excludedYears={excludedYears} onToggleYear={toggleYear} onRestoreYears={restoreYears} excludedValues={excludedValues} onResetExclusions={resetExclusions}/>
      <FinancialTable key={`financials-${study.id}`} annual={annual} study={study} controls={controls} pending={pending} forecasts={forecasts} onForecastChange={updateForecast}/>
      <ManagementTable key={`management-${study.id}`} annual={annual} pending={pending}/>
    </div>
    <div id="panel-valuation" role="tabpanel" aria-labelledby="tab-valuation" hidden={tab !== 'valuation'}><ValuationPage key={`valuation-${study.id}`} study={study} annual={annual} quote={quote} controls={controls} highEPSForecast={highEPSForecast} epsForecastRate={forecasts.eps} onEditEPSForecast={() => { setTab('fundamentals'); window.requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="Earnings per share annual forecast percentage"]')?.focus()); }}/></div>
    <div id="panel-news" role="tabpanel" aria-labelledby="tab-news" hidden={tab !== 'news'}><NewsPage key={study.company.ticker} ticker={study.company.ticker} active={tab === 'news'}/></div>
  </main>;
}
