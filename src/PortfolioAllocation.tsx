import { useState } from 'react';
type Holding = { name?: string; purchaseDate?: string; ticker: string; marketValue: number; return: number; sector?: string | null; marketCap?: number | null };
type Allocation = { name: string; value: number; companies?: string[] };
const blues = ['#193f68', '#2d5e8e', '#487faf', '#74a1c8', '#9bbdd8', '#c0d5e6', '#dce7ef'];
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

function tooltipPosition(element: SVGGElement, selector: string, clientX?: number, clientY?: number) {
  const container = element.closest(selector)!.getBoundingClientRect();
  const item = element.getBoundingClientRect();
  const x = (clientX ?? item.x + item.width / 2) - container.x;
  const y = (clientY ?? item.y + item.height / 2) - container.y;
  return { left: Math.max(6, Math.min(container.width - 154, x + 10)), top: Math.max(6, Math.min(container.height - 72, y + 10)) };
}


export function sizeCategory(cap?: number | null) {
  if (cap == null || !Number.isFinite(cap) || cap <= 0) return 'Unclassified';
  return cap >= 200e9 ? 'Mega' : cap >= 10e9 ? 'Large' : cap >= 2e9 ? 'Mid' : cap >= 300e6 ? 'Small' : 'Micro';
}

export function allocationGroups(holdings: Holding[], category: (holding: Holding) => string): Allocation[] {
  const groups = new Map<string, number>();
  for (const holding of holdings) {
    if (!Number.isFinite(holding.marketValue) || holding.marketValue <= 0) continue;
    const key = category(holding);
    groups.set(key, (groups.get(key) || 0) + holding.marketValue);
  }
  return [...groups].map(([name, value]) => ({ name, value, companies: holdings.filter(holding => category(holding) === name).map(holding => `${holding.ticker}${holding.name ? ` · ${holding.name}` : ''}`) })).sort((a, b) => b.value - a.value);
}

function AllocationDonut({ title, data }: { title: string; data: Allocation[] }) {
  const [active, setActive] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const classificationUnavailable = data.length === 0 || data.every(item => item.name === 'Unclassified');
  if (classificationUnavailable) return <div className="portfolio-allocation-donut portfolio-allocation-unavailable"><h4>{title}</h4><p>Classification data unavailable</p></div>;
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const selected = data.find(item => item.name === active);
  const abbreviations: Record<string, string> = { Technology: 'Tech', Healthcare: 'Health', 'Financial Services': 'Financial', 'Communication Services': 'Comm.', 'Consumer Cyclical': 'Consumer', 'Consumer Defensive': 'Defensive', 'Basic Materials': 'Materials', Unclassified: 'Unknown' };
  let angle = -Math.PI / 2;
  return <div className="portfolio-allocation-donut" onMouseLeave={() => setActive(null)}><h4>{title}</h4>
    <svg viewBox="0 0 220 190" role="img" aria-label={`${title} allocation: ${data.map(item => `${item.name} ${percent(item.value / total)}`).join(', ')}`}>
      {data.map((item, index) => {
        const start = angle, sweep = item.value / total * Math.PI * 2;
        angle += sweep;
        const end = angle, middle = (start + end) / 2;
        const point = (a: number, radius: number) => [110 + Math.cos(a) * radius, 95 + Math.sin(a) * radius];
        const [x1, y1] = point(start, 70), [x2, y2] = point(end, 70);
        const [labelX, labelY] = point(middle, 84);
        const right = Math.cos(middle) >= 0;
        const tech = title === 'Sector' && item.name === 'Technology';
        return <g key={item.name} tabIndex={0} role="button" aria-label={`${item.name}: ${percent(item.value / total)}; ${item.companies?.join(', ')}`} onMouseEnter={event => { setActive(item.name); setPosition(tooltipPosition(event.currentTarget, '.portfolio-allocation-donut', event.clientX, event.clientY)); }} onMouseMove={event => setPosition(tooltipPosition(event.currentTarget, '.portfolio-allocation-donut', event.clientX, event.clientY))} onFocus={event => { setActive(item.name); setPosition(tooltipPosition(event.currentTarget, '.portfolio-allocation-donut')); }} onBlur={() => setActive(null)} onKeyDown={event => { if (event.key === 'Escape') setActive(null); }} className="portfolio-pie-slice">
          {sweep >= Math.PI * 2 - .00001 ? <circle cx="110" cy="95" r="70" fill={blues[index % blues.length]}/> : <path d={`M110,95 L${x1},${y1} A70,70 0 ${sweep > Math.PI ? 1 : 0},1 ${x2},${y2} Z`} fill={blues[index % blues.length]} stroke="#fff" strokeWidth="1.5" opacity={active && active !== item.name ? .35 : 1}/>}
          <text x={tech ? 110 : labelX} y={tech ? 178 : labelY} dominantBaseline="middle" textAnchor={tech ? 'middle' : right ? 'start' : 'end'} fill="#325779" fontSize="9">{abbreviations[item.name] || item.name}</text>
        </g>;
      })}
    </svg>
    {selected && <div className="portfolio-allocation-tooltip" role="tooltip" style={position}><strong>{selected.name} · {percent(selected.value / total)}</strong><span>{selected.companies?.map(company => company.split(' · ')[0]).join(', ')}</span></div>}
  </div>;
}

