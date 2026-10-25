import type { StudyDocument } from '../types';
import { readStudyStream } from '../studyStream';
import { apiUrl } from './api';

export async function readStudyResponse(response: Response): Promise<StudyDocument> {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('The study backend is unavailable. Start the app with npm run dev and try again.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load the study. Please try again.');
  if (data.SchemaVersion !== 1) throw new Error('Unsupported study data version. Restart the backend and refresh.');
  return data as StudyDocument;
}

export function postStudy(path: string, body: object, signal: AbortSignal, onProgress: (document: StudyDocument) => void) {
  return fetch(apiUrl(path), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(body), signal,
  }).then(response => readStudyStream(response, onProgress, readStudyResponse));
}

export const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError';
