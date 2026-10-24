import { useEffect, useRef, useState } from 'react';
import { useAuth } from './auth/AuthProvider';
import { createStudyRepository } from './lib/studyRepository';
import type { SavedStudy } from './lib/studyInputs';

const repository = createStudyRepository();
type Summary = Pick<SavedStudy, 'id' | 'user_id' | 'ticker' | 'cik' | 'title' | 'created_at' | 'updated_at' | 'study_made_at'>;
export default function SavedStudies({ onOpen }: { onOpen: (study: SavedStudy) => void }) {
  const { session, loading: authLoading } = useAuth();
  const userId = session?.user.id;
  const [result, setResult] = useState<{ owner: string; rows: Summary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  useEffect(() => {
    if (!userId) return;
    let active = true;
    setError(null);
    repository.list().then(rows => { if (active) setResult({ owner: userId, rows: rows ?? [] }); })
      .catch(() => { if (active) setError('Saved studies could not be loaded. Check the Supabase study migrations and try again.'); });
    return () => { active = false; };
  }, [userId, retry]);
  const generation = useRef(0);
  // Invalidate in-flight opens when the account changes or search unmounts.
  useEffect(() => { return () => { generation.current++; }; }, [userId]);
  async function open(id: string) {
    if (opening) return;
    const current = generation.current;
    setOpening(id); setError(null);
    try {
      const saved = await repository.get(id);
      if (current !== generation.current) return;
      if (!saved) throw new Error('Study not found.');
      onOpen(saved);
    } catch { if (current === generation.current) setError('Could not open the saved study. Please try again.'); }
    finally { if (current === generation.current) setOpening(null); }
  }
  const rows = result?.owner === userId ? result?.rows : undefined;
  const message = authLoading ? 'Checking your account…' : !userId ? 'Log in above to view your saved studies.'
    : error ? 'Saved studies are unavailable. Please retry.' : !rows ? 'Loading saved studies…'
    : !rows.length ? 'Your saved studies will appear here.' : null;
  return <section className="saved-studies portfolio-panel" aria-labelledby="saved-studies-title">
    <div className="portfolio-panel-heading"><h2 id="saved-studies-title">Saved studies</h2></div>
    {userId && error && <p role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
    <div className="portfolio-table-scroll"><table className="portfolio-table saved-studies-table">
      <caption className="sr-only">Your saved study inputs, creators, and dates</caption>
      <thead><tr><th scope="col">Company / Study</th><th scope="col">Made by</th><th scope="col">Study date</th><th scope="col">Last saved</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{message ? <tr><td colSpan={5}><span role="status">{message}</span></td></tr> : rows?.map(row => <tr key={row.id}>
        <th scope="row"><strong>{row.ticker}</strong>{row.title && <span className="saved-study-title">{row.title}</span>}</th>
        <td>{row.user_id === userId ? session?.user.email || row.user_id : row.user_id}</td>
        <td><time dateTime={row.study_made_at ?? row.created_at}>{new Date(row.study_made_at ?? row.created_at).toLocaleString()}</time></td>
        <td><time dateTime={row.updated_at}>{new Date(row.updated_at).toLocaleString()}</time></td>
        <td><button type="button" aria-label={`Open saved study for ${row.ticker}`} disabled={Boolean(opening)} onClick={() => void open(row.id)}>{opening === row.id ? 'Opening…' : 'Open study'}</button></td>
      </tr>)}</tbody>
    </table></div>
    <p className="portfolio-table-note">Saved inputs reopen with fresh company data.</p>
  </section>;
}
