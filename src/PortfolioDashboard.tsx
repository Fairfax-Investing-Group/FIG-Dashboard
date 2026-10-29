import { numberFormatter, formatNumber, formatDate, calendarDate, marketDate } from './lib/format';
import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, usePlotArea, useYAxisScale } from 'recharts';
import initialPortfolio from './data/portfolio.json';
import PortfolioAllocation from './PortfolioAllocation';
import { portfolioDayChange, portfolioSharpe, portfolioRiskMetrics } from './portfolioMath';
import { apiUrl } from './lib/api';

type Portfolio = Omit<typeof initialPortfolio, 'holdings' | 'summary'> & {
  holdings: (typeof initialPortfolio.holdings[number] & { beta?: number | null; alpha?: number | null; standardDeviation?: number | null; trailingPE?: number | null; forwardPE?: number | null; pegRatio?: number | null; freeCashFlowYield?: number | null; sector?: string | null; marketCap?: number | null })[];
  summary: typeof initialPortfolio.summary & { beta?: number | null };
  lastSuccessfulAt?: string;
  priceSource?: string;
  refresh?: { status: 'ready' | 'pending' | 'updating' | 'error'; error: string | null; nextRefreshAt: string | null; retryAt: string | null; nextQuoteRefreshAt?: string | null; quoteStatus?: 'live' | 'pending' | 'closed' | 'error'; quoteUpdatedAt?: string | null; quoteError?: string | null };
};
type History = { date: string; value: number }[];
const currency = (value: number) => numberFormatter({ style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
const indexPrice = (value: number) => formatNumber(value);
const percent = (value: number, signed = false) => `${signed && value > 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
const betaLabel = (value: number | null | undefined) => value != null && Number.isFinite(value) ? value.toFixed(2) : '—';
const betaDescription = 'Trailing 1-year beta versus the S&P 500, using daily adjusted returns (minimum 60 observations).';
const changeClass = (value: number) => value > 0 ? 'portfolio-positive' : value < 0 ? 'portfolio-negative' : '';
const dateLabel = calendarDate;
type PortfolioEvent = { date: string; title: string; detail: string; source: string; automatic: boolean; dailyMove: number | null };
type ChartEvent = PortfolioEvent & { number: number };
// Keep verified historic catalysts here; future S&P 500 moves of 2% or more are flagged automatically below.
const majorMarketEvents = [
  { date: '2026-03-31', title: 'Iran de-escalation hopes', detail: 'Reports of a possible off-ramp from the Iran war sparked a broad relief rally.', source: 'https://apnews.com/article/84a7c46b51b3583f743c8da6a40d36ac' },
  { date: '2026-04-08', title: 'U.S.-Iran ceasefire', detail: 'The two-week ceasefire eased oil-supply fears and drove a sharp relief rally.', source: 'https://www.marketscreener.com/news/stocks-surge-oil-dives-below-100-as-iran-ceasefire-sparks-relief-rally-ce7e50dadf8bf421' },
  { date: '2026-06-05', title: 'Jobs report and chip selloff', detail: 'Stronger jobs data raised rate-hike concerns as AI semiconductor shares slumped.', source: 'https://apnews.com/article/b5e10863b81cb1d6399f688ad8885c46' },
  { date: '2026-08-04', title: 'Geopolitical tensions ease', detail: 'Cooling tensions helped lift the S&P 500 and Dow to new highs.', source: 'https://www.fool.com/coverage/stock-market-today/2026/08/04/stock-market-today-aug-4-s-and-p-500-and-dow-set-new-highs-on-easing-geopolitical-tensions/' },
] as const;
const autoMajorMoveThreshold = 0.02;

function Sparkline({ history, name, stretch = false }: { history: History; name: string; stretch?: boolean }) {
  if (history.length < 2) return <span className="portfolio-unavailable" title="No price history is stored in the workbook for this index">—</span>;
  const width = 100, height = 25, pad = 3, horizontalPad = stretch ? 0 : pad;
  const low = Math.min(...history.map(point => point.value)), high = Math.max(...history.map(point => point.value));
  const first = Date.parse(history[0].date), last = Date.parse(history.at(-1)!.date);
  const path = history.map((point, index) => `${index ? 'L' : 'M'}${(horizontalPad + (Date.parse(point.date) - first) / (last - first || 1) * (width - horizontalPad * 2)).toFixed(2)},${(high === low ? height / 2 : height - pad - (point.value - low) / (high - low) * (height - pad * 2)).toFixed(2)}`).join(' ');
  return <svg className="portfolio-sparkline" preserveAspectRatio={stretch ? 'none' : 'xMidYMid meet'} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${name} price history, ${dateLabel(history[0].date)} to ${dateLabel(history.at(-1)!.date)}`}><title>{name}: {currency(history[0].value)} to {currency(history.at(-1)!.value)}</title><path d={path} fill="none" stroke="#527da7" strokeWidth="1.4" strokeLinejoin="round"/></svg>;
}

