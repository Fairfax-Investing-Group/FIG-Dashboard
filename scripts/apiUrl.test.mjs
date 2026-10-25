import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('API URLs retain the local proxy and support a separate hosted origin', async () => {
  const dir = await mkdtemp(new URL('../.data/api-url-test-', import.meta.url));
  try {
    for (const [name, env, expected] of [['local', {}, '/api/studies'], ['hosted', { VITE_STUDY_API_URL: ' https://api.example.com/// ' }, 'https://api.example.com/api/studies']]) {
      const outfile = `${dir}/${name}.mjs`;
      await build({ entryPoints: ['src/apiUrl.ts'], outfile, bundle: true, platform: 'node', format: 'esm', define: { 'import.meta.env': JSON.stringify(env) } });
      const { apiUrl } = await import(pathToFileURL(outfile).href);
      assert.equal(apiUrl('/api/studies'), expected);
      assert.equal(apiUrl('/api/studies/id/complete?view=study'), expected + '/id/complete?view=study');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
