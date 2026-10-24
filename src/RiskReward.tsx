import { useState, type ReactNode } from 'react';
import type { Study } from './types';
import { currentValuation, valuationAverage, type ValuationRow } from './valuationMath';
import { assumption, riskReward, type LowPriceMethod, type ZoneSplit } from './riskRewardMath';

type Draft = {
  highMethod: 'pe' | 'manual'; manualHigh: string;
  highPE: string; lowPE: string; lowEPSMode: 'auto' | 'manual'; lowEPS: string;
  highPEYears: 5 | 10 | null; lowPEYears: 5 | 10 | null;
  lowMethod: LowPriceMethod; manualLow: string; zoneSplit: ZoneSplit;
  dividend: string | null; payout: string | null; highYield: string | null;
  desiredRatio: string | null; targetReturn: string | null;
};
const defaults: Draft = { highMethod: 'pe', manualHigh: '', highPE: '', lowPE: '', highPEYears: null, lowPEYears: null, lowEPSMode: 'auto', lowEPS: '', lowMethod: 'pe', manualLow: '', zoneSplit: '25-50-25',
  dividend: null, payout: null, highYield: null, desiredRatio: null, targetReturn: null };
const number = (value: number | null, digits = 2) => value === null ? '—' : new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const percent = (value: number | null) => value === null ? '—' : `${value.toFixed(1)}%`;
const sourceInput = (value: string | null, source: number | null) => value ?? (source === null ? '' : String(source));
function Summary({ title, children }: { title: string; children: ReactNode }) {
  return <aside className="forecast-summary"><h3>{title}</h3><dl>{children}</dl></aside>;
}
function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
function PEReferences({ kind, five, ten, selected, onSelect }: { kind: 'high' | 'low'; five: number | null; ten: number | null; selected: 5 | 10 | null; onSelect: (years: 5 | 10) => void }) {
  return <>{([5, 10] as const).map(years => {
    const value = years === 5 ? five : ten;
    return <div className="forecast-reference" key={years}>{years}-year average: {number(value, 1)}<button type="button" aria-label={`Use ${years}-year average ${kind} P/E`} aria-pressed={selected === years} disabled={value === null} onClick={() => onSelect(years)}>{selected === years ? 'Linked' : 'Use average'}</button></div>;
  })}</>;
}