type Tile = Allocation & { change: number | null; cash?: boolean; purchaseDate?: string; x: number; y: number; width: number; height: number };
export function layoutTiles(items: Omit<Tile, 'x' | 'y' | 'width' | 'height'>[], x = 0, y = 0, width = 360, height = 190): Tile[] {
  const positive = items.filter(item => Number.isFinite(item.value) && item.value > 0).sort((a, b) => b.value - a.value);
  const total = positive.reduce((sum, item) => sum + item.value, 0);
  if (!total || width <= 0 || height <= 0) return [];
  const remaining = positive.map(item => ({ item, area: item.value / total * width * height }));
  const tiles: Tile[] = [];
  let left = x, top = y, availableWidth = width, availableHeight = height;
  const worstAspect = (row: typeof remaining, side: number) => {
    const sum = row.reduce((value, entry) => value + entry.area, 0);
    const areas = row.map(entry => entry.area);
    return Math.max(side ** 2 * Math.max(...areas) / sum ** 2, sum ** 2 / (side ** 2 * Math.min(...areas)));
  };
  while (remaining.length) {
    const side = Math.min(availableWidth, availableHeight);
    const row = [remaining.shift()!];
    while (remaining.length && worstAspect([...row, remaining[0]], side) <= worstAspect(row, side)) row.push(remaining.shift()!);
    const area = row.reduce((sum, entry) => sum + entry.area, 0);
    if (availableWidth >= availableHeight) {
      const rowWidth = area / availableHeight;
      let cursor = top;
      for (const entry of row) {
        const tileHeight = entry.area / rowWidth;
        tiles.push({ ...entry.item, x: left, y: cursor, width: rowWidth, height: tileHeight });
        cursor += tileHeight;
      }
      left += rowWidth;
      availableWidth -= rowWidth;
    } else {
      const rowHeight = area / availableWidth;
      let cursor = left;
      for (const entry of row) {
        const tileWidth = entry.area / rowHeight;
        tiles.push({ ...entry.item, x: cursor, y: top, width: tileWidth, height: rowHeight });
        cursor += tileWidth;
      }
      top += rowHeight;
      availableHeight -= rowHeight;
    }
  }
  return tiles;
}

