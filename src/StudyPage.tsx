import { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnnualRow, FactSource, Metric, Study } from './types';

const metrics: { key: Metric; title: string; color: string; note: string }[] = [
  { key: 'sales', title: 'Sales', color: '#2563eb', note: 'Annual revenue' },
  { key: 'eps', title: 'Earnings per share', color: '#7c3aed', note: 'Diluted EPS' },
  { key: 'pretaxProfit', title: 'Pre-tax profit', color: '#0d9488', note: 'Annual income before tax' },
];

function logarithmicAxis(values: (number | null)[]): { scale: 'log' | 'symlog'; domain: [number, number] } {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (!finite.length) return { scale: 'log', domain: [1, 10] };
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min > 0) return { scale: 'log', domain: [min / 1.08, max * 1.08] };
  // Symmetric log keeps losses and zero visible, which a standard log cannot represent.
  const padding = (max - min || Math.abs(max) || 1) * 0.08;
  return { scale: 'symlog', domain: [min - padding, max + padding] };
}

function compact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
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

function FinancialChart({ rows, metric, currency }: { rows: AnnualRow[]; metric: typeof metrics[number]; currency: string | null }) {
  const valid = rows.filter(row => row[metric.key] !== null);
  const latest = valid.at(-1);
  const axis = logarithmicAxis(rows.map(row => row[metric.key]));
  return <article className="chart-card">
    <div className="chart-heading"><div><h2><i style={{ background: metric.color }}/>{metric.title}</h2><p>{metric.key === 'eps' ? 'Split-normalized diluted EPS' : metric.note} · {currency || 'Currency unavailable'}{metric.key === 'eps' ? '/share' : ''} · {axis.scale === 'log' ? 'Log scale' : 'Symmetric log scale'}</p></div><div className="metric-latest"><strong>{latest ? (metric.key === 'eps' ? latest[metric.key]?.toFixed(2) : compact(latest[metric.key]!)) : '—'}</strong>{latest && <small>Year ended {displayDate(latest.periodEnd)}</small>}</div></div>
    {valid.length ? <div className="chart-canvas"><ResponsiveContainer width="100%" height="100%"><LineChart data={rows} margin={{ top: 12, right: 18, bottom: 2, left: 0 }} accessibilityLayer>
      <CartesianGrid vertical={false} stroke="#edf0f4"/>
      <XAxis dataKey="periodEnd" tickFormatter={value => String(value).slice(0, 4)} tick={{ fontSize: 11, fill: '#8993a0' }} tickLine={false} axisLine={false} minTickGap={24} dy={8}/>
      <YAxis tickFormatter={value => metric.key === 'eps' ? String(value) : compact(Number(value))} tick={{ fontSize: 10, fill: '#8993a0' }} tickLine={false} axisLine={false} width={58} scale={axis.scale} domain={axis.domain} allowDataOverflow/>
      {axis.scale === 'symlog' && <ReferenceLine y={0} stroke="#cfd6df"/>}
      <Tooltip labelFormatter={value => `Year ended ${displayDate(String(value))}`} formatter={value => [money(Number(value), currency, metric.key === 'eps'), metric.title]} contentStyle={{ borderRadius: 8, borderColor: '#e5e9ef', fontSize: 12 }}/>
      <Line type="linear" dataKey={metric.key} stroke={metric.color} strokeWidth={2.5} dot={{ r: 3, fill: metric.color, strokeWidth: 2, stroke: '#fff' }} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false}/>
    </LineChart></ResponsiveContainer></div> : <div className="chart-empty">No supported annual {metric.title.toLowerCase()} data available.</div>}
  </article>;
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
  const prices = study.prices;
  const priceAxis = logarithmicAxis(prices.map(point => point.close));
  const errors = Object.values(study.sources).map(source => source.error).filter(Boolean);
  return <main className="study-page">
    <div className="study-nav"><button className="back-button" onClick={onBack}>← Company search</button><span>Stock study</span></div>
    <header className="study-header"><div><div className="ticker-label">{study.company.ticker}<span>·</span>{study.company.exchange || 'Exchange unavailable'}</div><h1>{study.company.name}</h1><p>A decade of business performance and stock price history.</p></div><button className="primary-button" onClick={onRefresh}>↻ Refresh study</button></header>
    <div className="study-meta"><span>Created {new Date(study.createdAt).toLocaleString()}</span><span>{study.annual.length} reported fiscal years</span><span>Fresh SEC + yfinance requests on creation</span></div>
    {(errors.length > 0 || study.warnings.length > 0) && <aside className="data-notice" aria-label="Data availability"><strong>Data availability</strong><ul>{[...errors, ...study.warnings].map((warning, i) => <li key={i}>{warning}</li>)}</ul>{errors.length > 0 && <button className="text-button" onClick={onRefresh}>Retry both sources</button>}</aside>}
    {!study.epsAdjustment && <aside className="data-notice">Split-normalized EPS is unavailable in this saved study. <button className="text-button" onClick={onRefresh}>Refresh study to normalize EPS</button>.</aside>}
    <section className="study-charts" aria-label="Historical charts">
      {metrics.map(metric => <FinancialChart key={metric.key} rows={annual} metric={metric} currency={study.financialCurrency}/>)}
      <article className="chart-card"><div className="chart-heading"><div><h2><i style={{background: '#334155'}}/>Stock price</h2><p>Split-normalized daily close · {study.priceCurrency || 'Currency unavailable'} · yfinance · {priceAxis.scale === 'log' ? 'Log scale' : 'Symmetric log scale'}</p></div><div className="metric-latest"><strong>{prices.length ? prices.at(-1)!.close.toFixed(2) : '—'}</strong>{prices.length > 0 && <small>{displayDate(prices.at(-1)!.date)}</small>}</div></div>
      {prices.length ? <><div className="chart-canvas"><ResponsiveContainer width="100%" height="100%"><LineChart data={prices} margin={{ top: 12, right: 18, bottom: 2, left: 0 }} accessibilityLayer><CartesianGrid vertical={false} stroke="#edf0f4"/><XAxis dataKey="date" tickFormatter={value => String(value).slice(0, 4)} ticks={prices.filter((point, index) => index === 0 || point.date.slice(0, 4) !== prices[index - 1].date.slice(0, 4)).map(point => point.date)} minTickGap={24} tick={{fontSize: 11, fill: '#8993a0'}} tickLine={false} axisLine={false} dy={8}/><YAxis tickFormatter={compact} tick={{fontSize:10, fill: '#8993a0'}} width={58} tickLine={false} axisLine={false} scale={priceAxis.scale} domain={priceAxis.domain} allowDataOverflow/><Tooltip labelFormatter={value => displayDate(String(value))} formatter={value => [money(Number(value), study.priceCurrency, true), 'Close']} contentStyle={{borderRadius:8, borderColor:'#e5e9ef', fontSize:12}}/><Line type="linear" dataKey="close" stroke="#334155" strokeWidth={1.8} dot={false} isAnimationActive={false}/></LineChart></ResponsiveContainer></div><div className="price-range">{displayDate(prices[0].date)} – {displayDate(prices.at(-1)!.date)} · {prices.length.toLocaleString()} trading days</div></> : <div className="chart-empty">Stock price history is unavailable. Refresh to try again.</div>}
      </article>
    </section>
    <section className="financial-table-section" aria-labelledby="financial-table-title"><div className="table-heading"><div><h2 id="financial-table-title">Annual financials</h2><p>Full fiscal years · {study.financialCurrency || 'Reporting currency unavailable'} · Click a value to view its SEC filing</p></div><button className="sort-button" onClick={() => setDescending(!descending)}>{descending ? 'Newest first ↓' : 'Oldest first ↑'}</button></div><div className="financial-table-scroll"><table><caption className="sr-only">Historic sales, split-normalized diluted earnings per share, and pre-tax profit from SEC filings.</caption><thead><tr><th scope="col">Year ended</th><th scope="col">Sales</th><th scope="col">Split-normalized EPS</th><th scope="col">Pre-tax profit</th></tr></thead><tbody>{rows.map(row => <tr key={row.periodEnd}><th scope="row">{displayDate(row.periodEnd)}</th>{metrics.map(metric => <td key={metric.key}><SourceLink source={row[`${metric.key}Source`]} cik={study.company.cik} value={row[metric.key]} currency={study.financialCurrency} eps={metric.key === 'eps'}/></td>)}</tr>)}</tbody></table>{!rows.length && <p className="table-empty">Annual financials could not be loaded for this company.</p>}</div><p className="table-note">— means unavailable. Figures use the latest available filing for each supported SEC concept. {normalized ? `EPS is split-normalized through ${study.epsAdjustment?.asOf}. Each source filing is treated as already reflecting splits through its filing date; only later splits are applied.` : 'Only split-normalized EPS is displayed. Refresh to retry unavailable values.'} Sales and pre-tax profit are company totals unaffected by stock splits. Pre-tax profit refers to continuing operations where reported.</p></section>
    <footer className="study-footer"><div><strong>Sources</strong><a href={study.sources.sec.url} target="_blank" rel="noreferrer">SEC Company Facts ↗</a><span>{study.sources.sec.retrievedAt ? `Retrieved ${new Date(study.sources.sec.retrievedAt).toLocaleString()}` : 'Unavailable'}</span></div><div><strong>Price history</strong><a href={study.sources.yfinance.url} target="_blank" rel="noreferrer">Yahoo Finance via yfinance ↗</a><span>{study.sources.yfinance.retrievedAt ? `Retrieved ${new Date(study.sources.yfinance.retrievedAt).toLocaleString()}` : 'Unavailable'}</span></div><p>Financials cover the latest ten available full fiscal years. Prices cover the trailing decade where available and use Yahoo’s split-adjusted close, without dividend adjustment. Refresh creates a new study snapshot.</p></footer>
  </main>;
}
