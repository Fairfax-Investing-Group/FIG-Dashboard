import { useState, type ReactNode } from 'react';
import type { Study } from './types';
import { currentValuation, valuationAverage, type ValuationRow } from './valuationMath';
import { assumption, riskReward, type LowPriceMethod, type ZoneSplit } from './riskRewardMath';

type Draft = {
  highPE: string; lowPE: string; lowEPSMode: 'auto' | 'manual'; lowEPS: string;
  lowMethod: LowPriceMethod; manualLow: string; zoneSplit: ZoneSplit;
  dividend: string | null; payout: string | null; highYield: string | null;
  desiredRatio: string; targetReturn: string;
};
const defaults: Draft = { highPE: '', lowPE: '', lowEPSMode: 'auto', lowEPS: '', lowMethod: 'pe', manualLow: '', zoneSplit: '25-50-25',
  dividend: null, payout: null, highYield: null, desiredRatio: '3', targetReturn: '15' };
const number = (value: number | null, digits = 2) => value === null ? '—' : new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const percent = (value: number | null) => value === null ? '—' : `${value.toFixed(1)}%`;
const sourceInput = (value: string | null, source: number | null) => value ?? (source === null ? '' : String(source));
function Summary({ title, children }: { title: string; children: ReactNode }) {
  return <aside className="forecast-summary"><h3>{title}</h3><dl>{children}</dl></aside>;
}
function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

