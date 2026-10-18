import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createApp } from './app.mjs';
import { createStateStore, OWNER_KEY } from './state.mjs';
import { createSecretStore } from './secrets.mjs';
import { createProviders } from './providers.mjs';

// Reversible test encryption only; tests never invoke the real macOS Keychain.
const encryption = { encrypt: async text => Buffer.from(text).reverse(), decrypt: async bytes => Buffer.from(bytes).reverse().toString() };
async function fixture(secretStoreOverride) {
  const directory = await mkdtemp(join(tmpdir(), 'suanli-key-form-'));
  const secretStore = secretStoreOverride || createSecretStore(directory, encryption);
  const stateStore = createStateStore(directory);
  const member = { status: async () => ({ connected: false, models: [] }) };
  const providers = createProviders(secretStore, member, { fetchImpl: () => { throw Error('Network calls are forbidden in this test'); } });
  const server = createApp({ stateStore, secretStore, member, providers, staticDir: directory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const call = (method, path, value, requestHeaders = headers) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: requestHeaders }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end(value === undefined ? undefined : JSON.stringify(value));
  });
  return { directory, secretStore, call, headers, close: async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); } };
}
const endpoint = '/api/local/provider-key';
const payload = (provider, apiKey) => ({ provider, apiKey, expectedOwnerKey: OWNER_KEY });

test('member key setup persists privately, updates shared Ark providers, and never returns secrets', async () => {
  const app = await fixture();
  const fakeArkKey = 'test-only-ark-credential';
  const fakeKimiKey = 'test-only-kimi-credential';
  try {
    const kimi = await app.call('POST', endpoint, payload('moonshot', ` ${fakeKimiKey} `));
    assert.equal(kimi.status, 200);
    assert.deepEqual(kimi.body, { saved: true, provider: 'moonshot' });
    const ark = await app.call('POST', endpoint, payload('deepseek', fakeArkKey));
    assert.equal(ark.status, 200);
    assert.equal(ark.headers['cache-control'], 'no-store');
    const stored = createSecretStore(app.directory, encryption);
    assert.deepEqual(await stored.values(), { MOONSHOT_API_KEY: fakeKimiKey, DOUBAO_API_KEY: fakeArkKey });
    const secretPath = join(app.directory, 'provider-secrets.enc');
    assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
    assert.equal((await readFile(secretPath)).includes(Buffer.from(fakeArkKey)), false);
    const statuses = await app.call('GET', '/api/providers');
    for (const id of ['moonshot', 'doubao', 'deepseek']) assert.equal(statuses.body.providers.find(provider => provider.id === id).ready, true);
    const workspace = await app.call('GET', '/api/state');
    assert.equal(workspace.body.state, null);
    const responses = JSON.stringify([kimi, ark, statuses, workspace]);
    for (const key of [fakeArkKey, fakeKimiKey]) assert.equal(responses.includes(key), false);
    const blank = await app.call('POST', endpoint, payload('doubao', '   '));
    assert.deepEqual(blank.body, { saved: false, provider: 'doubao' });
    assert.equal((await stored.values()).DOUBAO_API_KEY, fakeArkKey);
    const replacement = await app.call('POST', endpoint, payload('doubao', 'test-only-new-ark-credential'));
    assert.equal(replacement.status, 200);
    assert.deepEqual(await stored.values(), { MOONSHOT_API_KEY: fakeKimiKey, DOUBAO_API_KEY: 'test-only-new-ark-credential' });
  } finally { await app.close(); }
});

test('member key setup rejects cross-site, missing-origin and wrong-workspace writes', async () => {
  let writes = 0;
  const app = await fixture({ import: async () => { writes++; }, values: async () => ({}) });
  try {
    const value = payload('zhipu', 'test-only-key');
    assert.equal((await app.call('POST', endpoint, value, { ...app.headers, Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await app.call('POST', endpoint, value, { 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await app.call('POST', endpoint, value, { ...app.headers, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await app.call('POST', endpoint, { ...value, expectedOwnerKey: 'different-workspace' })).status, 403);
    assert.equal((await app.call('GET', endpoint)).status, 404);
    assert.equal(writes, 0);
  } finally { await app.close(); }
});

test('member key setup accepts only known API providers and bounded credential payloads', async () => {
  let writes = 0;
  const app = await fixture({ import: async () => { writes++; }, values: async () => ({}) });
  try {
    for (const value of [payload('openai', 'test-only-key'), payload('__proto__', 'test-only-key'), payload('moonshot', null), payload('moonshot', 'line1\nline2'), payload('moonshot', 'test-only\u0000key'), payload('moonshot', 'x'.repeat(4097)), { ...payload('moonshot', 'test-only-key'), OPENAI_API_KEY: 'test-only-disallowed' }]) {
      const response = await app.call('POST', endpoint, value);
      assert.equal(response.status, 400);
      assert.equal(JSON.stringify(response.body).includes('test-only'), false);
    }
    assert.equal((await app.call('POST', endpoint, payload('moonshot', 'x'.repeat(9000)))).status, 413);
    assert.equal(writes, 0);
  } finally { await app.close(); }
});

test('storage errors do not expose a submitted credential or the underlying exception', async () => {
  const marker = 'test-only-sensitive-error-marker';
  const app = await fixture({ import: async () => { throw Error(marker); }, values: async () => ({}) });
  try {
    const response = await app.call('POST', endpoint, payload('zhipu', marker));
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'secret_save_failed');
    assert.match(response.body.error, /密钥未能保存/);
    assert.equal(JSON.stringify(response).includes(marker), false);
  } finally { await app.close(); }
});
