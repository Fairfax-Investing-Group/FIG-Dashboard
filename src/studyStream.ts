import type { StudyDocument } from './types';

/** Publish complete section snapshots while the creation response is arriving. */
export async function readStudyStream(response: Response, onProgress: (document: StudyDocument) => void,
  readJSON: (response: Response) => Promise<StudyDocument>): Promise<StudyDocument> {
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) return readJSON(response);
  if (!response.ok || !response.body) throw new Error('Could not load the study. Please try again.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ready: StudyDocument | null = null;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') throw new Error(event.error || 'Could not load the study. Please try again.');
    if (event.document?.SchemaVersion !== 1) throw new Error('Unsupported study data version. Restart the backend and refresh.');
    if (event.type === 'ready') ready = event.document;
    else if (event.type === 'progress') onProgress(event.document);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (done) break;
    }
    consume(buffer);
    if (!ready) throw new Error('The study connection was interrupted. Please retry.');
    return ready;
  } finally { reader.releaseLock(); }
}
