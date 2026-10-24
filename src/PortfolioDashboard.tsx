import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, usePlotArea, useYAxisScale } from 'recharts';
import initialPortfolio from './data/portfolio.json';

type Portfolio = typeof initialPortfolio & {
  lastSuccessfulAt?: string;
  priceSource?: string;
  refresh?: { status: 'ready' | 'pending' | 'updating' | 'error'; error: string | null; nextRefreshAt: string | null; retryAt: string | null };
};
type History = { date: string; value: number }[];
const currency = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
const indexPrice = (value: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const percent = (value: number, signed = false) => `${signed && value > 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
const changeClass = (value: number) => value > 0 ? 'portfolio-positive' : value < 0 ? 'portfolio-negative' : '';
const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function Sparkline({ history, name, stretch = false }: { history: History; name: string; stretch?: boolean }) {
  if (history.length < 2) return <span className="portfolio-unavailable" title="No price history is stored in the workbook for this index">—</span>;
  const width = 100, height = 25, pad = 3, horizontalPad = stretch ? 0 : pad;
  const low = Math.min(...history.map(point => point.value)), high = Math.max(...history.map(point => point.value));
  const first = Date.parse(history[0].date), last = Date.parse(history.at(-1)!.date);
  const path = history.map((point, index) => `${index ? 'L' : 'M'}${(horizontalPad + (Date.parse(point.date) - first) / (last - first || 1) * (width - horizontalPad * 2)).toFixed(2)},${(high === low ? height / 2 : height - pad - (point.value - low) / (high - low) * (height - pad * 2)).toFixed(2)}`).join(' ');
  return <svg className="portfolio-sparkline" preserveAspectRatio={stretch ? 'none' : 'xMidYMid meet'} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${name} price history, ${dateLabel(history[0].date)} to ${dateLabel(history.at(-1)!.date)}`}><title>{name}: {currency(history[0].value)} to {currency(history.at(-1)!.value)}</title><path d={path} fill="none" stroke="#527da7" strokeWidth="1.4" strokeLinejoin="round"/></svg>;
}

function ReturnEndLabels({ point }: { point?: { club: number; benchmark: number } }) {
  const area = usePlotArea();
  const yScale = useYAxisScale();
  if (!area || !yScale || !point) return null;
  const endX = area.x + area.width;
  const labels = [
    { key: 'club', title: 'Club return', value: point.club, color: '#234d76' },
    { key: 'benchmark', title: 'S&P return', value: point.benchmark, color: '#518168' },
  ].map(label => ({ ...label, anchorY: Number(yScale(label.value)), y: Number(yScale(label.value)) }))
    .sort((a, b) => a.y - b.y);
  if (labels.some(label => !Number.isFinite(label.y))) return null;
  const top = area.y + 10, bottom = area.y + area.height - 10;
  labels.forEach(label => { label.y = Math.max(top, Math.min(bottom, label.y)); });
  if (labels[1].y - labels[0].y < 19) {
    const middle = Math.max(top + 9.5, Math.min(bottom - 9.5, (labels[0].y + labels[1].y) / 2));
    labels[0].y = middle - 9.5;
    labels[1].y = middle + 9.5;
  }
  return <g className="portfolio-return-labels">{labels.map(label => <g key={label.key}>
    <circle cx={endX} cy={label.anchorY} r={2.5} fill={label.color}/>
    <path d={`M${endX + 4},${label.anchorY} L${endX + 9},${label.y}`} stroke={label.color} strokeWidth={1} fill="none"/>
    <text x={endX + 13} y={label.y} dominantBaseline="middle" fill={label.color} fontSize={11} fontWeight={600} data-testid={`return-label-${label.key}`}>{label.title}: {percent(label.value)}</text>
  </g>)}</g>;
}

