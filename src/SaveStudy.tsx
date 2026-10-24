import { useRef, useState } from 'react';
import { useAuth } from './auth/AuthProvider';
import LoginForm from './auth/LoginForm';
import { useStudyInputs } from './StudyInputsContext';
import { createStudyRepository } from './lib/studyRepository';
import type { Study } from './types';
import type { SavedStudy } from './lib/studyInputs';

const repository = createStudyRepository();
const date = (value: string) => new Date(value).toLocaleString();
export default function SaveStudy({ study }: { study: Study }) {
  const auth = useAuth();
  const inputs = useStudyInputs();
  const [saved, setSaved] = useState<SavedStudy | undefined>(inputs?.initial);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const own = saved?.user_id === auth.session?.user.id ? saved : undefined;
  async function save() {
    if (lock.current || !auth.session || !inputs) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const values = { ...inputs.collect(), ticker: study.company.ticker, cik: study.company.cik };
      const result = own ? await repository.update(own.id, values)
        : await repository.create({ ...values, study_made_at: inputs.initial?.study_made_at ?? study.createdAt });
      setSaved(result);
      inputs.record.current = result;
    } catch (cause) {
      const detail = cause && typeof cause === 'object' && 'message' in cause ? String(cause.message) : 'Please try again.';
      setError(/schema cache|does not exist|study_made_at/i.test(detail)
        ? 'Study storage needs its database migration. Apply the Supabase study migrations, then retry.'
        : `Could not save study. ${detail}`);
    } finally { lock.current = false; setBusy(false); }
  }
  return <section className="study-save" aria-label="Save study">
    <button type="button" className="export-button" onClick={() => auth.session ? void save() : setShowLogin(value => !value)} disabled={busy || auth.loading || !study.company.cik}>{busy ? 'Saving…' : !auth.session ? 'Log in to save' : own ? 'Save changes' : 'Save study'}</button>
    {!auth.session && showLogin && <div className="study-save-login"><LoginForm compact/></div>}
    <span role="status">{own && <>By {auth.session?.user.email || own.user_id} · Made {date(own.study_made_at ?? own.created_at)} · Saved {date(own.updated_at)}</>}</span>
    {error && <span role="alert" className="auth-error">{error}</span>}
  </section>;
}
