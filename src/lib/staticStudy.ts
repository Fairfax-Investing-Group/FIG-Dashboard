import type { StudyDocument } from '../types';

export type SnapshotEntry = { ticker: string; id: string; file: string; viewFile?: string };
type SnapshotIndex = { studies: SnapshotEntry[] };
let indexRequest: Promise<SnapshotIndex> | undefined;
let indexExpires = 0;
const base = () => (import.meta.env ?? {}).BASE_URL ?? '/';

async function readJson<T>(url: string, signal?: AbortSignal, priority: 'auto' | 'low' = 'auto'): Promise<T> {
  const response = await fetch(url, { signal, priority });
  if (!response.ok) throw new Error(`Static study data is unavailable (${response.status}).`);
  return response.json() as Promise<T>;
}

export async function snapshotIndex(signal?: AbortSignal): Promise<SnapshotIndex> {
  signal?.throwIfAborted();
  if (!indexRequest || Date.now() >= indexExpires) {
    indexExpires = Date.now() + 60_000;
    // One tiny shared request; aborting a caller must not cancel other readers.
    const request = readJson<SnapshotIndex>(`${base()}studies/index.json`, undefined, 'low');
    indexRequest = request;
    request.catch(() => { if (indexRequest === request) indexRequest = undefined; });
  }
  const index = await indexRequest;
  signal?.throwIfAborted();
  return index;
}

export async function loadSnapshot(study: SnapshotEntry, signal?: AbortSignal, background = false): Promise<StudyDocument> {
  const document = await readJson<StudyDocument>(`${base()}${(study.viewFile ?? study.file).replace(/^\//, '')}`, signal, background ? 'low' : 'auto');
  if (document.SchemaVersion !== 1 || document.Study.StudyID !== study.id || document.Company.Ticker !== study.ticker) throw new Error('The hosted study snapshot is invalid.');
  return document;
}

export async function loadStaticStudy(identifier: string, signal?: AbortSignal): Promise<StudyDocument> {
  const index = await snapshotIndex(signal);
  const study = index.studies.find(item => item.ticker.toLowerCase() === identifier.toLowerCase() || item.id === identifier);
  if (!study) throw new Error('GitHub-hosted study snapshots cover the current portfolio holdings. Live study generation for other tickers needs a study API.');
  return loadSnapshot(study, signal);
}
