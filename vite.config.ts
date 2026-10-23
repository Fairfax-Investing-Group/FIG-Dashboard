import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const proxy = { '/api': { target: `http://127.0.0.1:${env.API_PORT || '8000'}` } };
  return { plugins: [react()], server: { proxy }, preview: { proxy } };
});
