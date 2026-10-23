import { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnnualRow, FactSource, Metric, Study } from './types';

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
  const [hidden, setHidden] = useState<ChartKey[]>([]);
  const financials: ChartPoint[] = annual.map(row => ({ timestamp: timestamp(row.periodEnd), sales: row.sales, eps: row.eps, pretaxProfit: row.pretaxProfit }));
  const prices: ChartPoint[] = study.prices.map(point => ({ timestamp: timestamp(point.date), close: point.close }));
  const points = new Map<number, ChartPoint>();
  for (const point of [...financials, ...prices]) points.set(point.timestamp, { ...points.get(point.timestamp), ...point });
  const timeline = [...points.values()].sort((a, b) => a.timestamp - b.timestamp);
  const series = chartSeries.map(metric => {
    const source = (metric.key === 'close' ? prices : financials).slice().sort((a, b) => a.timestamp - b.timestamp);
    const baseline = source.find(point => point[metric.key] != null && point[metric.key] !== 0)?.[metric.key];
    const data = source.map(point => ({ timestamp: point.timestamp, [metric.key]: baseline == null || point[metric.key] == null ? null : point[metric.key]! / Math.abs(baseline) * 100 }));
    const latest = source.filter(point => point[metric.key] != null).at(-1);
    return { ...metric, data, latest, baselineDate: source.find(point => point[metric.key] != null && point[metric.key] !== 0)?.timestamp };
  });
  const visible = series.filter(metric => !hidden.includes(metric.key));
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
    };
  });
  const domain: [number, number] = [0, series.length - 1 + bandHeight + 0.3];
  function toggleSeries(key: ChartKey) {
    setHidden(current => current.includes(key) ? current.filter(item => item !== key) : current.length < chartSeries.length - 1 ? [...current, key] : current);
  }
  return <section className="chart-card overlay-chart" aria-label="Combined historical chart">
    <div className="chart-heading overlay-heading"><div><span className="chart-eyebrow">THE LONG VIEW</span><h2>Growth & market performance</h2><p>Sales, earnings and price on one timeline.</p></div><div className="chart-controls"><span className="chart-period">{firstYear} — {lastYear}</span></div></div>
    <div className="chart-series-legend" aria-label="Toggle chart series">{series.map(metric => <button key={metric.key} className={`chart-series-item${hidden.includes(metric.key) ? ' is-hidden' : ''}`} aria-pressed={!hidden.includes(metric.key)} onClick={() => toggleSeries(metric.key)}>
      <span><i style={{ background: metric.color }}/>{metric.title}<span className="series-check">{hidden.includes(metric.key) ? '+' : '✓'}</span></span>
      <strong>{money(metric.latest?.[metric.key] ?? null, metric.key === 'close' ? study.priceCurrency : study.financialCurrency, metric.key === 'eps' || metric.key === 'close')}</strong>
      <small>{metric.latest ? `As of ${chartDate(metric.latest.timestamp)}` : 'Unavailable'}</small>
    </button>)}</div>
    <div className="plot-meta"><span>TREND COMPARISON</span><span>Logarithmic scales{usesSymlog ? ' · Symmetric log for zero or losses' : ''}</span></div>
    {hasData ? <div className="chart-canvas overlay-canvas"><ResponsiveContainer width="100%" height="100%"><LineChart data={timeline} margin={{ top: 24, right: 24, bottom: 12, left: 0 }} accessibilityLayer>
      <CartesianGrid vertical horizontal={false} stroke="#e8edf0" syncWithTicks/>
      <XAxis dataKey="timestamp" type="number" scale="time" domain={[Date.UTC(firstYear, 0, 1), Date.UTC(lastYear, 11, 31)]} ticks={yearTicks} tickFormatter={value => String(new Date(Number(value)).getUTCFullYear())} tick={{ fontSize: 12, fill: '#7c8793', fontWeight: 500 }} tickLine={false} axisLine={false} minTickGap={30} dy={12}/>
      <YAxis hide domain={domain} type="number" scale="linear" allowDataOverflow/>
      <Tooltip cursor={{ stroke: '#9ba9b5', strokeWidth: 1, strokeDasharray: '3 4' }} content={({ active, label }) => {
        const point = points.get(Number(label));
        if (!active || !point) return null;
        return <div className="overlay-tooltip"><strong>{chartDate(point.timestamp)}</strong>{visible.filter(metric => point[metric.key] != null).map(metric => <div key={metric.key} style={{ color: metric.color }}><span>{metric.title}</span><b>{money(point[metric.key]!, metric.key === 'close' ? study.priceCurrency : study.financialCurrency, metric.key === 'eps' || metric.key === 'close')}</b></div>)}</div>;
      }}/>
      {spaced.filter(metric => !hidden.includes(metric.key)).map(metric => <Line key={metric.key} data={metric.data} type="linear" dataKey={metric.key} name={metric.title} stroke={metric.color} strokeWidth={metric.key === 'close' ? 1.6 : 3} strokeOpacity={metric.key === 'close' ? 0.65 : 1} dot={metric.key === 'close' ? false : { r: 5, fill: '#fff', strokeWidth: 2.5, stroke: metric.color }} activeDot={{ r: 7, fill: metric.color, stroke: '#fff', strokeWidth: 3 }} connectNulls={false} isAnimationActive={false}/>)}
    </LineChart></ResponsiveContainer></div> : <div className="chart-empty">No comparable history is available. Refresh to try again.</div>}
    <div className="chart-footnote"><span className="split-status"><i/>Split-normalized EPS & price</span><span>Annual financials · Daily closing prices</span></div>
    <p className="overlay-note">Each line has its own logarithmic scale and vertical offset to make its trend clear. Compare direction and shape; slopes do not compare growth rates. Hover for actual values. Missing annual values remain gaps.</p>
    <div className="chart-baselines">{series.filter(metric => metric.baselineDate != null).map(metric => <span key={metric.key}>{metric.title}: base {chartDate(metric.baselineDate!)}</span>)}</div>
  </section>;
}

