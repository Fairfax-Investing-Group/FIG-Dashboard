import type { StudyDocument } from '../types';

type SnapshotIndex = { studies: { ticker: string; id: string; file: string }[] };

async function readJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Static study data is unavailable (${response.status}).`);
  return response.json() as Promise<T>;
}

export async function loadStaticStudy(identifier: string, signal?: AbortSignal): Promise<StudyDocument> {
  const base = (import.meta.env ?? {}).BASE_URL ?? '/';
  const index = await readJson<SnapshotIndex>(`${base}studies/index.json`, signal);
  const study = index.studies.find(item => item.ticker.toLowerCase() === identifier.toLowerCase() || item.id === identifier);
  if (!study) throw new Error('GitHub-hosted study snapshots cover the current portfolio holdings. Live study generation for other tickers needs a study API.');
  const document = await readJson<StudyDocument>(`${base}${study.file.replace(/^\//, '')}`, signal);
  if (document.SchemaVersion !== 1 || document.Study.StudyID !== study.id) throw new Error('The hosted study snapshot is invalid.');
  return document;
}