export default function RiskReward({ study, current, history, highEPSForecast, epsForecastRate, onEditEPSForecast }: {
  study: Study; current: ReturnType<typeof currentValuation>; history: ValuationRow[];
  highEPSForecast: number | null; epsForecastRate: string; onEditEPSForecast: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({ ...defaults });
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const five = valuationAverage(history, 5);
  const ten = valuationAverage(history, 10);
  const averageInput = (value: number | null) => value === null ? '' : value.toFixed(2);
  const highPEInput = draft.highPEYears === null ? draft.highPE : averageInput((draft.highPEYears === 5 ? five : ten).highPE);
  const lowPEInput = draft.lowPEYears === null ? draft.lowPE : averageInput((draft.lowPEYears === 5 ? five : ten).lowPE);
  const compatible = Boolean(study.priceCurrency && study.priceCurrency === study.financialCurrency);
  const currency = study.priceCurrency ?? '';
  const money = (value: number | null) => value === null ? '—' : study.priceCurrency ? new Intl.NumberFormat('en-US', { style: 'currency', currency: study.priceCurrency, currencyDisplay: 'narrowSymbol' }).format(value) : number(value);
  const dividendInput = sourceInput(draft.dividend, five.dividend);
  const payoutInput = sourceInput(draft.payout, five.payout ?? current.payout);
  const highYieldInput = sourceInput(draft.highYield, five.highYield);
  const recent = [...history.filter(row => row.periodEnd !== null).slice(-2).map(row => row.low), current.low].filter((value): value is number => value !== null && value > 0);
  const recentLow = recent.length ? Math.min(...recent) : null;
  const lowEPS = draft.lowEPSMode === 'auto' ? current.eps : assumption(draft.lowEPS);
  const scenarioInputs = { highPE: assumption(highPEInput), lowPE: assumption(lowPEInput), highEPS: compatible ? highEPSForecast : null,
    highMethod: draft.highMethod, manualHigh: assumption(draft.manualHigh),
    lowEPS: compatible ? lowEPS : null, currentPrice: current.price, annualDividend: compatible ? assumption(dividendInput) : null,
    payoutPercent: assumption(payoutInput), highYieldPercent: assumption(highYieldInput), averageLow: five.low, recentLow,
    manualLow: assumption(draft.manualLow), lowMethod: draft.lowMethod, zoneSplit: draft.zoneSplit,
    desiredRatio: null, targetReturnPercent: null,
  };
  // Targets affect the buy-price ceiling, so derive defaults from the scenario
  // before applying either target. Manual edits remain separate from defaults.
  const scenario = riskReward(scenarioInputs);
  const calculatedInput = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0 ? value.toFixed(2) : '';
  const desiredRatioInput = draft.desiredRatio ?? calculatedInput(scenario.upsideDownside);
  const targetReturnInput = draft.targetReturn ?? calculatedInput(scenario.highReturns.annualReturn);
  const model = riskReward({ ...scenarioInputs, desiredRatio: assumption(desiredRatioInput), targetReturnPercent: assumption(targetReturnInput) });
  const lowOptions: { key: LowPriceMethod; label: string }[] = [
    { key: 'pe', label: 'Low P/E × low EPS' }, { key: 'recent', label: 'Recent market low' },
    { key: 'average', label: 'Average low price, last 5 years' }, { key: 'dividend', label: 'Dividend-supported price' }, { key: 'manual', label: 'Manual low-price forecast' },
  ];
  const rangePosition = model.validRange && current.price !== null ? Math.max(0, Math.min(100, (current.price - model.lowPrice!) / model.range! * 100)) : null;
  return <>
    <section className="forecast-section" aria-labelledby="risk-reward-title"><div className="fundamentals-title"><h2 id="risk-reward-title">Risk & Reward — Next 5 Years</h2><button className="forecast-reset" onClick={() => setDraft({ ...defaults })}>Reset assumptions</button></div>
      <div className="forecast-section-body forecast-layout"><div className="forecast-workings">
        <div className="forecast-input-grid"><fieldset className="forecast-card"><legend>High-price forecast</legend>
          <label>High-price method<select value={draft.highMethod} onChange={event => set('highMethod', event.target.value as Draft['highMethod'])}><option value="pe">Calculate from P/E × EPS</option><option value="manual">Enter my own price</option></select></label>
          {draft.highMethod === 'manual' ? <label>My high-price forecast ({currency || 'price'})<input aria-label="Manual high-price forecast" type="number" min="0.01" step="0.01" value={draft.manualHigh} placeholder="Enter price" onChange={event => set('manualHigh', event.target.value)}/></label> : <><label>Forecast average high P/E<input type="number" min="0" step="0.1" value={highPEInput} placeholder="Enter P/E" onChange={event => setDraft(previous => ({ ...previous, highPE: event.target.value, highPEYears: null }))}/></label>
          <PEReferences kind="high" five={five.highPE} ten={ten.highPE} selected={draft.highPEYears} onSelect={years => set('highPEYears', years)}/>
          <label>High EPS forecast<output data-testid="high-eps-forecast" title={highEPSForecast === null ? undefined : String(highEPSForecast)}>{number(highEPSForecast)}</output></label>
          <button className="forecast-link" onClick={onEditEPSForecast}>{epsForecastRate.trim() ? `Linked EPS growth: ${epsForecastRate}%/yr · Edit in Fundamentals` : 'Set EPS forecast in Analyzing Fundamentals'}</button></>}
          <div className="forecast-price-result"><span>Forecast high price</span><output data-testid="forecast-high-price">{money(model.highPrice)}</output></div>
        </fieldset><fieldset className="forecast-card"><legend>Low-price forecast</legend>
          <label>Low-price method<select value={draft.lowMethod} onChange={event => set('lowMethod', event.target.value as LowPriceMethod)}>{lowOptions.map(option => <option key={option.key} value={option.key} disabled={['recent', 'average', 'dividend'].includes(option.key) && model.candidates[option.key] === null}>{option.key === 'manual' ? 'Enter my own price' : option.label}</option>)}</select></label>
          {draft.lowMethod === 'manual' ? <label>My low-price forecast ({currency || 'price'})<input aria-label="Manual low-price forecast" type="number" min="0" step="0.01" value={draft.manualLow} placeholder="Enter price" onChange={event => set('manualLow', event.target.value)}/></label> : <><label>Forecast average low P/E<input type="number" min="0" step="0.1" value={lowPEInput} placeholder="Enter P/E" onChange={event => setDraft(previous => ({ ...previous, lowPE: event.target.value, lowPEYears: null }))}/></label>
          <PEReferences kind="low" five={five.lowPE} ten={ten.lowPE} selected={draft.lowPEYears} onSelect={years => set('lowPEYears', years)}/>
          <label>Low EPS update method<select value={draft.lowEPSMode} onChange={event => set('lowEPSMode', event.target.value as Draft['lowEPSMode'])}><option value="auto">Auto-update to current / TTM EPS</option><option value="manual">Manual EPS</option></select></label>
          {draft.lowEPSMode === 'manual' ? <label>Low EPS forecast<input type="number" min="0" step="0.01" value={draft.lowEPS} onChange={event => set('lowEPS', event.target.value)}/></label> : <label>Low EPS forecast<output>{number(lowEPS)}</output></label>}
          <div className="forecast-price-result"><span>P/E-based low price</span><output>{money(model.candidates.pe)}</output></div></>}
          {draft.lowMethod === 'dividend' && <label>Forecast high yield (%)<input type="number" min="0" step="0.1" value={highYieldInput} onChange={event => set('highYield', event.target.value)}/></label>}
          <div className="forecast-price-result"><span>Forecast low price</span><output data-testid="forecast-low-price">{money(model.lowPrice)}</output></div>
          <p className="forecast-help">52-week low: {money(current.low)}</p>
        </fieldset></div>
        {!compatible && <p className="forecast-help">P/E-based prices require matching price and reporting currencies.</p>}
        <div className="forecast-zoning"><div className="forecast-zoning-heading"><h3>Price zones</h3><label>Zone split<select value={draft.zoneSplit} onChange={event => set('zoneSplit', event.target.value as ZoneSplit)}><option value="25-50-25">25% / 50% / 25%</option><option value="thirds">Equal thirds</option></select></label></div>
          {model.validRange ? <><div className="forecast-zone-bar"><span style={{ flex: 1 }}>Buy</span><span style={{ flex: draft.zoneSplit === 'thirds' ? 1 : 2 }}>Hold</span><span style={{ flex: 1 }}>Sell</span>{rangePosition !== null && <i style={{ left: `${rangePosition}%` }} title={`Current price: ${money(current.price)}`}/>}</div><div className="forecast-zone-ranges" style={{ gridTemplateColumns: draft.zoneSplit === 'thirds' ? 'repeat(3,minmax(0,1fr))' : '1fr 2fr 1fr' }}><span>{money(model.lowPrice)} – {money(model.buyUpper)}</span><span>{money(model.buyUpper)} – {money(model.sellLower)}</span><span>{money(model.sellLower)} – {money(model.highPrice)}</span></div></> : <p className="forecast-help">{model.zone === 'Check forecasts' ? 'The forecast high price must exceed the selected low price.' : 'Set high- and low-price forecasts using your own prices or the calculation methods above.'}</p>}
          <details className="gain-loss-details"><summary>Gain vs. loss</summary>{model.validRange && current.price !== null && current.price > model.lowPrice! && current.price < model.highPrice! ? <><div className="gain-loss-meter"><span style={{ flex: current.price - model.lowPrice! }}>Potential loss {money(current.price - model.lowPrice!)}</span><span style={{ flex: model.highPrice! - current.price }}>Potential gain {money(model.highPrice! - current.price)}</span></div><p className="forecast-help">Upside/downside = (high − current) ÷ (current − low).</p></> : <p className="forecast-help">Gain/loss comparison requires a current price inside a valid forecast range.</p>}</details>
        </div>
      </div><Summary title="Risk at a glance"><SummaryRow label="Zone" value={<span className="forecast-zone" data-zone={model.zone}>{model.zone}</span>}/><SummaryRow label="Forecast high price" value={money(model.highPrice)}/><SummaryRow label="Forecast low price" value={money(model.lowPrice)}/><SummaryRow label="Current price" value={money(current.price)}/><SummaryRow label="Upside / downside" value={model.upsideDownside === null ? '—' : `${number(model.upsideDownside)} : 1`}/><SummaryRow label="5-year price appreciation" value={percent(model.appreciation)}/></Summary></div>
    </section>
    <section className="forecast-section" aria-labelledby="five-year-potential-title"><div className="fundamentals-title"><h2 id="five-year-potential-title">Five-Year Potential</h2></div><div className="forecast-section-body forecast-layout"><div>
      <div className="forecast-assumptions"><label>Annual dividend / share<input type="number" min="0" step="0.01" value={dividendInput} onChange={event => set('dividend', event.target.value)}/></label><label>Forecast average payout (%)<input type="number" min="0" step="0.1" value={payoutInput} onChange={event => set('payout', event.target.value)}/></label><label>Target upside/downside<input type="number" min="0" step="0.1" value={desiredRatioInput} onChange={event => set('desiredRatio', event.target.value)}/></label><label>Target annual return (%)<input type="number" min="0" step="0.1" value={targetReturnInput} onChange={event => set('targetReturn', event.target.value)}/></label></div>
      <p className="forecast-help">Annual dividend/share starts from the 5-year average dividend/share, including exclusions. Payout starts from the 5-year average, or current payout when unavailable. Targets start from the calculated upside/downside and annual return when available. Edit any field to use your own assumption; Reset assumptions restores automatic values.</p>
      <div className="forecast-current-yield">Current yield <strong>{percent(model.currentYield)}</strong><span>Annual dividend ÷ current price</span></div>
      <div className="financial-table-scroll"><table className="forecast-return-table"><thead><tr><th scope="col">5-year scenario</th><th scope="col">{draft.highMethod === 'manual' ? 'My high price' : 'High P/E'}</th><th scope="col">Average P/E</th></tr></thead><tbody><tr><th scope="row">Forecast P/E</th><td>{number(model.forecastHighPE, 1)}</td><td>{number(model.averagePE, 1)}</td></tr><tr><th scope="row">Forecast price</th><td>{money(model.highPrice)}</td><td>{money(model.averagePrice)}</td></tr><tr><th scope="row">Annualized price appreciation</th><td>{percent(model.highReturns.priceCAGR)}</td><td>{percent(model.averageReturns.priceCAGR)}</td></tr><tr><th scope="row">Estimated average yield</th><td>{percent(model.highReturns.averageYield)}</td><td>{percent(model.averageReturns.averageYield)}</td></tr><tr className="forecast-return-total"><th scope="row">Estimated annual return</th><td>{percent(model.highReturns.annualReturn)}</td><td>{percent(model.averageReturns.annualReturn)}</td></tr></tbody></table></div>
      <p className="forecast-help">Annual return estimate = price CAGR + payout-based yield; dividend reinvestment is not modeled.</p>
    </div><Summary title="Potential at a glance"><SummaryRow label="Zone" value={<span className="forecast-zone" data-zone={model.zone}>{model.zone}</span>}/><SummaryRow label="Upside / downside" value={model.upsideDownside === null ? '—' : `${number(model.upsideDownside)} : 1`}/><SummaryRow label={draft.highMethod === 'manual' ? 'Annual return, my high price' : 'Annual return, high P/E'} value={percent(model.highReturns.annualReturn)}/><SummaryRow label="Annual return, average P/E" value={percent(model.averageReturns.annualReturn)}/><SummaryRow label="Buy price meeting both targets" value={money(model.buyPrice)}/><SummaryRow label="Buy-zone ceiling" value={money(model.buyUpper)}/><SummaryRow label="Current price" value={money(current.price)}/></Summary></div></section>
  </>;
}
