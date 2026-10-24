/** Explicit overrides only. null/omitted means calculate from fresh provider data. */
export const numericInputs = {
  sales_growth_percent: -100, eps_growth_percent: -100,
  manual_high_price: 0.01, high_pe: 0, manual_low_price: 0, low_pe: 0, low_eps: 0,
  annual_dividend: 0, payout_percent: 0, high_yield_percent: 0,
  desired_ratio: 0, target_return_percent: -100,
} as const;
export const choiceInputs = {
  high_price_method: ['pe', 'manual'], low_price_method: ['pe', 'recent', 'average', 'dividend', 'manual'],
  low_eps_mode: ['auto', 'manual'], zone_split: ['25-50-25', 'thirds'],
} as const;
type ChoiceInputs = { [K in keyof typeof choiceInputs]?: (typeof choiceInputs)[K][number] | null };
export type StudyUserValues = Partial<Record<keyof typeof numericInputs, number | null>> & ChoiceInputs & {
  title?: string | null; notes?: string | null;
  high_pe_years?: 5 | 10 | null; low_pe_years?: 5 | 10 | null;
  excluded_years?: number[]; excluded_values?: string[];
  management_excluded_years?: number[]; management_excluded_values?: string[];
};
export type StudySelection = { ticker: string; cik: number };
export type NewSavedStudy = StudySelection & StudyUserValues;
export type SavedStudy = StudySelection & Required<StudyUserValues> & {
  id: string; user_id: string; created_at: string; updated_at: string;
};

const arrayInputs = ['excluded_years', 'excluded_values', 'management_excluded_years', 'management_excluded_values'];
const allowed = new Set([...Object.keys(numericInputs), ...Object.keys(choiceInputs), ...arrayInputs, 'title', 'notes', 'high_pe_years', 'low_pe_years', 'ticker', 'cik']);

/** Runtime allowlist: never spread a fetched Study/StudyDocument into a cloud row. */
export function validateStudyValues(input: unknown): Partial<NewSavedStudy> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected study inputs.');
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) throw new Error(`Unsupported study input: ${key}`);
    if (value === undefined) continue;
    let valid = false;
    if (key === 'ticker') valid = typeof value === 'string' && /^[A-Z0-9][A-Z0-9.\-]{0,14}$/.test(value);
    else if (key === 'cik') valid = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 9_999_999_999;
    else if (key in numericInputs) valid = value === null || (typeof value === 'number' && Number.isFinite(value) && value >= numericInputs[key as keyof typeof numericInputs]);
    else if (key in choiceInputs) valid = value === null || (typeof value === 'string' && (choiceInputs[key as keyof typeof choiceInputs] as readonly string[]).includes(value));
    else if (key === 'title' || key === 'notes') valid = value === null || (typeof value === 'string' && value.length <= (key === 'title' ? 160 : 20_000));
    else if (key === 'high_pe_years' || key === 'low_pe_years') valid = value === null || value === 5 || value === 10;
    else if (arrayInputs.includes(key)) {
      valid = Array.isArray(value) && value.length <= 500 && (key.endsWith('_years')
        ? value.every(item => Number.isInteger(item) && item >= 1800 && item <= 2300)
        : value.every(item => typeof item === 'string' && /^[a-zA-Z][a-zA-Z0-9]*:(?:18|19|20|21|22|23)\d{2}$/.test(item)));
      if (valid) { output[key] = [...new Set(value as unknown[])]; continue; }
    }
    if (!valid) throw new Error(`Invalid study input: ${key}`);
    output[key] = value;
  }
  return output as Partial<NewSavedStudy>;
}
