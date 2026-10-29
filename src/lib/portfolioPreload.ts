import type { StudyCache } from '../studyCache';
import { loadSnapshot, snapshotIndex } from './staticStudy';

function yieldToSearch(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 100);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
  });
}

/** Queue every published holding immediately, with only two CDN downloads active.
 * Search/live work gets priority; navigation stops the remaining queue.
 */
export async function preloadPortfolio(cache: StudyCache, signal: AbortSignal, foregroundBusy: () => boolean) {
  const index = await snapshotIndex(signal);
  let next = 0;
  const worker = async () => {
    while (!signal.aborted && next < index.studies.length) {
      while (foregroundBusy() && !signal.aborted) await yieldToSearch(signal);
      signal.throwIfAborted();
      const study = index.studies[next++];
      if (!study) return;
      try {
        const cached = await cache.restore(study.id, false);
        if (signal.aborted) return;
        if (!cached || !cache.isFresh(cached)) {
          const document = await loadSnapshot(study, signal, true);
          if (!signal.aborted) cache.warm(document);
        }
      } catch {
        // One missing snapshot must not prevent the other holdings from warming.
      }
    }
  };
  await Promise.all([worker(), worker()]);
}
