import type { StudyUserValues } from './studyInputs';
import type { LowPriceMethod, ZoneSplit } from '../riskRewardMath';
export type Draft = {
  highMethod: 'pe' | 'manual'; manualHigh: string;
  highPE: string; lowPE: string; lowEPSMode: 'auto' | 'manual'; lowEPS: string;
  highPEYears: 5 | 10 | null; lowPEYears: 5 | 10 | null;
  lowMethod: LowPriceMethod; manualLow: string; zoneSplit: ZoneSplit;
  dividend: string | null; payout: string | null; highYield: string | null;
  desiredRatio: string | null; targetReturn: string | null;
};
export const defaults: Draft = { highMethod: 'pe', manualHigh: '', highPE: '', lowPE: '', highPEYears: null, lowPEYears: null, lowEPSMode: 'auto', lowEPS: '', lowMethod: 'pe', manualLow: '', zoneSplit: '25-50-25',
  dividend: null, payout: null, highYield: null, desiredRatio: null, targetReturn: null };

const fields = {
  manualHigh: 'manual_high_price', highPE: 'high_pe', lowPE: 'low_pe', lowEPS: 'low_eps',
  manualLow: 'manual_low_price', dividend: 'annual_dividend', payout: 'payout_percent',
  highYield: 'high_yield_percent', desiredRatio: 'desired_ratio', targetReturn: 'target_return_percent',
} as const;
const choices = { highMethod: 'high_price_method', lowMethod: 'low_price_method', lowEPSMode: 'low_eps_mode', zoneSplit: 'zone_split' } as const;
export function draftFromValues(values?: StudyUserValues): Draft {
  const draft = { ...defaults };
  if (!values) return draft;
  for (const [key, field] of Object.entries(fields)) {
    const value = values[field];
    if (value != null) Object.assign(draft, { [key]: String(value) });
  }
  for (const [key, field] of Object.entries(choices)) {
    if (values[field] != null) Object.assign(draft, { [key]: values[field] });
  }
  draft.highPEYears = values.high_pe_years ?? null;
  draft.lowPEYears = values.low_pe_years ?? null;
  return draft;
}
export function draftToValues(draft: Draft): StudyUserValues {
  const values: StudyUserValues = {};
  for (const [key, field] of Object.entries(fields)) {
    const value = draft[key as keyof typeof fields];
    values[field] = value === null || !value.trim() ? null : Number(value);
  }
  for (const [key, field] of Object.entries(choices)) {
    Object.assign(values, { [field]: draft[key as keyof typeof choices] === defaults[key as keyof typeof choices] ? null : draft[key as keyof typeof choices] });
  }
  values.high_pe_years = draft.highPEYears;
  values.low_pe_years = draft.lowPEYears;
  // Linked references retain their period selection, never a calculated value.
  if (draft.highPEYears !== null) values.high_pe = null;
  if (draft.lowPEYears !== null) values.low_pe = null;
  return values;
}
