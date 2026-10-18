import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createApp } from './app.mjs';
import { createStateStore, OWNER_KEY } from './state.mjs';
import { createSecretStore } from './secrets.mjs';
import { createMember, chooseDefaultModel } from './member.mjs';

const state = { agents: [{ id: 'gpt', name: 'GPT', provider: 'openai', model: '', role: '', color: '#123', symbol: 'G' }], rooms: [{ id: 'room', name: '同事群', members: ['gpt'], messages: [] }] };
function call(port, method, path, headers = {}, value) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, body: text.startsWith('{') ? JSON.parse(text) : text }); });
    });
    req.on('error', reject);
    req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}

test('loopback origin policy, revision conflict and backup import are enforced', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kaigehui-smoke-'));
  let authStarts = 0;
  const member = { status: async () => ({ connected: false, planUsageEnabled: false, model: '', models: [] }), start: async () => { authStarts++; return 'https://auth.openai.com/api/accounts/authorize?test=1'; } };
  const stateStore = createStateStore(directory);
  const server = createApp({ stateStore, member, providers: { statuses: async () => [], chat: async () => ({ content: 'test', model: 'test', provider: 'openai' }) }, staticDir: directory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  try {
    assert.equal((await call(port, 'GET', '/api/state', { Host: `evil.example:${port}` })).status, 403);
    assert.equal((await call(port, 'GET', '/api/state', { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await call(port, 'GET', '/api/state', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await call(port, 'PUT', '/api/state', { 'Content-Type': 'application/json' }, {})).status, 403);
    assert.equal((await call(port, 'GET', '/auth/chatgpt/start')).status, 403);
    assert.equal(authStarts, 0);
    assert.equal((await call(port, 'GET', '/auth/chatgpt/start', { Referer: origin + '/' })).status, 302);
    assert.equal(authStarts, 1);
    assert.equal((await call(port, 'GET', '/api/state')).body.state, null);
    const first = await call(port, 'PUT', '/api/state', headers, { state, revision: 0, expectedOwnerKey: OWNER_KEY });
    assert.equal(first.status, 200); assert.equal(first.body.revision, 1);
    assert.equal((await stat(join(directory, 'chat-state.json'))).mode & 0o777, 0o600);
    assert.equal((await call(port, 'PUT', '/api/state', headers, { state, revision: 0, expectedOwnerKey: OWNER_KEY })).status, 409);
    assert.equal((await call(port, 'PUT', '/api/state', headers, { state, revision: 1, expectedOwnerKey: 'cloud-owner' })).status, 403);
    assert.equal((await call(port, 'POST', '/api/local/import', headers, { state })).status, 409);
    assert.equal((await call(port, 'POST', '/api/local/import', headers, { state: { agents: [], rooms: state.rooms }, replace: true })).status, 400);
    const imported = await call(port, 'POST', '/api/local/import', headers, { state, replace: true });
    assert.equal(imported.status, 200); assert.equal(imported.body.revision, 2);
    assert.ok(imported.body.backup);
    assert.equal((await stat(join(directory, 'backups', imported.body.backup))).mode & 0o777, 0o600);
    assert.equal((await call(port, 'POST', '/api/chat', headers, { agent: state.agents[0], messages: [], prompt: 'test', expectedOwnerKey: 'wrong' })).status, 403);
    const chat = await call(port, 'POST', '/api/chat', headers, { agent: state.agents[0], messages: [], prompt: 'test', expectedOwnerKey: OWNER_KEY });
    assert.equal(chat.status, 200); assert.equal(chat.body.content, 'test');
    assert.equal((await call(port, 'GET', '/server/keychain.swift')).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});

test('state CAS serializes competing updates and refuses permissive storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kaigehui-cas-'));
  try {
    const store = createStateStore(directory);
    const results = await Promise.allSettled([store.write({ state, revision: 0, expectedOwnerKey: OWNER_KEY }), store.write({ state, revision: 0, expectedOwnerKey: OWNER_KEY })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await store.read()).revision, 1);
    await chmod(join(directory, 'chat-state.json'), 0o644);
    await assert.rejects(store.read(), /unsafe_storage/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('secret import validates names, encrypts, and preserves prior keys on rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kaigehui-secrets-'));
  // A reversible test-only provider. Production always requires macOS Keychain.
  const encryption = { encrypt: async text => Buffer.from(text).reverse(), decrypt: async bytes => Buffer.from(bytes).reverse().toString() };
  try {
    const store = createSecretStore(directory, encryption);
    await store.import({ DOUBAO_API_KEY: 'test-only-value' });
    await assert.rejects(store.import({ OPENAI_API_KEY: 'unapproved-api-path' }));
    assert.equal((await store.values()).DOUBAO_API_KEY, 'test-only-value');
    assert.equal((await stat(join(directory, 'provider-secrets.enc'))).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('disconnected membership status never initiates OAuth or reads OS credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kaigehui-member-'));
  let accesses = 0;
  const encryption = { id: 'test-only', isAvailable: async () => { accesses++; return false; }, encrypt: async () => { throw Error('unused'); }, decrypt: async () => { throw Error('unused'); } };
  try {
    const member = createMember(directory, encryption);
    const status = await member.status();
    assert.equal(status.connected, false); assert.equal(status.pending, false); assert.equal(accesses, 0);
    assert.equal(chooseDefaultModel([{ slug: 'gpt-6-astra' }, { slug: 'gpt-6.1-sol' }]), 'gpt-6.1-sol');
    assert.equal(chooseDefaultModel([]), '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