export default function PortfolioDashboard({ onStudy }: { onStudy: (ticker: string) => void }) {
  const [portfolio, setPortfolio] = useState<Portfolio>(initialPortfolio);
  const [updateUnavailable, setUpdateUnavailable] = useState(false);
  useEffect(() => {
    let controller: AbortController | null = null;
    let active = true;
    const update = async () => {
      if (document.hidden) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch('/api/portfolio', { signal: controller.signal });
        if (!response.ok) throw new Error('Portfolio unavailable');
        const data = await response.json() as Portfolio;
        if (!Array.isArray(data.holdings) || !Array.isArray(data.performance) || typeof data.summary?.portfolioValue !== 'number') throw new Error('Invalid portfolio');
        if (active) { setPortfolio(data); setUpdateUnavailable(false); }
      } catch (error) {
        if (active && !(error instanceof DOMException && error.name === 'AbortError')) setUpdateUnavailable(true);
      }
    };
    void update();
    const timer = window.setInterval(() => { void update(); }, 60_000);
    const onVisible = () => { if (!document.hidden) void update(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { active = false; controller?.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  const [period, setPeriod] = useState<'1M' | '3M' | 'YTD'>('YTD');
  const [partnerName, setPartnerName] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: 'marketValue' | 'return'; descending: boolean } | null>(null);
  const summary = portfolio.summary;
  const rankedHoldings = [...portfolio.holdings].filter(item => Number.isFinite(item.return)).sort((a, b) => b.return - a.return);
  const bestHolding = rankedHoldings[0];
  const lowestHolding = rankedHoldings.at(-1);
  const cashAllocation = summary.portfolioValue > 0 ? summary.cash / summary.portfolioValue : null;
  const topThreeWeight = summary.holdingsValue > 0 ? [...portfolio.holdings].sort((a, b) => b.marketValue - a.marketValue).slice(0, 3).reduce((total, item) => total + item.marketValue, 0) / summary.holdingsValue : null;
  const performance = useMemo(() => {
    if (period === 'YTD') return portfolio.performance;
    const cutoff = new Date(`${portfolio.asOf}T12:00:00Z`);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - (period === '1M' ? 1 : 3));
    return portfolio.performance.filter(point => point.date >= cutoff.toISOString().slice(0, 10));
  }, [period, portfolio]);
  const holdings = sort ? [...portfolio.holdings].sort((a, b) => (a[sort.key] - b[sort.key]) * (sort.descending ? -1 : 1)) : portfolio.holdings;
  const partner = portfolio.partners.find(item => item.name === partnerName);
  const sortBy = (key: 'marketValue' | 'return') => setSort(current => ({ key, descending: current?.key === key ? !current.descending : true }));
  const sortLabel = (key: 'marketValue' | 'return') => <span className="portfolio-sort-arrows" aria-hidden="true">
    <span style={{ opacity: sort?.key === key && sort.descending ? 0.4 : 1 }}>↑</span>
    <span style={{ opacity: sort?.key === key && !sort.descending ? 0.4 : 1 }}>↓</span>
  </span>;
  const metrics = [
    { label: 'Total portfolio value', value: currency(summary.portfolioValue) },
    { label: 'Cash position', value: currency(summary.cash) },
    { label: 'Total cost', value: currency(summary.totalCost) },
    { label: 'Holdings market value', value: currency(summary.holdingsValue) },
    { label: 'Portfolio return YTD', value: percent(summary.portfolioReturn, true), change: summary.portfolioReturn },
    { label: 'S&P 500 return YTD', value: percent(summary.benchmarkReturn, true), change: summary.benchmarkReturn },
    { label: 'Relative return', value: percent(summary.relativeReturn, true), change: summary.relativeReturn },
    { label: 'Total gain / loss', value: currency(summary.gain), change: summary.gain },
  ];
  return <section className="portfolio-dashboard" aria-label="Portfolio research dashboard">
    <div className="portfolio-summary">{metrics.map(metric => <div className="portfolio-summary-item" key={metric.label}><span>{metric.label}</span><strong className={metric.change == null ? '' : changeClass(metric.change)}>{metric.value}</strong></div>)}</div>
    <div className="portfolio-charts">
      <section className="portfolio-panel" aria-labelledby="portfolio-performance-title"><div className="portfolio-panel-heading"><h3 id="portfolio-performance-title">Club fund vs. S&P 500</h3><div className="portfolio-period" role="group" aria-label="Return history period">{(['1M', '3M', 'YTD'] as const).map(value => <button key={value} type="button" aria-pressed={period === value} onClick={() => setPeriod(value)}>{value}</button>)}</div></div><div className="portfolio-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={performance} margin={{ top: 10, right: 145, left: -15, bottom: 0 }}><CartesianGrid stroke="#e9edf1" vertical={false}/><XAxis dataKey="date" tick={{ fontSize: 9, fill: '#7a8797' }} minTickGap={55} tickLine={false} axisLine={false} tickFormatter={value => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}/><YAxis tickFormatter={value => `${(value * 100).toFixed(0)}%`} tick={{ fontSize: 9, fill: '#7a8797' }} tickLine={false} axisLine={false}/><Tooltip formatter={value => percent(Number(value))} labelFormatter={label => dateLabel(String(label))} contentStyle={{ fontSize: 11, borderRadius: 6 }}/><Legend iconType="plainline" iconSize={15} wrapperStyle={{ fontSize: 10, paddingTop: 4 }}/><Line name="Club fund" dataKey="club" stroke="#234d76" strokeWidth={1.8} dot={false} activeDot={{ r: 3 }} isAnimationActive={false}/><Line name="S&P 500" dataKey="benchmark" stroke="#76a68d" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} isAnimationActive={false}/><ReturnEndLabels point={performance.at(-1)}/></LineChart></ResponsiveContainer></div><div className="portfolio-performance-status"><div className="portfolio-asof"><strong>{portfolio.lastSuccessfulAt ? 'End-of-day portfolio' : 'Workbook snapshot'}</strong><span>Updated {portfolio.updatedLabel}</span><span className="portfolio-refresh-status" aria-live="polite">{updateUnavailable || portfolio.refresh?.status === 'error' ? 'Latest update unavailable · retaining last values' : portfolio.refresh?.status === 'updating' ? 'Updating latest market close…' : portfolio.refresh?.nextRefreshAt ? `Next update ${new Date(portfolio.refresh.nextRefreshAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' })}` : 'Automatic updates after market close'}</span></div></div></section>
    </div>
    <section className="portfolio-panel portfolio-holdings" aria-labelledby="portfolio-holdings-title"><div className="portfolio-panel-heading"><h3 id="portfolio-holdings-title">Portfolio holdings</h3><span>{portfolio.holdings.length} positions · USD</span></div><div className="portfolio-table-scroll"><table className="portfolio-table"><caption className="sr-only">Holdings, original purchase dates and cost from the supplied workbook, with automatically updated closing prices and returns.</caption><thead><tr><th>Ticker</th><th>Company</th><th>Date added</th><th>Price</th><th>Avg. cost</th><th>Shares</th><th>Cost</th><th aria-sort={sort?.key === 'marketValue' ? sort.descending ? 'descending' : 'ascending' : 'none'}><button onClick={() => sortBy('marketValue')}>Market value{sortLabel('marketValue')}</button></th><th>Gain / loss</th><th aria-sort={sort?.key === 'return' ? sort.descending ? 'descending' : 'ascending' : 'none'}><button onClick={() => sortBy('return')}>Return{sortLabel('return')}</button></th><th>Day</th><th>Weight</th><th>52W high</th><th>52W low</th><th>Last 90 days</th></tr></thead><tbody>{holdings.map(holding => <tr key={holding.ticker}><th scope="row"><button className="portfolio-ticker" onClick={() => onStudy(holding.ticker)} title={`Analyze ${holding.name}`}>{holding.ticker}</button></th><td className="portfolio-company-name" title={holding.name}>{holding.name}</td><td className="portfolio-purchase-date"><time dateTime={holding.purchaseDate}>{dateLabel(holding.purchaseDate)}</time>{holding.purchaseNote && <small>{holding.purchaseNote}</small>}</td><td>{currency(holding.price)}</td><td>{currency(holding.averageCost)}</td><td>{holding.shares}</td><td>{currency(holding.cost)}</td><td>{currency(holding.marketValue)}</td><td className={changeClass(holding.gain)}>{currency(holding.gain)}</td><td className={changeClass(holding.return)}>{percent(holding.return)}</td><td className={changeClass(holding.dayChange)}>{percent(holding.dayChange)}</td><td>{percent(holding.weight)}</td><td>{currency(holding.high52)}</td><td>{currency(holding.low52)}</td><td><Sparkline history={holding.history} name={holding.ticker}/></td></tr>)}</tbody><tfoot><tr><th scope="row" colSpan={6}>Holdings total</th><td>{currency(summary.totalCost)}</td><td>{currency(summary.holdingsValue)}</td><td className={changeClass(summary.gain)}>{currency(summary.gain)}</td><td className={changeClass(summary.portfolioReturn)}>{percent(summary.portfolioReturn)}</td><td>—</td><td>100.00%</td><td colSpan={3}/></tr></tfoot></table></div><p className="portfolio-table-note">Dates and “avg down” notes follow the workbook. Weight is each holding’s share of invested market value; cash is excluded.</p></section>
    <div className="portfolio-bottom-grid">
      <section className="portfolio-panel" aria-labelledby="portfolio-partners-title"><div className="portfolio-panel-heading"><h3 id="portfolio-partners-title">Individual returns</h3></div><table className="portfolio-small-table"><thead><tr><th>Partner</th><th>Tickers pitched</th><th>Return</th></tr></thead><tbody>{portfolio.partners.map(item => <tr key={item.name}><th scope="row"><button className="portfolio-partner-button" aria-expanded={partnerName === item.name} aria-controls="portfolio-partner-detail" onClick={() => setPartnerName(current => current === item.name ? null : item.name)}>{item.name} <span aria-hidden="true">↗</span></button></th><td>{item.tickers}</td><td className={changeClass(item.return)}>{percent(item.return)}</td></tr>)}</tbody></table></section>
      <section className="portfolio-panel" aria-labelledby="portfolio-insights-title"><div className="portfolio-panel-heading"><h3 id="portfolio-insights-title">Portfolio insights</h3></div><dl className="portfolio-insights">
        <div><dt>Cash allocation</dt><dd>{cashAllocation === null ? '—' : percent(cashAllocation)}</dd></div>
        <div title="Combined weight of the three largest positions, excluding cash"><dt>Top 3 holdings weight</dt><dd>{topThreeWeight === null ? '—' : percent(topThreeWeight)}</dd></div>
        <div title="Highest return since purchase"><dt>Best holding return</dt><dd>{bestHolding ? <><button className="portfolio-ticker" onClick={() => onStudy(bestHolding.ticker)}>{bestHolding.ticker}</button><span className={changeClass(bestHolding.return)}>{percent(bestHolding.return, true)}</span></> : '—'}</dd></div>
        <div title="Lowest return since purchase"><dt>Lowest holding return</dt><dd>{lowestHolding ? <><button className="portfolio-ticker" onClick={() => onStudy(lowestHolding.ticker)}>{lowestHolding.ticker}</button><span className={changeClass(lowestHolding.return)}>{percent(lowestHolding.return, true)}</span></> : '—'}</dd></div>
      </dl></section>
      <section className="portfolio-panel" aria-labelledby="portfolio-pulse-title"><div className="portfolio-panel-heading"><h3 id="portfolio-pulse-title">Market pulse</h3></div><table className="portfolio-small-table"><thead><tr><th>Ticker</th><th>Index</th><th>Day</th><th>History</th></tr></thead><tbody>{portfolio.marketPulse.map(item => <tr key={item.ticker}><th scope="row">{item.ticker}</th><td>{item.name}</td><td className={changeClass(item.dayChange)}>{percent(item.dayChange)}</td><td><Sparkline history={item.history} name={item.ticker} stretch/></td></tr>)}</tbody></table></section>
      <section className="portfolio-panel" aria-labelledby="portfolio-indexes-title"><div className="portfolio-panel-heading"><h3 id="portfolio-indexes-title">Indexes</h3></div><table className="portfolio-small-table"><thead><tr><th>Name</th><th>Price</th><th>History</th></tr></thead><tbody>{portfolio.indexes.map(item => <tr key={item.name}><th scope="row">{item.name}</th><td>{indexPrice(item.price)}</td><td><Sparkline history={item.history} name={item.name} stretch/></td></tr>)}</tbody></table></section>
    </div>
    {partner && <section id="portfolio-partner-detail" className="portfolio-panel portfolio-partner-detail" aria-label={`${partner.name} pitch performance`}><div className="portfolio-panel-heading"><h3>{partner.name} · Pitch & performance track record</h3><button onClick={() => setPartnerName(null)} aria-label="Close pitch details">Close ×</button></div><div className="portfolio-table-scroll"><table className="portfolio-table"><thead><tr><th>Ticker</th><th>Date pitched</th><th>Pitch price</th><th>Current price</th><th>Shares</th><th>Cost</th><th>Market value</th><th>Gain / loss</th><th>Return since pitch</th></tr></thead><tbody>{partner.pitches.map(pitch => <tr key={pitch.ticker}><th scope="row"><button className="portfolio-ticker" onClick={() => onStudy(pitch.ticker)}>{pitch.ticker}</button></th><td>{dateLabel(pitch.date)}</td><td>{currency(pitch.pitchPrice)}</td><td>{currency(pitch.price)}</td><td>{pitch.shares.toFixed(6)}</td><td>{currency(pitch.cost)}</td><td>{currency(pitch.marketValue)}</td><td className={changeClass(pitch.gain)}>{currency(pitch.gain)}</td><td className={changeClass(pitch.return)}>{percent(pitch.return)}</td></tr>)}</tbody></table></div></section>}
    <p className="portfolio-source">Purchase dates, cost bases, share counts, and cash originate from {portfolio.source}. {portfolio.lastSuccessfulAt ? 'Closing prices and returns update 15 minutes after each trading session closes; holidays and early closes are included. Share counts adjust for subsequent stock splits.' : 'Showing the last available snapshot while the daily update is checked.'} Return history starts {dateLabel(portfolio.performance[0].date)}.</p>
  </section>;
}
