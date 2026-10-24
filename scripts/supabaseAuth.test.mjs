import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const session = { user: { id: 'alice', email: 'alice@example.com' }, access_token: 'test-session' };

test('Supabase login handles invalid credentials, success, logout, and stale session restoration', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const dir = await mkdtemp(new URL('../.data/auth-test-', import.meta.url));
  let root;
  try {
    const outfile = `${dir}/auth.mjs`;
    await build({ stdin: { contents: "export {AuthProvider} from './src/auth/AuthProvider'; export {default as LoginForm} from './src/auth/LoginForm';", resolveDir: process.cwd(), loader: 'tsx' }, outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic' });
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { AuthProvider, LoginForm } = await import(pathToFileURL(outfile).href);
    let authEvent, attempts = 0, unsubscribed = 0;
    const signIn = deferred();
    const client = { auth: {
      onAuthStateChange(callback) { authEvent = callback; return { data: { subscription: { unsubscribe() { unsubscribed++; } } } }; },
      async getSession() { return { data: { session: null }, error: null }; },
      async signInWithPassword(credentials) {
        attempts++;
        assert.deepEqual(credentials, { email: 'alice@example.com', password: 'my password' });
        if (attempts === 1) return { data: {}, error: new Error('Invalid login credentials') };
        return signIn.promise;
      },
      async signOut(options) { assert.equal(options.scope, 'local'); authEvent('SIGNED_OUT', null); return { error: null }; },
    } };
    root = createRoot(document.getElementById('root'));
    const render = client => root.render(React.createElement(AuthProvider, { client }, React.createElement(LoginForm)));
    await React.act(async () => render(client));
    assert.equal(document.querySelector('button[type="submit"]').disabled, false);
    const edit = (id, value) => React.act(async () => {
      const input = document.getElementById(id);
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await edit('login-email', 'alice@example.com');
    await edit('login-password', 'my password');
    const submit = () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await React.act(async () => submit());
    assert.match(document.querySelector('[role="alert"]').textContent, /Invalid login credentials/);
    assert.ok(document.getElementById('login-password'));
    await React.act(async () => submit());
    assert.equal(document.querySelector('button[type="submit"]').disabled, true);
    await React.act(async () => signIn.resolve({ data: { session }, error: null }));
    assert.match(document.querySelector('[aria-label="Your account"]').textContent, /alice@example.com/);
    assert.equal(document.querySelector('input[type="password"]'), null);
    await React.act(async () => document.querySelector('[aria-label="Your account"] button').click());
    assert.ok(document.getElementById('login-email'));
    assert.equal(document.getElementById('login-password').value, '');
    const restore = deferred();
    const restoredClient = { auth: { ...client.auth, getSession: () => restore.promise } };
    await React.act(async () => render(restoredClient));
    await React.act(async () => authEvent('SIGNED_IN', session));
    assert.ok(document.querySelector('[aria-label="Your account"]'));
    await React.act(async () => authEvent('SIGNED_OUT', null));
    await React.act(async () => restore.resolve({ data: { session }, error: null }));
    assert.equal(document.querySelector('[aria-label="Your account"]'), null, 'A stale restore must not resurrect a logged-out session');
    assert.ok(unsubscribed >= 1);
    await React.act(async () => render(null));
    assert.equal(document.querySelector('button[type="submit"]').disabled, true);
    assert.match(document.body.textContent, /Sign-in is currently unavailable/);
  } finally {
    if (root) { const React = await import('react'); await React.act(async () => root.unmount()); }
    dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});