export default function RiskReward({ study, current, history, highEPSForecast, epsForecastRate, onEditEPSForecast }: {
  study: Study; current: ReturnType<typeof currentValuation>; history: ValuationRow[];
  highEPSForecast: number | null; epsForecastRate: string; onEditEPSForecast: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({ ...defaults });
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const five = valuationAverage(history, 5);
  const compatible = Boolean(study.priceCurrency && study.priceCurrency === study.financialCurrency);
  const currency = study.priceCurrency ?? '';
  const money = (value: number | null) => value === null ? '—' : study.priceCurrency ? new Intl.NumberFormat('en-US', { style: 'currency', currency: study.priceCurrency, currencyDisplay: 'narrowSymbol' }).format(value) : number(value);
  const dividendInput = sourceInput(draft.dividend, study.overview?.IndicatedDividend ?? current.dividend);
  const payoutInput = sourceInput(draft.payout, five.payout ?? current.payout);
  const highYieldInput = sourceInput(draft.highYield, five.highYield);
  const recent = [...history.filter(row => row.periodEnd !== null).slice(-2).map(row => row.low), current.low].filter((value): value is number => value !== null && value > 0);
  const recentLow = recent.length ? Math.min(...recent) : null;
  const lowEPS = draft.lowEPSMode === 'auto' ? current.eps : assumption(draft.lowEPS);
  const model = riskReward({ highPE: assumption(draft.highPE), lowPE: assumption(draft.lowPE), highEPS: compatible ? highEPSForecast : null,
    lowEPS: compatible ? lowEPS : null, currentPrice: current.price, annualDividend: compatible ? assumption(dividendInput) : null,
    payoutPercent: assumption(payoutInput), highYieldPercent: assumption(highYieldInput), averageLow: five.low, recentLow,
    manualLow: assumption(draft.manualLow), lowMethod: draft.lowMethod, zoneSplit: draft.zoneSplit,
    desiredRatio: assumption(draft.desiredRatio), targetReturnPercent: assumption(draft.targetReturn),
  });
  const lowOptions: { key: LowPriceMethod; label: string }[] = [
    { key: 'pe', label: 'Low P/E × low EPS' }, { key: 'recent', label: 'Recent market low' },
    { key: 'average', label: 'Average low price, last 5 years' }, { key: 'dividend', label: 'Dividend-supported price' }, { key: 'manual', label: 'Manual low-price forecast' },
  ];
  const rangePosition = model.validRange && current.price !== null ? Math.max(0, Math.min(100, (current.price - model.lowPrice!) / model.range! * 100)) : null;
  return <>
    <section className="forecast-section" aria-labelledby="risk-reward-title"><div className="fundamentals-title"><h2 id="risk-reward-title">Risk & Reward — Next 5 Years</h2><button className="forecast-reset" onClick={() => setDraft({ ...defaults })}>Reset assumptions</button></div>
      <div className="forecast-section-body forecast-layout"><div className="forecast-workings">
        <div className="forecast-input-grid"><fieldset className="forecast-card"><legend>High-price forecast</legend>
          <label>Forecast average high P/E<input type="number" min="0" step="0.1" value={draft.highPE} placeholder="Enter P/E" onChange={event => set('highPE', event.target.value)}/></label>
          <div className="forecast-reference">5-year average: {number(five.highPE, 1)}{five.highPE !== null && <button onClick={() => set('highPE', five.highPE!.toFixed(2))}>Use average</button>}</div>
          <label>High EPS forecast<output data-testid="high-eps-forecast" title={highEPSForecast === null ? undefined : String(highEPSForecast)}>{number(highEPSForecast)}</output></label>
          <button className="forecast-link" onClick={onEditEPSForecast}>{epsForecastRate.trim() ? `Linked EPS growth: ${epsForecastRate}%/yr · Edit in Fundamentals` : 'Set EPS forecast in Analyzing Fundamentals'}</button>
          <div className="forecast-price-result"><span>Forecast high price</span><output data-testid="forecast-high-price">{money(model.highPrice)}</output></div>
        </fieldset><fieldset className="forecast-card"><legend>Low-price forecast</legend>
          <label>Forecast average low P/E<input type="number" min="0" step="0.1" value={draft.lowPE} placeholder="Enter P/E" onChange={event => set('lowPE', event.target.value)}/></label>
          <div className="forecast-reference">5-year average: {number(five.lowPE, 1)}{five.lowPE !== null && <button onClick={() => set('lowPE', five.lowPE!.toFixed(2))}>Use average</button>}</div>
          <label>Low EPS update method<select value={draft.lowEPSMode} onChange={event => set('lowEPSMode', event.target.value as Draft['lowEPSMode'])}><option value="auto">Auto-update to current / TTM EPS</option><option value="manual">Manual EPS</option></select></label>
          {draft.lowEPSMode === 'manual' ? <label>Low EPS forecast<input type="number" min="0" step="0.01" value={draft.lowEPS} onChange={event => set('lowEPS', event.target.value)}/></label> : <label>Low EPS forecast<output>{number(lowEPS)}</output></label>}
          <div className="forecast-price-result"><span>P/E-based low price</span><output>{money(model.candidates.pe)}</output></div>
        </fieldset></div>
        {!compatible && <p className="forecast-help">P/E-based prices require matching price and reporting currencies.</p>}
        <fieldset className="forecast-low-options"><legend>Select forecast low price</legend>{lowOptions.map(option => {
          const unavailable = ['recent', 'average', 'dividend'].includes(option.key) && model.candidates[option.key] === null;
          return <div className="forecast-low-option" key={option.key}><label><input type="radio" name="forecast-low-method" value={option.key} checked={draft.lowMethod === option.key} disabled={unavailable} onChange={() => set('lowMethod', option.key)}/>{option.label}</label>{option.key === 'manual' ? <input aria-label="Manual low-price forecast" type="number" min="0" step="0.01" value={draft.manualLow} placeholder={currency} onChange={event => set('manualLow', event.target.value)}/> : <output>{money(model.candidates[option.key])}</output>}</div>;
        })}<div className="forecast-option-detail"><label>Forecast high yield (%)<input type="number" min="0" step="0.1" value={highYieldInput} onChange={event => set('highYield', event.target.value)}/></label><span>Dividend support = annual dividend ÷ yield.</span></div>
          <div className="forecast-price-result"><span>Selected forecast low price</span><output data-testid="forecast-low-price">{money(model.lowPrice)}</output></div>
        </fieldset>
        <div className="forecast-zoning"><div className="forecast-zoning-heading"><h3>Price zones</h3><label>Zone split<select value={draft.zoneSplit} onChange={event => set('zoneSplit', event.target.value as ZoneSplit)}><option value="25-50-25">25% / 50% / 25%</option><option value="thirds">Equal thirds</option></select></label></div>
          {model.validRange ? <><div className="forecast-zone-bar"><span style={{ flex: 1 }}>Buy</span><span style={{ flex: draft.zoneSplit === 'thirds' ? 1 : 2 }}>Hold</span><span style={{ flex: 1 }}>Sell</span>{rangePosition !== null && <i style={{ left: `${rangePosition}%` }} title={`Current price: ${money(current.price)}`}/>}</div><div className="forecast-zone-ranges" style={{ gridTemplateColumns: draft.zoneSplit === 'thirds' ? 'repeat(3,minmax(0,1fr))' : '1fr 2fr 1fr' }}><span>{money(model.lowPrice)} – {money(model.buyUpper)}</span><span>{money(model.buyUpper)} – {money(model.sellLower)}</span><span>{money(model.sellLower)} – {money(model.highPrice)}</span></div></> : <p className="forecast-help">{model.zone === 'Check forecasts' ? 'The forecast high price must exceed the selected low price.' : 'Enter P/E forecasts and an EPS growth forecast to calculate zones.'}</p>}
          <details className="gain-loss-details"><summary>Gain vs. loss</summary>{model.validRange && current.price !== null && current.price > model.lowPrice! && current.price < model.highPrice! ? <><div className="gain-loss-meter"><span style={{ flex: current.price - model.lowPrice! }}>Potential loss {money(current.price - model.lowPrice!)}</span><span style={{ flex: model.highPrice! - current.price }}>Potential gain {money(model.highPrice! - current.price)}</span></div><p className="forecast-help">Upside/downside = (high − current) ÷ (current − low).</p></> : <p className="forecast-help">Gain/loss comparison requires a current price inside a valid forecast range.</p>}</details>
        </div>
      </div><Summary title="Risk at a glance"><SummaryRow label="Zone" value={<span className="forecast-zone" data-zone={model.zone}>{model.zone}</span>}/><SummaryRow label="Forecast high price" value={money(model.highPrice)}/><SummaryRow label="Forecast low price" value={money(model.lowPrice)}/><SummaryRow label="Current price" value={money(current.price)}/><SummaryRow label="Upside / downside" value={model.upsideDownside === null ? '—' : `${number(model.upsideDownside)} : 1`}/><SummaryRow label="5-year price appreciation" value={percent(model.appreciation)}/></Summary></div>
    </section>
    <section className="forecast-section" aria-labelledby="five-year-potential-title"><div className="fundamentals-title"><h2 id="five-year-potential-title">Five-Year Potential</h2></div><div className="forecast-section-body forecast-layout"><div>
      <div className="forecast-assumptions"><label>Annual dividend / share<input type="number" min="0" step="0.01" value={dividendInput} onChange={event => set('dividend', event.target.value)}/></label><label>Forecast average payout (%)<input type="number" min="0" step="0.1" value={payoutInput} onChange={event => set('payout', event.target.value)}/></label><label>Target upside/downside<input type="number" min="0" step="0.1" value={draft.desiredRatio} onChange={event => set('desiredRatio', event.target.value)}/></label><label>Target annual return (%)<input type="number" min="0" step="0.1" value={draft.targetReturn} onChange={event => set('targetReturn', event.target.value)}/></label></div>
      <div className="forecast-current-yield">Current yield <strong>{percent(model.currentYield)}</strong><span>Annual dividend ÷ current price</span></div>
      <div className="financial-table-scroll"><table className="forecast-return-table"><thead><tr><th scope="col">5-year scenario</th><th scope="col">High P/E</th><th scope="col">Average P/E</th></tr></thead><tbody><tr><th scope="row">Forecast P/E</th><td>{number(assumption(draft.highPE), 1)}</td><td>{number(model.averagePE, 1)}</td></tr><tr><th scope="row">Forecast price</th><td>{money(model.highPrice)}</td><td>{money(model.averagePrice)}</td></tr><tr><th scope="row">Annualized price appreciation</th><td>{percent(model.highReturns.priceCAGR)}</td><td>{percent(model.averageReturns.priceCAGR)}</td></tr><tr><th scope="row">Estimated average yield</th><td>{percent(model.highReturns.averageYield)}</td><td>{percent(model.averageReturns.averageYield)}</td></tr><tr className="forecast-return-total"><th scope="row">Estimated annual return</th><td>{percent(model.highReturns.annualReturn)}</td><td>{percent(model.averageReturns.annualReturn)}</td></tr></tbody></table></div>
      <p className="forecast-help">Annual return estimate = price CAGR + payout-based yield; dividend reinvestment is not modeled.</p>
    </div><Summary title="Potential at a glance"><SummaryRow label="Zone" value={<span className="forecast-zone" data-zone={model.zone}>{model.zone}</span>}/><SummaryRow label="Upside / downside" value={model.upsideDownside === null ? '—' : `${number(model.upsideDownside)} : 1`}/><SummaryRow label="Annual return, high P/E" value={percent(model.highReturns.annualReturn)}/><SummaryRow label="Annual return, average P/E" value={percent(model.averageReturns.annualReturn)}/><SummaryRow label="Buy price meeting both targets" value={money(model.buyPrice)}/><SummaryRow label="Buy-zone ceiling" value={money(model.buyUpper)}/><SummaryRow label="Current price" value={money(current.price)}/></Summary></div></section>
  </>;
}
