import { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnnualRow, FactSource, Metric, Study } from './types';
import { annualGrowth, fiveYearEstimate, logLinearRegression } from './financialMath';
import { fittedObservation, nearestObservation } from './chartInteraction';

const metrics: { key: Metric; title: string; color: string; note: string }[] = [
  { key: 'sales', title: 'Sales', color: '#2563eb', note: 'Annual revenue' },
  { key: 'eps', title: 'Earnings per share', color: '#7c3aed', note: 'Diluted EPS' },
  { key: 'pretaxProfit', title: 'Pre-tax profit', color: '#0d9488', note: 'Annual income before tax' },
];

function money(value: number | null, currency: string | null, eps = false): string {
  if (value === null) return '—';
  return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: eps ? 2 : 0, maximumFractionDigits: eps ? 2 : 0 }).format(value)}${currency ? ` ${currency}` : ''}`;
}
function displayDate(date: string) {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function SourceLink({ source, cik, value, currency, eps }: { source: FactSource | null; cik: number; value: number | null; currency: string | null; eps?: boolean }) {
  if (value === null || !source) return <span title="Not available in supported SEC facts">—</span>;
  const text = money(value, currency, eps);
  if (!source.accession) return <span>{text}</span>;
  return <a href={`https://www.sec.gov/Archives/edgar/data/${cik}/${source.accession.replaceAll('-', '')}/${source.accession}-index.html`} target="_blank" rel="noreferrer" title={`${source.concept} · filed ${source.filed} · period ended ${source.end}`}>{text}</a>;
}

type ChartKey = Metric | 'close';
type ChartLineId = `${ChartKey}:actual` | `${Metric}:fit`;
type ChartPoint = { timestamp: number } & Partial<Record<ChartKey, number | null>>;
const chartSeries: { key: ChartKey; title: string; color: string }[] = [
  { key: 'sales', title: 'Sales', color: '#36a655' },
  { key: 'eps', title: 'Split-normalized EPS', color: '#d946cf' },
  { key: 'pretaxProfit', title: 'Pre-tax profit', color: '#2874d0' },
  { key: 'close', title: 'Split-normalized price', color: '#64748b' },
];
const timestamp = (value: string) => Date.parse(`${value}T00:00:00Z`);
const chartDate = (value: number) => displayDate(new Date(value).toISOString().slice(0, 10));

