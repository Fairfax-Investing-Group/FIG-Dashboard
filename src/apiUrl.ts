/** API origin is separate from the GitHub Pages frontend in production. */
const base = (import.meta.env ?? {}).VITE_STUDY_API_URL?.trim().replace(/\/+$/, '') ?? '';
export const apiUrl = (path: string) => `${base}${path}`;
