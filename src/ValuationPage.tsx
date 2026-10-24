import { ExclusionYear, ExclusionValue, ExclusionHelp, isValueExcluded, type TableExclusions } from './ExclusionControls';
import { useState } from 'react';
import type { AnnualRow, MarketQuote, Study } from './types';
import { currentValuation, valuationAverage, valuationRows, type ValuationRow } from './valuationMath';
import RiskReward from './RiskReward';

const valueColumns = [
  { key: 'high', metric: 'highPrice', name: 'High price', digits: 1 },
  { key: 'low', metric: 'lowPrice', name: 'Low price', digits: 1 },
  { key: 'eps', metric: 'eps', name: 'Earnings per share', digits: 2 },
  { key: 'highPE', metric: 'highPE', name: 'High P/E', digits: 1 },
  { key: 'lowPE', metric: 'lowPE', name: 'Low P/E', digits: 1 },
  { key: 'dividend', metric: 'dividendPerShare', name: 'Dividend per share', digits: 2 },
  { key: 'payout', metric: 'payout', name: 'Payout', digits: 1 },
  { key: 'highYield', metric: 'highYield', name: 'High yield', digits: 1 },
] as const;
type Values = Omit<ValuationRow, 'year' | 'periodEnd'>;
const number = (value: number | null, digits = 1) => value === null ? '—' : new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const percent = (value: number | null) => value === null ? '—' : `${value.toFixed(1)}%`;
function ValueCells({ row }: { row: Values }) {
  const pe = (value: number | null) => row.eps !== null && row.eps <= 0 ? 'N/M' : number(value);
  return <><td>{number(row.high)}</td><td>{number(row.low)}</td><td>{number(row.eps, 2)}</td><td className="pe-column">{pe(row.highPE)}</td><td className="pe-column">{pe(row.lowPE)}</td><td>{number(row.dividend, 2)}</td><td>{percent(row.payout)}</td><td>{percent(row.highYield)}</td></>;
}

export default function ValuationPage({ study, annual, quote, highEPSForecast, epsForecastRate, onEditEPSForecast, controls }: { study: Study; annual: AnnualRow[]; quote: MarketQuote | null; highEPSForecast: number | null; epsForecastRate: string; onEditEPSForecast: () => void; controls: TableExclusions }) {
  const [years, setYears] = useState<5 | 10>(10);
  const compatible = Boolean(study.priceCurrency && study.priceCurrency === study.financialCurrency);
  const allRows = valuationRows(annual, compatible, 10);
  const rows = allRows.slice(-years);
  const includedRows = allRows.map(row => ({ ...row, ...Object.fromEntries(valueColumns.map(column => [column.key, isValueExcluded(controls, column.metric, row.year) ? null : row[column.key]])) }));
  const five = valuationAverage(includedRows, 5), ten = valuationAverage(includedRows, 10);
  const current = currentValuation(study, annual, quote);
  const averagePE = five.highPE !== null && five.lowPE !== null ? (five.highPE + five.lowPE) / 2 : null;
  return <><section className="valuation-section fundamentals" aria-labelledby="valuation-title">
    <div className="fundamentals-title"><h2 id="valuation-title">Price & Earnings History</h2><fieldset className="valuation-period"><legend className="sr-only">Historical period</legend>{([5, 10] as const).map(value => <label key={value}><input type="radio" name="valuation-years" value={value} checked={years === value} onChange={() => setYears(value)}/>{value} Years</label>)}</fieldset></div>
    <ExclusionHelp controls={controls}/>
    <div className="financial-table-scroll"><table className="valuation-table"><caption className="sr-only">Fiscal-year high and low prices, split-normalized earnings, price-to-earnings ratios, dividends, payout and high yield.</caption>
      <thead><tr className="valuation-group-row"><th scope="col" rowSpan={2}>Year</th><th scope="colgroup" colSpan={2}>Price {study.priceCurrency && `(${study.priceCurrency})`}</th><th scope="col" rowSpan={2}>EPS {study.financialCurrency && `(${study.financialCurrency})`}</th><th scope="colgroup" colSpan={2}>Price / Earnings</th><th scope="col" rowSpan={2}>Dividend / Share</th><th scope="col" rowSpan={2}>Payout</th><th scope="col" rowSpan={2}>High Yield</th></tr><tr><th scope="col">High</th><th scope="col">Low</th><th scope="col">High / EPS</th><th scope="col">Low / EPS</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.year} title={row.periodEnd ? `Fiscal year ended ${row.periodEnd}` : 'No annual report available for this fiscal year'}><th scope="row"><ExclusionYear year={row.year} controls={controls}/></th>{valueColumns.map(column => {
        const value = row[column.key];
        const text = ['highPE', 'lowPE'].includes(column.key) && row.eps !== null && row.eps <= 0 ? 'N/M' : ['payout', 'highYield'].includes(column.key) ? percent(value) : number(value, column.digits);
        return <td key={column.key} className={['highPE', 'lowPE'].includes(column.key) ? 'pe-column' : undefined}><ExclusionValue metric={column.metric} year={row.year} name={column.name} available={value !== null} controls={controls}>{text}</ExclusionValue></td>;
      })}</tr>)}</tbody>
      <tfoot><tr><th scope="row">5 Year Average</th><ValueCells row={five}/></tr>{years === 10 && <tr><th scope="row">10 Year Average</th><ValueCells row={ten}/></tr>}<tr className="valuation-current" title={current.epsSource}><th scope="row">Current / TTM</th><ValueCells row={current}/></tr></tfoot>
    </table>{!annual.length && <p className="table-empty">Annual financial data is unavailable for this study.</p>}</div>
    <div className="valuation-summary"><span>5 Year Average P/E <strong>{number(averagePE)}</strong></span><span title={current.peSource}>Current P/E (TTM) <strong>{number(current.currentPE)}</strong></span></div>
    <p className="valuation-source-note">High/low P/E = fiscal-year high/low price ÷ annual EPS. Current row uses 52-week prices and {current.epsSource.toLowerCase()}. Averages use available observations; — unavailable, N/M nonpositive EPS.{!compatible && ' Historical P/E and yield require matching price and reporting currencies.'}</p>
  </section><RiskReward study={study} current={current} history={allRows} highEPSForecast={highEPSForecast} epsForecastRate={epsForecastRate} onEditEPSForecast={onEditEPSForecast}/></>;
}