function LatestReturnLabels({ point }: { point?: { club: number; benchmark: number } }) {
  const area = usePlotArea();
  const scale = useYAxisScale();
  if (!area || !scale || !point) return null;
  const labels = [
    { key: 'club', title: 'Fund return', value: point.club, color: '#234d76' },
    { key: 'benchmark', title: 'S&P return', value: point.benchmark, color: '#518168' },
  ].map(label => ({ ...label, anchorY: Number(scale(label.value)), y: Number(scale(label.value)) }));
  if (labels.some(label => !Number.isFinite(label.y))) return null;
  const top = area.y + 12, bottom = area.y + area.height - 12;
  const lowestEndpoint = Math.max(...labels.map(label => label.anchorY));
  const highestEndpoint = Math.min(...labels.map(label => label.anchorY));
  labels[0].y = Math.max(top, Math.min(bottom, highestEndpoint - 22));
  labels[1].y = Math.max(top, Math.min(bottom, lowestEndpoint + 38));
  const x = area.x + area.width;
  return <g className="portfolio-latest-labels" aria-label="Latest cumulative returns" style={{ pointerEvents: 'none' }}>{labels.map(label => <g key={label.key}>
    <circle cx={x} cy={label.anchorY} r={3} fill={label.color} stroke="#fff" strokeWidth={1}/>
    <path d={`M${x - 5},${label.anchorY} L${x - 10},${label.y}`} stroke={label.color} strokeWidth={1} fill="none"/>
    <rect x={x - 143} y={label.y - 9} width={132} height={18} rx={3} fill="rgba(255,255,255,.94)"/>
    <text x={x - 16} y={label.y} textAnchor="end" dominantBaseline="middle" fill={label.color} fontSize={10} fontWeight={600} data-testid={`return-label-${label.key}`}>{label.title}: {percent(label.value)}</text>
  </g>)}</g>;
}

