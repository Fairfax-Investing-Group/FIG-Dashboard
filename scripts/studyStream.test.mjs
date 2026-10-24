import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const document = { SchemaVersion: 1, Company: { CompanyName: 'Société' } };
const event = type => new TextEncoder().encode(JSON.stringify({ type, document }) + '\n');

test('study stream handles split UTF-8 chunks, early updates, interruptions, and API errors', async () => {
  const dir = await mkdtemp(new URL('../.data/stream-test-', import.meta.url));
  try {
    const outfile = `${dir}/stream.mjs`;
    await build({ entryPoints: ['src/studyStream.ts'], outfile, bundle: true, platform: 'node', format: 'esm' });
    const { readStudyStream } = await import(pathToFileURL(outfile).href);
    const response = body => ({ ok: true, headers: { get: () => 'application/x-ndjson' }, body });
    let controller;
    const body = new ReadableStream({ start(value) { controller = value; } });
    let early;
    const seen = new Promise(resolve => { early = resolve; });
    const result = readStudyStream(response(body), value => { assert.deepEqual(value, document); early(); }, () => assert.fail('Must read the stream'));
    const bytes = event('progress');
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    await seen;
    controller.enqueue(event('ready'));
    controller.close();
    assert.deepEqual(await result, document);
    const interrupted = new ReadableStream({ start(value) { value.enqueue(event('progress')); value.close(); } });
    await assert.rejects(readStudyStream(response(interrupted), () => {}, () => {}), /interrupted/);
    const failed = new ReadableStream({ start(value) { value.enqueue(new TextEncoder().encode('{"type":"error","error":"Save failed"}\n')); value.close(); } });
    await assert.rejects(readStudyStream(response(failed), () => {}, () => {}), /Save failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
