const env = import.meta.env ?? {};
// Accept both deployment names used before the branches were merged.
const apiBase = (env.VITE_STUDY_API_URL?.trim() || env.VITE_API_BASE_URL?.trim() || '').replace(/\/+$/, '');

export function apiUrl(path: string) {
  return `${apiBase}${path.startsWith('/') ? path : `/${path}`}`;
}