export default function PortfolioDashboard({ onStudy }: { onStudy: (ticker: string) => void }) {
  const [portfolio, setPortfolio] = useState<Portfolio>(initialPortfolio);
  const [updateUnavailable, setUpdateUnavailable] = useState(false);
  useEffect(() => {
    let controller: AbortController | null = null;
    let timer = 0;
    let active = true;
    let nextQuoteRefreshAt: string | null = null;
    const update = async () => {
      if (document.hidden) return;
      controller?.abort();
      controller = new AbortController();
      try {
        let data: Portfolio | null = null;
        for (const source of ['/api/portfolio', '/portfolio-current.json']) {
          try {
            const response = await fetch(source.startsWith('/api/') ? apiUrl(source) : source, { signal: controller.signal, cache: 'no-store' });
            if (!response.ok) continue;
            const candidate = await response.json() as Portfolio;
            if (!Array.isArray(candidate.holdings) || !Array.isArray(candidate.performance) || typeof candidate.summary?.portfolioValue !== 'number') continue;
            data = candidate;
            break;
          } catch (sourceError) {
            if (sourceError instanceof DOMException && sourceError.name === 'AbortError') throw sourceError;
          }
        }
        if (!data) throw new Error('Portfolio unavailable');
        if (active) {
          setPortfolio(data);
          setUpdateUnavailable(false);
          nextQuoteRefreshAt = data.refresh?.nextQuoteRefreshAt ?? null;
          window.clearTimeout(timer);
          if (nextQuoteRefreshAt) {
            const delay = Math.max(0, new Date(nextQuoteRefreshAt).getTime() - Date.now());
            timer = window.setTimeout(() => { void update(); }, delay);
          }
        }
      } catch (error) {
        if (active && !(error instanceof DOMException && error.name === 'AbortError')) setUpdateUnavailable(true);
      }
    };
    void update();
    const onVisible = () => {
      if (document.hidden) return;
      if (!nextQuoteRefreshAt || new Date(nextQuoteRefreshAt).getTime() <= Date.now()) void update();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { active = false; controller?.abort(); window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  const [period, setPeriod] = useState<'Lifetime returns' | '1M' | '3M' | 'YTD'>('Lifetime returns');
  const [partnerName, setPartnerName] = useState<string | null>(null);
  const [activeMarketEvent, setActiveMarketEvent] = useState<ChartEvent | null>(null);
  const [pinnedMarketEvent, setPinnedMarketEvent] = useState<ChartEvent | null>(null);
  const [sort, setSort] = useState<{ key: 'marketValue' | 'gain' | 'return'; descending: boolean }>({ key: 'gain', descending: true });
  const summary = portfolio.summary;
  const sharpe = useMemo(() => portfolioSharpe(portfolio.performance), [portfolio.performance]);
  const risk = useMemo(() => portfolioRiskMetrics(portfolio.performance), [portfolio.performance]);
  const dailyChange = useMemo(() => portfolioDayChange(portfolio.holdings, summary.cash), [portfolio.holdings, summary.cash]);
  const rankedHoldings = [...portfolio.holdings].filter(item => Number.isFinite(item.return)).sort((a, b) => b.return - a.return);
  const bestHolding = rankedHoldings[0];
  const lowestHolding = rankedHoldings.at(-1);
  const cashAllocation = summary.portfolioValue > 0 ? summary.cash / summary.portfolioValue : null;
  const topThreeWeight = summary.holdingsValue > 0 ? [...portfolio.holdings].sort((a, b) => b.marketValue - a.marketValue).slice(0, 3).reduce((total, item) => total + item.marketValue, 0) / summary.holdingsValue : null;
  const performance = useMemo(() => {
    if (period === 'Lifetime returns') return portfolio.performance;
    if (period === 'YTD') return portfolio.performance.filter(point => point.date >= `${portfolio.asOf.slice(0, 4)}-01-01`);
    const cutoff = new Date(`${portfolio.asOf}T12:00:00Z`);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - (period === '1M' ? 1 : 3));
    return portfolio.performance.filter(point => point.date >= cutoff.toISOString().slice(0, 10));
  }, [period, portfolio]);
  const chartEvents = useMemo(() => {
    const events: PortfolioEvent[] = majorMarketEvents.map(event => ({ ...event, automatic: false, dailyMove: null }));
    const knownDates = new Set<string>(majorMarketEvents.map(event => event.date));
    const lastDocumentedDate = majorMarketEvents.at(-1)!.date;
    portfolio.performance.forEach((point, index) => {
      const previous = portfolio.performance[index - 1];
      if (!previous || point.date <= lastDocumentedDate || knownDates.has(point.date)) return;
      const dailyMove = (1 + point.benchmark) / (1 + previous.benchmark) - 1;
      if (Math.abs(dailyMove) >= autoMajorMoveThreshold) events.push({ date: point.date,
        title: dailyMove > 0 ? 'Sharp market rally' : 'Sharp market selloff',
        detail: 'Large S&P 500 move automatically flagged; add a verified event explanation.',
        source: '', automatic: true, dailyMove });
    });
    return events.flatMap((event, index) => {
      const point = performance.find(item => item.date === event.date);
      if (!point) return [];
      const fullIndex = portfolio.performance.findIndex(item => item.date === event.date);
      const previous = fullIndex > 0 ? portfolio.performance[fullIndex - 1] : undefined;
      const dailyMove = event.dailyMove ?? (previous ? (1 + point.benchmark) / (1 + previous.benchmark) - 1 : null);
      return [{ ...event, number: index + 1, dailyMove }];
    });
  }, [performance, portfolio.performance]);
  const shownMarketEvent = pinnedMarketEvent ?? activeMarketEvent;
  const holdings = sort ? [...portfolio.holdings].sort((a, b) => (a[sort.key] - b[sort.key]) * (sort.descending ? -1 : 1)) : portfolio.holdings;
  const partner = portfolio.partners.find(item => item.name === partnerName);
  const sortBy = (key: 'marketValue' | 'gain' | 'return') => setSort(current => ({ key, descending: current?.key === key ? !current.descending : true }));
  const sortLabel = (key: 'marketValue' | 'gain' | 'return') => <span className="portfolio-sort-arrows" aria-hidden="true">{sort.key === key && !sort.descending ? '↑' : '↓'}</span>;
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
  const riskMetrics = [
    { label: 'Sharpe ratio', value: betaLabel(sharpe), description: 'Annualized mean daily excess return / sample volatility; assumed 0% risk-free rate.' },
    { label: 'Beta vs. S&P 500', value: betaLabel(summary.beta), description: `${betaDescription} Market-value weighted, including cash at zero beta.` },
    { label: 'Sortino ratio', value: betaLabel(risk.sortino), description: 'Annualized mean daily return / downside deviation across all daily observations; 0% minimum acceptable return.' },
    { label: 'Max drawdown', value: risk.maxDrawdown == null ? '—' : percent(-risk.maxDrawdown), description: 'Largest peak-to-trough decline in the stored fund-return history, including the starting value.' },
    { label: 'Annualized volatility', value: risk.volatility == null ? '—' : percent(risk.volatility), description: 'Sample standard deviation of daily fund returns × √252.' },
    { label: 'Information ratio', value: betaLabel(risk.informationRatio), description: 'Annualized mean daily fund return minus S&P 500 return, divided by sample tracking error.' },
  ];
  return <section className="portfolio-dashboard" aria-label="Portfolio research dashboard">
    <div className="portfolio-top-summary"><div className="portfolio-summary">{metrics.map(metric => <div className="portfolio-summary-item" key={metric.label}><span>{metric.label}</span><strong className={metric.change == null ? '' : changeClass(metric.change)}>{metric.value}</strong></div>)}</div>
      <aside className="portfolio-risk-box" aria-labelledby="portfolio-risk-title"><div className="portfolio-risk-heading"><h3 id="portfolio-risk-title">Portfolio risk & allocation</h3><span title="Daily history metrics use the full stored record, not the chart period. Annualization uses 252 trading days; ratios require 60 daily returns. Beta uses the trailing year. Missing or undefined values display —.">Since inception · daily ⓘ</span></div><dl>{riskMetrics.map(metric => <div key={metric.label} title={metric.description}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl></aside>
    </div>
    <div className="portfolio-charts">
      <section className="portfolio-panel" aria-labelledby="portfolio-performance-title"><div className="portfolio-panel-heading"><h3 id="portfolio-performance-title">Fairfax Investing Group Select Opportunities Fund vs. S&amp;P 500</h3><div className="portfolio-period" role="group" aria-label="Return history period">{(['Lifetime returns', 'YTD', '1M', '3M'] as const).map(value => <button key={value} type="button" aria-pressed={period === value} onClick={() => setPeriod(value)}>{value}</button>)}</div></div><div className="portfolio-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={performance} margin={{ top: 6, right: 12, left: -15, bottom: 0 }}><CartesianGrid stroke="#edf1f5" vertical/><XAxis dataKey="date" tick={{ fontSize: 9, fill: '#7a8797' }} minTickGap={55} tickLine={false} axisLine={false} tickFormatter={value => formatDate(new Date(`${value}T12:00:00Z`), { month: 'short', day: 'numeric', timeZone: 'UTC' }, 'en-US')}/><YAxis padding={{ top: 24, bottom: 18 }} tickFormatter={value => `${(value * 100).toFixed(0)}%`} tick={{ fontSize: 9, fill: '#7a8797' }} tickLine={false} axisLine={false}/>{chartEvents.map(event => <ReferenceLine key={event.date} x={event.date} stroke="#91a0b2" strokeDasharray="3 3" strokeOpacity={0.65} shape={props => <line {...props}><title>{dateLabel(event.date)}: {event.title}. {event.detail}</title></line>} label={{ position: 'insideBottom', content: (props: { x?: string | number; y?: string | number }) => <g transform={`translate(${props.x ?? 0},${props.y ?? 0})`} className="portfolio-event-marker" role="button" tabIndex={0} aria-pressed={pinnedMarketEvent?.date === event.date} aria-label={`${dateLabel(event.date)}: ${event.title}. ${event.detail}`} onClick={() => { setPinnedMarketEvent(current => current?.date === event.date ? null : event); setActiveMarketEvent(null); }} onMouseEnter={() => setActiveMarketEvent(event)} onMouseLeave={() => setActiveMarketEvent(null)} onFocus={() => setActiveMarketEvent(event)} onBlur={() => setActiveMarketEvent(null)} onKeyDown={keyboardEvent => { if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') { keyboardEvent.preventDefault(); setPinnedMarketEvent(current => current?.date === event.date ? null : event); setActiveMarketEvent(null); } if (keyboardEvent.key === 'Escape') { setPinnedMarketEvent(null); setActiveMarketEvent(null); } }}><title>{dateLabel(event.date)}: {event.title}. Click to pin event details.</title><circle r={9}/><text y={3.2} textAnchor="middle">{event.number}</text></g> }} />)}<Tooltip formatter={value => percent(Number(value))} labelFormatter={label => dateLabel(String(label))} contentStyle={{ fontSize: 11, borderRadius: 6 }}/><Line name="Fund return" dataKey="club" stroke="#234d76" strokeWidth={1.8} dot={false} activeDot={{ r: 3 }} isAnimationActive={false}/><Line name="S&P 500" dataKey="benchmark" stroke="#76a68d" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} isAnimationActive={false}/><LatestReturnLabels point={performance.at(-1)}/></LineChart></ResponsiveContainer>{shownMarketEvent && <aside className="portfolio-event-card" aria-live="polite"><button type="button" className="portfolio-event-close" aria-label="Close event details" onClick={() => { setPinnedMarketEvent(null); setActiveMarketEvent(null); }}>×</button><strong>{dateLabel(shownMarketEvent.date)} · {shownMarketEvent.title}</strong><span>{shownMarketEvent.detail}</span>{shownMarketEvent.dailyMove != null && <small>S&amp;P 500: {percent(shownMarketEvent.dailyMove, true)} that day</small>}</aside>}</div></section>
      <PortfolioAllocation holdings={portfolio.holdings} cash={summary.cash} asOf={portfolio.asOf}/>
    </div>
    <section className="portfolio-panel portfolio-holdings" aria-labelledby="portfolio-holdings-title"><div className="portfolio-panel-heading"><h3 id="portfolio-holdings-title">Portfolio holdings</h3><span>{portfolio.holdings.length} positions · USD</span></div><div className="portfolio-table-scroll"><table className="portfolio-table"><caption className="sr-only">Holdings, original purchase dates and cost from the supplied workbook, with automatically updated closing prices and returns.</caption><thead><tr><th>Ticker</th><th>Company</th><th>Date added</th><th>Prc</th><th>Avg. cost</th><th>Shrs</th><th>Cost</th><th aria-sort={sort?.key === 'marketValue' ? sort.descending ? 'descending' : 'ascending' : 'none'}><button onClick={() => sortBy('marketValue')}>Mkt Val{sortLabel('marketValue')}</button></th><th aria-sort={sort.key === 'gain' ? sort.descending ? 'descending' : 'ascending' : 'none'}><button onClick={() => sortBy('gain')}>G/L{sortLabel('gain')}</button></th><th aria-sort={sort?.key === 'return' ? sort.descending ? 'descending' : 'ascending' : 'none'}><button onClick={() => sortBy('return')}>Return{sortLabel('return')}</button></th><th>Day %</th><th>Weight</th><th title={betaDescription}>Beta</th><th title="Yahoo Finance trailing P/E ratio">P/E</th><th title="Yahoo Finance forward P/E ratio">Fwd P/E</th><th title="Yahoo Finance PEG ratio">PEG</th><th title="Trailing free cash flow divided by market capitalization">FCF Yld</th><th title="Annualized Jensen alpha versus the S&amp;P 500, using a 0% risk-free rate">Alpha</th><th title="Annualized standard deviation of trailing 1-year daily adjusted returns">SD</th><th>52W H</th><th>52W L</th><th className="portfolio-history-cell">Last 90 days</th></tr></thead><tbody>{holdings.map(holding => <tr key={holding.ticker}><th scope="row"><button className="portfolio-ticker" onClick={() => onStudy(holding.ticker)} title={`Analyze ${holding.name}`}>{holding.ticker}</button></th><td className="portfolio-company-name" title={holding.name}>{holding.name}</td><td className="portfolio-purchase-date"><time dateTime={holding.purchaseDate}>{dateLabel(holding.purchaseDate)}</time>{holding.purchaseNote && <small>{holding.purchaseNote}</small>}</td><td>{currency(holding.price)}</td><td>{currency(holding.averageCost)}</td><td>{holding.shares}</td><td>{currency(holding.cost)}</td><td>{currency(holding.marketValue)}</td><td className={changeClass(holding.gain)}>{currency(holding.gain)}</td><td className={changeClass(holding.return)}>{percent(holding.return)}</td><td className={changeClass(holding.dayChange)}>{percent(holding.dayChange)}</td><td>{percent(holding.weight)}</td><td title={betaDescription}>{betaLabel(holding.beta)}</td><td>{betaLabel(holding.trailingPE)}</td><td>{betaLabel(holding.forwardPE)}</td><td>{betaLabel(holding.pegRatio)}</td><td>{holding.freeCashFlowYield == null ? '—' : percent(holding.freeCashFlowYield)}</td><td className={changeClass(holding.alpha ?? 0)}>{holding.alpha == null ? '—' : percent(holding.alpha, true)}</td><td>{holding.standardDeviation == null ? '—' : percent(holding.standardDeviation)}</td><td>{currency(holding.high52)}</td><td>{currency(holding.low52)}</td><td className="portfolio-history-cell"><Sparkline history={holding.history} name={holding.ticker} stretch/></td></tr>)}</tbody><tfoot><tr><th scope="row" colSpan={6}>Holdings total</th><td>{currency(summary.totalCost)}</td><td>{currency(summary.holdingsValue)}</td><td className={changeClass(summary.gain)}>{currency(summary.gain)}</td><td className={changeClass(summary.portfolioReturn)}>{percent(summary.portfolioReturn)}</td><td className={dailyChange == null ? '' : changeClass(dailyChange)} title="Portfolio change from the previous close, including cash held constant" data-testid="portfolio-day-change">{dailyChange == null ? '—' : percent(dailyChange, true)}</td><td>100.00%</td><td colSpan={7}/><td colSpan={3}/></tr></tfoot></table></div><p className="portfolio-table-note">Dates and “avg down” notes follow the workbook. Weight is each holding’s share of invested market value; cash is excluded. Beta, Alpha, and SD use trailing 1-year daily adjusted returns versus the S&amp;P 500; Alpha is annualized with a 0% risk-free rate. P/E, Fwd P/E, and PEG use Yahoo Finance valuation metrics; FCF Yld is trailing free cash flow divided by market capitalization. — indicates unavailable data. Portfolio beta and total Day change include cash. Sharpe is annualized from stored fund-return history since inception with an assumed 0% risk-free rate.</p></section>
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
    <div className="portfolio-performance-status"><div className="portfolio-asof"><strong>{portfolio.refresh?.quoteStatus === 'live' ? 'Intraday portfolio' : portfolio.lastSuccessfulAt ? 'End-of-day portfolio' : 'Workbook snapshot'}</strong><span>Updated {portfolio.refresh?.quoteUpdatedAt ? new Date(portfolio.refresh.quoteUpdatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' }) : portfolio.updatedLabel}</span><span className="portfolio-refresh-status" aria-live="polite">{updateUnavailable || portfolio.refresh?.quoteStatus === 'error' || portfolio.refresh?.status === 'error' ? 'Latest update unavailable · retaining last values' : portfolio.refresh?.quoteStatus === 'closed' ? `Market closed · next check ${new Date(portfolio.refresh.nextQuoteRefreshAt ?? '').toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' })}` : portfolio.refresh?.nextQuoteRefreshAt ? `Next price update ${new Date(portfolio.refresh.nextQuoteRefreshAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' })}` : 'Prices update every 15 minutes during market hours'}</span></div></div>
    <p className="portfolio-source">Purchase dates, cost bases, share counts, and cash originate from {portfolio.source}. Live prices update every 15 minutes during NYSE trading hours; daily history and risk metrics refresh after the close. Share counts adjust for subsequent stock splits. Return history starts {dateLabel(portfolio.performance[0].date)}.</p>
  </section>;
}