function OverlayChart({ annual, study }: { annual: AnnualRow[]; study: Study }) {
  const [hidden, setHidden] = useState<ChartLineId[]>([]);
  const [selected, setSelected] = useState<ChartLineId | null>(null);
  const financials: ChartPoint[] = annual.map(row => ({ timestamp: timestamp(row.periodEnd), sales: row.sales, eps: row.eps, pretaxProfit: row.pretaxProfit }));
  const prices: ChartPoint[] = study.prices.map(point => ({ timestamp: timestamp(point.date), close: point.close }));
  const points = new Map<number, ChartPoint>();
  for (const point of [...financials, ...prices]) points.set(point.timestamp, { ...points.get(point.timestamp), ...point });
  const timeline = [...points.values()].sort((a, b) => a.timestamp - b.timestamp);
  const series = chartSeries.map(metric => {
    const source = (metric.key === 'close' ? prices : financials).slice().sort((a, b) => a.timestamp - b.timestamp);
    const baseline = source.find(point => point[metric.key] != null && point[metric.key] !== 0)?.[metric.key];
    const data = source.map(point => ({ timestamp: point.timestamp, [metric.key]: point[metric.key] == null ? null : baseline == null ? (point[metric.key] === 0 ? 0 : null) : point[metric.key]! / Math.abs(baseline) * 100 }));
    const regression = metric.key === 'close' ? null : logLinearRegression(data.map(point => ({ periodEnd: new Date(point.timestamp).toISOString().slice(0, 10), value: point[metric.key] ?? null })));
    const regressionData: ChartPoint[] = regression?.fitted.map(point => ({ timestamp: timestamp(point.periodEnd), [metric.key]: point.value })) ?? [];
    const latest = source.filter(point => point[metric.key] != null).at(-1);
    return { ...metric, data, rawData: source, regressionRaw: regressionData.map(point => ({ timestamp: point.timestamp, [metric.key]: point[metric.key]! * Math.abs(baseline!) / 100 })), regressionData, regressionRate: regression?.growthRate ?? null, latest, baselineDate: source.find(point => point[metric.key] != null && point[metric.key] !== 0)?.timestamp };
  });
  const lines = series.flatMap(metric => {
    const actual = metric.rawData.filter(point => point[metric.key] != null).map(point => ({ timestamp: point.timestamp, value: point[metric.key]! }));
    const fit = metric.regressionRaw.map(point => ({ timestamp: point.timestamp, value: point[metric.key]! }));
    return [
      ...(actual.length ? [{ id: `${metric.key}:actual` as ChartLineId, key: metric.key, name: `${metric.title} · Actual`, color: metric.color, kind: 'actual' as const, observations: actual }] : []),
      ...(fit.length ? [{ id: `${metric.key}:fit` as ChartLineId, key: metric.key, name: `${metric.title} · Regression`, color: metric.color, kind: 'fit' as const, observations: fit }] : []),
    ];
  });
  const visibleLines = lines.filter(line => !hidden.includes(line.id));
  const visible = series.filter(metric => visibleLines.some(line => line.key === metric.key));
  const selectedLine = lines.find(line => line.id === selected);
  const lineVisible = (id: ChartLineId) => lines.some(line => line.id === id) && !hidden.includes(id);
  const lineOpacity = (id: ChartLineId, normal = 1) => selectedLine && selectedLine.id !== id ? 0.12 : normal;
  function inspectLine(id: ChartLineId | null) {
    setSelected(id);
    if (id) setHidden(current => current.filter(item => item !== id));
  }
  function toggleLine(id: ChartLineId) {
    setHidden(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
    if (selected === id) setSelected(null);
  }
  const values = visible.flatMap(metric => metric.data.map(point => point[metric.key] ?? null));
  const hasData = values.some(value => value !== null);
  const firstYear = timeline.length ? new Date(timeline[0].timestamp).getUTCFullYear() : new Date().getFullYear();
  const lastYear = timeline.length ? new Date(timeline.at(-1)!.timestamp).getUTCFullYear() : firstYear;
  const yearTicks = Array.from({ length: lastYear - firstYear + 1 }, (_, index) => Date.UTC(firstYear + index, 0, 1));
  const usesSymlog = values.some(value => value !== null && value <= 0);
  // Apply logarithms before positioning each series in its vertical band. Bands
  // overlap to give rises and dips substantial vertical range in one chart.
  const bandHeight = 3.4;
  const spaced = series.map((metric, index) => {
    const available = metric.data.map(point => point[metric.key]).filter((value): value is number => value != null);
    if (!available.length) return metric;
    const signed = available.some(value => value <= 0);
    const log = (value: number) => signed ? Math.sign(value) * Math.log1p(Math.abs(value)) : Math.log(value);
    const logged = [...available, ...metric.regressionData.map(point => point[metric.key]!)].map(log);
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
  const isolatedPoints = visible.length === 1 ? spaced.filter(metric => metric.key === visible[0].key).flatMap(metric => [
    ...(lineVisible(`${metric.key}:actual`) ? metric.data : []),
    ...(metric.key !== 'close' && lineVisible(`${metric.key}:fit`) ? metric.regressionData : []),
  ].map(point => point[metric.key]).filter((value): value is number => value != null)) : [];
  const domain: [number, number] = isolatedPoints.length ? [Math.min(...isolatedPoints) - 0.2, Math.max(...isolatedPoints) + 0.2] : [0, series.length - 1 + bandHeight + 0.3];
  const axisNames: Record<ChartKey, string> = { sales: 'Sales', eps: 'EPS', pretaxProfit: 'Pre-tax profit', close: 'Stock price' };
  const axisLabels = spaced.filter(metric => visibleLines.some(line => line.key === metric.key)).flatMap(metric => {
    const first = metric.data.find(point => point[metric.key] != null);
    return first ? [{ value: first[metric.key]!, name: axisNames[metric.key], color: metric.color }] : [];
  });
  return <section className="chart-card overlay-chart" aria-label="Combined historical chart">
    <div className="chart-heading overlay-heading"><div><span className="chart-eyebrow">THE LONG VIEW</span><h2>Growth & market performance</h2><p>Sales, earnings and price on one timeline.</p></div><div className="chart-controls"><span className="chart-period">{firstYear} — {lastYear}</span></div></div>
    <div className="chart-series-legend" aria-label="Individual line visibility">{series.map(metric => <div key={metric.key} className={`chart-series-item${visibleLines.some(line => line.key === metric.key) ? '' : ' is-hidden'}`}>
      <span><i style={{ background: metric.color }}/>{metric.title}</span>
      <strong>{money(metric.latest?.[metric.key] ?? null, metric.key === 'close' ? study.priceCurrency : study.financialCurrency, metric.key === 'eps' || metric.key === 'close')}</strong>
      <small>{metric.latest ? `As of ${chartDate(metric.latest.timestamp)}` : 'Unavailable'}</small>
      {metric.key !== 'close' && <small>{metric.regressionRate === null ? 'Log-linear fit unavailable' : `${metric.regressionRate.toFixed(1)}%/yr · log-linear fit`}</small>}
      <div className="line-toggles">{lines.filter(line => line.key === metric.key).map(line => <button key={line.id} aria-label={`Show ${line.name}`} aria-pressed={!hidden.includes(line.id)} onClick={() => toggleLine(line.id)}><i style={{ background: metric.color, opacity: line.kind === 'fit' ? 0.4 : 1 }}/>{line.kind === 'fit' ? 'Regression' : 'Actual'}</button>)}</div>
    </div>)}</div>
    <div className="line-inspector-controls">
      <label>Inspect line <select aria-label="Inspect a chart line" value={selectedLine?.id ?? ''} onChange={event => inspectLine(event.target.value ? event.target.value as ChartLineId : null)}><option value="">All visible lines</option>{lines.map(line => <option key={line.id} value={line.id}>{line.name}</option>)}</select></label>
      <button disabled={!selectedLine} onClick={() => { if (selectedLine) setHidden(lines.filter(line => line.id !== selectedLine.id).map(line => line.id)); }}>Show only this line</button>
      <button onClick={() => { setHidden([]); setSelected(null); }}>Show all</button>
    </div>
    <div className="line-inspector-status" role="status">{selectedLine ? <><i style={{ background: selectedLine.color }}/><strong>{selectedLine.name}</strong><span>{chartDate(selectedLine.observations[0].timestamp)} – {chartDate(selectedLine.observations.at(-1)!.timestamp)} · Hover to inspect {selectedLine.kind === 'fit' ? 'fitted' : 'actual'} values</span></> : 'Click a line or choose one above to inspect it. Toggle Actual and Regression independently.'}</div>
    <div className="plot-meta"><span>TREND COMPARISON</span><span>Logarithmic scales{usesSymlog ? ' · Symmetric log for zero or losses' : ''}</span></div>
    {hasData ? <div className="chart-canvas overlay-canvas"><ResponsiveContainer width="100%" height="100%"><LineChart data={timeline} margin={{ top: 24, right: 24, bottom: 12, left: 0 }} accessibilityLayer>
      <CartesianGrid vertical horizontal stroke="#e8edf0" syncWithTicks/>
      <XAxis dataKey="timestamp" type="number" scale="time" domain={[Date.UTC(firstYear, 0, 1), Date.UTC(lastYear, 11, 31)]} ticks={yearTicks} tickFormatter={value => String(new Date(Number(value)).getUTCFullYear())} tick={{ fontSize: 12, fill: '#7c8793', fontWeight: 500 }} tickLine={false} axisLine={false} minTickGap={30} dy={12}/>
      <YAxis domain={domain} type="number" scale="linear" width={84} ticks={axisLabels.map(label => label.value)} interval={0} axisLine={{ stroke: '#e1e7e4' }} tickLine={{ stroke: '#d3ddd6' }} allowDataOverflow tick={({ x, y, payload }) => {
        const label = axisLabels.find(item => item.value === Number(payload.value));
        return <text x={Number(x) - 7} y={Number(y)} dy={4} textAnchor="end" fill={label?.color} fontSize={10} fontWeight={500}>{label?.name}</text>;
      }}/>
      <Tooltip cursor={{ stroke: '#9ba9b5', strokeWidth: 1, strokeDasharray: '3 4' }} content={({ active, label }) => {
        if (!active || label == null) return null;
        const time = Number(label);
        const inspected = selectedLine ? [selectedLine] : visibleLines;
        const details = inspected.flatMap(line => {
          const point = line.kind === 'fit' ? fittedObservation(line.observations, time) : selectedLine ? nearestObservation(line.observations, time) : line.observations.find(point => point.timestamp === time);
          return point ? [{ line, point }] : [];
        });
        if (!details.length) return selectedLine ? <div className="overlay-tooltip"><strong>{chartDate(time)}</strong><span>Outside this regression’s historical range.</span></div> : null;
        return <div className="overlay-tooltip"><strong>{chartDate(time)}</strong>{details.map(({ line, point }) => <div key={line.id} style={{ color: line.color }}><span>{line.name}{point.timestamp !== time && <small className="tooltip-observed-date">Observed {chartDate(point.timestamp)}</small>}</span><b>{money(point.value, line.key === 'close' ? study.priceCurrency : study.financialCurrency, line.key === 'eps' || line.key === 'close')}</b></div>)}</div>;
      }}/>
      {spaced.filter(metric => metric.key !== 'close' && lineVisible(`${metric.key}:fit`)).map(metric => <Line key={`${metric.key}-regression`} data={metric.regressionData} type="linear" dataKey={metric.key} name={`${metric.title} log-linear fit`} stroke={metric.color} strokeWidth={selected === `${metric.key}:fit` ? 3 : 2} strokeOpacity={lineOpacity(`${metric.key}:fit` as ChartLineId, selected === `${metric.key}:fit` ? 0.65 : 0.4)} dot={false} activeDot={false} tooltipType="none" legendType="none" isAnimationActive={false} style={{ cursor: 'pointer' }} onClick={() => inspectLine(`${metric.key}:fit` as ChartLineId)}/>)}
      {spaced.filter(metric => lineVisible(`${metric.key}:actual`)).map(metric => <Line key={metric.key} data={metric.data} type="linear" dataKey={metric.key} name={metric.title} stroke={metric.color} strokeWidth={selected === `${metric.key}:actual` ? 3.5 : metric.key === 'close' ? 1.6 : 3} strokeOpacity={lineOpacity(`${metric.key}:actual`, metric.key === 'close' ? 0.65 : 1)} dot={metric.key === 'close' ? false : { r: 5, fill: '#fff', strokeWidth: 2.5, stroke: metric.color, opacity: lineOpacity(`${metric.key}:actual`) }} activeDot={{ r: 7, fill: metric.color, stroke: '#fff', strokeWidth: 3 }} connectNulls={false} isAnimationActive={false} style={{ cursor: 'pointer' }} onClick={() => inspectLine(`${metric.key}:actual`)}/>)}
    </LineChart></ResponsiveContainer></div> : <div className="chart-empty">{lines.length ? 'All lines are hidden. Choose Show all to restore the chart.' : 'No comparable history is available. Refresh to try again.'}</div>}
    <div className="chart-footnote"><span className="split-status"><i/>Split-normalized EPS & price</span><span>Translucent lines: log-linear regression · Annual financials · Daily closing prices</span></div>
    <p className="overlay-note">Each line has its own logarithmic scale and vertical offset to make its trend clear. Compare direction and shape; slopes do not compare growth rates. Hover for actual values. Missing annual values remain gaps.</p>
    <div className="chart-baselines">{series.filter(metric => metric.baselineDate != null).map(metric => <span key={metric.key}>{metric.title}: base {chartDate(metric.baselineDate!)}</span>)}</div>
  </section>;
}

function FinancialTable({ annual, study }: { annual: AnnualRow[]; study: Study }) {
  const [forecasts, setForecasts] = useState({ sales: '', eps: '' });
  const rows = [...annual].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  const currency = study.financialCurrency === 'USD' ? '$' : study.financialCurrency || 'Currency unavailable';
  const labels: Record<Metric, string> = {
    sales: `Historical sales (${currency}M)`,
    eps: `Historical EPS (${currency})`,
    pretaxProfit: `Pre-tax profit (${currency}M)`,
  };
  return <section className="financial-table-section fundamentals" aria-labelledby="financial-table-title">
    <div className="fundamentals-title"><h2 id="financial-table-title">Fundamental Company Data</h2><span>Annual financials</span></div>
    <div className="financial-table-scroll"><table>
      <caption className="sr-only">Annual company data by fiscal year, historical annualized growth, forecast assumptions, and five-year estimates. EPS is split-normalized.</caption>
      <thead><tr><th scope="col"><span className="sr-only">Metric</span></th>{rows.map(row => <th scope="col" key={row.periodEnd} title={`Fiscal year ended ${displayDate(row.periodEnd)}`}>{row.periodEnd.slice(0, 4)}</th>)}<th scope="col" className="calculated-column">Growth (%)</th><th scope="col">Forecast (%)</th><th scope="col">5 Yr Est</th></tr></thead>
      <tbody>{metrics.map(metric => {
        const scale = metric.key === 'eps' ? 1 : 1_000_000;
        const supported = rows.filter(row => row[metric.key] !== null);
        const first = supported[0];
        const latest = supported.at(-1);
        const growth = study.growthRates ? study.growthRates[metric.key] : annualGrowth(rows.map(row => ({ periodEnd: row.periodEnd, value: row[metric.key] })));
        const forecastKey = metric.key === 'sales' || metric.key === 'eps' ? metric.key : null;
        const estimate = forecastKey ? fiveYearEstimate(latest?.[metric.key] ?? null, forecasts[forecastKey]) : null;
        return <tr key={metric.key}>
          <th scope="row">{labels[metric.key]}</th>
          {rows.map(row => <td key={row.periodEnd}><SourceLink source={row[`${metric.key}Source`]} cik={study.company.cik} value={row[metric.key] === null ? null : row[metric.key]! / scale} currency={null} eps={metric.key === 'eps'}/></td>)}
          <td className="calculated-column" title={first && latest ? `Log-linear regression across available fiscal years: ${displayDate(first.periodEnd)} to ${displayDate(latest.periodEnd)}` : undefined}>{growth === null ? '—' : `${growth.toFixed(1)}%`}</td>
          <td className="forecast-cell">{forecastKey ? <input type="number" step="0.1" min="-100" value={forecasts[forecastKey]} placeholder="—" aria-label={`${metric.title} annual forecast percentage`} onChange={event => setForecasts(current => ({ ...current, [forecastKey]: event.target.value }))}/> : '—'}</td>
          <td className="estimate-cell">{money(estimate === null ? null : estimate / scale, null, metric.key === 'eps')}</td>
        </tr>;
      })}</tbody>
    </table>{!rows.length && <p className="table-empty">Annual financials could not be loaded for this company.</p>}</div>
    <p className="table-note">Sales and pre-tax profit are in millions; EPS is split-normalized. Click historical values for SEC filings. Growth uses log-linear regression across all available fiscal years. It requires at least two years of positive values; missing years are skipped and zero or negative values make growth unavailable. Enter annual sales and EPS forecasts to calculate five-year estimates from each metric’s latest available year. Forecasts are your assumptions. — means unavailable.</p>
  </section>;
}

export default function StudyPage({ study, onBack, onRefresh }: { study: Study; onBack: () => void; onRefresh: () => void }) {
  useEffect(() => {
    document.title = `${study.company.ticker} · Stock Study`;
    return () => { document.title = 'Stock Search'; };
  }, [study.company.ticker]);
  const normalized = study.epsAdjustment?.status === 'normalized';
  const annual = study.annual.map(row => ({
    ...row,
    eps: normalized && row.epsSplitFactor != null && Number.isFinite(row.epsSplitFactor) && row.epsSplitFactor > 0 ? row.eps : null,
  }));
  const errors = Object.values(study.sources).map(source => source.error).filter(Boolean);
  return <main className="study-page">
    <div className="study-nav"><button className="back-button" onClick={onBack}>← Company search</button><span>Stock study</span></div>
    <header className="study-header"><div><div className="ticker-label">{study.company.ticker}<span>·</span>{study.company.exchange || 'Exchange unavailable'}</div><h1>{study.company.name}</h1><p>A decade of business performance and stock price history.</p></div><div className="study-header-actions"><a className="export-button" href={`/api/studies/${study.id}`} download={`${study.company.ticker}-study.json`}>Export JSON ↓</a><button className="primary-button" onClick={onRefresh}>↻ Refresh study</button></div></header>
    <div className="study-meta"><span>Created {new Date(study.createdAt).toLocaleString()}</span><span>{study.annual.length} reported fiscal years</span><span>Fresh SEC + yfinance requests on creation</span></div>
    {(errors.length > 0 || study.warnings.length > 0) && <aside className="data-notice" aria-label="Data availability"><strong>Data availability</strong><ul>{[...errors, ...study.warnings].map((warning, i) => <li key={i}>{warning}</li>)}</ul>{errors.length > 0 && <button className="text-button" onClick={onRefresh}>Retry both sources</button>}</aside>}
    {!study.epsAdjustment && <aside className="data-notice">Split-normalized EPS is unavailable in this saved study. <button className="text-button" onClick={onRefresh}>Refresh study to normalize EPS</button>.</aside>}
    <OverlayChart annual={annual} study={study}/>
    <FinancialTable key={study.id} annual={annual} study={study}/>
    <footer className="study-footer"><div><strong>Sources</strong><a href={study.sources.sec.url} target="_blank" rel="noreferrer">SEC Company Facts ↗</a><span>{study.sources.sec.retrievedAt ? `Retrieved ${new Date(study.sources.sec.retrievedAt).toLocaleString()}` : 'Unavailable'}</span></div><div><strong>Price history</strong><a href={study.sources.yfinance.url} target="_blank" rel="noreferrer">Yahoo Finance via yfinance ↗</a><span>{study.sources.yfinance.retrievedAt ? `Retrieved ${new Date(study.sources.yfinance.retrievedAt).toLocaleString()}` : 'Unavailable'}</span></div><p>Financials cover the latest ten available full fiscal years. Prices cover the trailing decade where available and use Yahoo’s split-adjusted close, without dividend adjustment. Refresh creates a new study snapshot.</p></footer>
  </main>;
}