export default function StudyPage({ study, onBack, onRefresh }: { study: Study; onBack: () => void; onRefresh: () => void }) {
  const [descending, setDescending] = useState(true);
  useEffect(() => {
    document.title = `${study.company.ticker} · Stock Study`;
    return () => { document.title = 'Stock Search'; };
  }, [study.company.ticker]);
  const normalized = study.epsAdjustment?.status === 'normalized';
  const annual = study.annual.map(row => ({
    ...row,
    eps: normalized && row.epsSplitFactor != null && Number.isFinite(row.epsSplitFactor) && row.epsSplitFactor > 0 ? row.eps : null,
  }));
  const rows = descending ? [...annual].reverse() : annual;
  const errors = Object.values(study.sources).map(source => source.error).filter(Boolean);
  return <main className="study-page">
    <div className="study-nav"><button className="back-button" onClick={onBack}>← Company search</button><span>Stock study</span></div>
    <header className="study-header"><div><div className="ticker-label">{study.company.ticker}<span>·</span>{study.company.exchange || 'Exchange unavailable'}</div><h1>{study.company.name}</h1><p>A decade of business performance and stock price history.</p></div><button className="primary-button" onClick={onRefresh}>↻ Refresh study</button></header>
    <div className="study-meta"><span>Created {new Date(study.createdAt).toLocaleString()}</span><span>{study.annual.length} reported fiscal years</span><span>Fresh SEC + yfinance requests on creation</span></div>
    {(errors.length > 0 || study.warnings.length > 0) && <aside className="data-notice" aria-label="Data availability"><strong>Data availability</strong><ul>{[...errors, ...study.warnings].map((warning, i) => <li key={i}>{warning}</li>)}</ul>{errors.length > 0 && <button className="text-button" onClick={onRefresh}>Retry both sources</button>}</aside>}
    {!study.epsAdjustment && <aside className="data-notice">Split-normalized EPS is unavailable in this saved study. <button className="text-button" onClick={onRefresh}>Refresh study to normalize EPS</button>.</aside>}
    <OverlayChart annual={annual} study={study}/>
    <section className="financial-table-section" aria-labelledby="financial-table-title"><div className="table-heading"><div><h2 id="financial-table-title">Annual financials</h2><p>Full fiscal years · {study.financialCurrency || 'Reporting currency unavailable'} · Click a value to view its SEC filing</p></div><button className="sort-button" onClick={() => setDescending(!descending)}>{descending ? 'Newest first ↓' : 'Oldest first ↑'}</button></div><div className="financial-table-scroll"><table><caption className="sr-only">Historic sales, split-normalized diluted earnings per share, and pre-tax profit from SEC filings.</caption><thead><tr><th scope="col">Year ended</th><th scope="col">Sales</th><th scope="col">Split-normalized EPS</th><th scope="col">Pre-tax profit</th></tr></thead><tbody>{rows.map(row => <tr key={row.periodEnd}><th scope="row">{displayDate(row.periodEnd)}</th>{metrics.map(metric => <td key={metric.key}><SourceLink source={row[`${metric.key}Source`]} cik={study.company.cik} value={row[metric.key]} currency={study.financialCurrency} eps={metric.key === 'eps'}/></td>)}</tr>)}</tbody></table>{!rows.length && <p className="table-empty">Annual financials could not be loaded for this company.</p>}</div><p className="table-note">— means unavailable. Figures use the latest available filing for each supported SEC concept. {normalized ? `EPS is split-normalized through ${study.epsAdjustment?.asOf}. Each source filing is treated as already reflecting splits through its filing date; only later splits are applied.` : 'Only split-normalized EPS is displayed. Refresh to retry unavailable values.'} Sales and pre-tax profit are company totals unaffected by stock splits. Pre-tax profit refers to continuing operations where reported.</p></section>
    <footer className="study-footer"><div><strong>Sources</strong><a href={study.sources.sec.url} target="_blank" rel="noreferrer">SEC Company Facts ↗</a><span>{study.sources.sec.retrievedAt ? `Retrieved ${new Date(study.sources.sec.retrievedAt).toLocaleString()}` : 'Unavailable'}</span></div><div><strong>Price history</strong><a href={study.sources.yfinance.url} target="_blank" rel="noreferrer">Yahoo Finance via yfinance ↗</a><span>{study.sources.yfinance.retrievedAt ? `Retrieved ${new Date(study.sources.yfinance.retrievedAt).toLocaleString()}` : 'Unavailable'}</span></div><p>Financials cover the latest ten available full fiscal years. Prices cover the trailing decade where available and use Yahoo’s split-adjusted close, without dividend adjustment. Refresh creates a new study snapshot.</p></footer>
  </main>;
}