export default function PortfolioAllocation({ holdings, cash, asOf }: { holdings: Holding[]; cash: number; asOf: string }) {
  const [activeTile, setActiveTile] = useState<Tile | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const sectors = allocationGroups(holdings, item => item.sector || 'Unclassified');
  const sizes = allocationGroups(holdings, item => sizeCategory(item.marketCap));
  const items = [...holdings.map(item => ({ name: item.ticker, value: item.marketValue, purchaseDate: item.purchaseDate, change: Number.isFinite(item.return) ? item.return : null })), { name: 'CASH', value: cash, change: null, cash: true }].filter(item => Number.isFinite(item.value) && item.value > 0).sort((a, b) => b.value - a.value);
  const tiles = layoutTiles(items);
  return <>
    <section className="portfolio-panel portfolio-diversification" aria-labelledby="portfolio-diversification-title"><div className="portfolio-panel-heading"><h3 id="portfolio-diversification-title">Portfolio diversification</h3><span>{asOf}</span></div>
      <div className="portfolio-allocation-pies"><AllocationDonut title="Sector" data={sectors}/><AllocationDonut title="Size" data={sizes}/></div>
      <p className="portfolio-allocation-note" title="Market capitalization: Mega ≥ $200B; Large $10–200B; Mid $2–10B; Small $300M–2B; Micro < $300M.">Holdings only · weighted by market value</p>
    </section>
    <section className="portfolio-panel portfolio-heatmap" aria-labelledby="portfolio-heatmap-title"><div className="portfolio-panel-heading"><h3 id="portfolio-heatmap-title">Portfolio heatmap</h3><span>{asOf}</span></div>
      <div className="portfolio-heatmap-body" onMouseLeave={() => setActiveTile(null)}><div className="portfolio-heatmap-plot"><svg viewBox="0 0 360 190" preserveAspectRatio="none" role="img" aria-label="Portfolio heatmap: tile area shows allocation including cash; blue shade shows return since purchase">
        {tiles.map(tile => {
          const fill = tile.cash ? '#e4eaf0' : tile.change == null ? '#d1dbe5' : tile.change < 0 ? '#cadbea' : tile.change < .15 ? '#7ea8cb' : tile.change < .3 ? '#477eac' : '#204e7c';
          const purchased = tile.purchaseDate ? new Date(`${tile.purchaseDate}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Unavailable';
          return <g key={tile.name} tabIndex={0} role="button" aria-label={`${tile.name}${tile.cash ? ': Cash position' : `: ${tile.change == null ? 'Return unavailable' : percent(tile.change) + ' return'}; purchased ${purchased}`}`} onMouseEnter={event => { setActiveTile(tile); setPosition(tooltipPosition(event.currentTarget, '.portfolio-heatmap-body', event.clientX, event.clientY)); }} onMouseMove={event => setPosition(tooltipPosition(event.currentTarget, '.portfolio-heatmap-body', event.clientX, event.clientY))} onFocus={event => { setActiveTile(tile); setPosition(tooltipPosition(event.currentTarget, '.portfolio-heatmap-body')); }} onBlur={() => setActiveTile(null)} onKeyDown={event => { if (event.key === 'Escape') setActiveTile(null); }}><title>{tile.cash ? 'Cash position' : `${tile.name}: ${tile.change == null ? 'Return unavailable' : percent(tile.change) + ' return'} · Purchased ${purchased}`}</title><rect x={tile.x} y={tile.y} width={tile.width} height={tile.height} fill={fill} stroke="#fff" strokeWidth="1.5"/></g>;

        })}
      </svg><div className="portfolio-heatmap-labels" aria-hidden="true">{tiles.map(tile => <span key={tile.name} style={{ left: `${(tile.x + tile.width / 2) / 360 * 100}%`, top: `${(tile.y + tile.height / 2) / 190 * 100}%`, color: !tile.cash && tile.change != null && tile.change >= .15 ? '#fff' : '#193f68' }}>{tile.name}</span>)}</div></div>{activeTile && <div className="portfolio-heatmap-tooltip" role="tooltip" style={position}><strong>{activeTile.name}</strong>{activeTile.cash ? <span>Cash position</span> : <><span>Return: {activeTile.change == null ? 'Unavailable' : percent(activeTile.change)}</span><span>Purchased: {activeTile.purchaseDate ? new Date(`${activeTile.purchaseDate}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Unavailable'}</span></>}</div>}<div className="portfolio-heatmap-legend"><span>Loss</span><i/><span>Higher return</span></div><p className="portfolio-allocation-note">Area: allocation · shade: return since purchase</p></div>
    </section>
  </>;
}
