import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, chmod, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceDirectory = fileURLToPath(new URL('.', import.meta.url));
const onlyMac = { skip: process.platform !== 'darwin' };

async function bundleFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'suanli-keychain-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, 'Fixture.app', 'Contents', 'Resources');
  const server = join(resources, 'backend', 'server');
  const runtime = join(resources, 'runtime');
  await mkdir(server, { recursive: true });
  await mkdir(runtime);
  for (const name of ['secrets.mjs', 'files.mjs']) {
    await copyFile(join(sourceDirectory, name), join(server, name));
  }
  const { createKeychainEncryption } = await import(pathToFileURL(join(server, 'secrets.mjs')).href);
  return { root, runtime, server, data: join(root, 'data'), createKeychainEncryption };
}

async function stubHelper(path, text = '0123456789abcdef0123456789abcdef') {
  // A deterministic, non-secret test key. No system Keychain calls occur.
  await writeFile(path, `#!/bin/sh\n/usr/bin/printf '${text}'\n`);
  await chmod(path, 0o755);
}

test('packaged encryption runs its compiled helper without Swift source or developer tools', onlyMac, async t => {
  const fixture = await bundleFixture(t);
  await stubHelper(join(fixture.runtime, 'keychain-helper'));
  const encryption = fixture.createKeychainEncryption(fixture.data);
  assert.equal(encryption.id, 'kaigehui-macos-keychain-aes256gcm-v1');
  assert.equal(await encryption.isAvailable(), true);
  const ciphertext = await encryption.encrypt('fixture-only value');
  assert.equal(await encryption.decrypt(ciphertext), 'fixture-only value');
  assert.equal(await stat(fixture.data).catch(() => null), null, 'bundled mode must not compile into a data/bin directory');
  assert.equal(await stat(join(fixture.server, 'keychain.swift')).catch(() => null), null);
});

test('a missing packaged helper fails closed instead of compiling a fallback', onlyMac, async t => {
  const fixture = await bundleFixture(t);
  const encryption = fixture.createKeychainEncryption(fixture.data);
  assert.equal(await encryption.isAvailable(), false);
  await assert.rejects(encryption.encrypt('fixture'), /keychain_unavailable/);
  assert.equal(await stat(fixture.data).catch(() => null), null);
});

test('a packaged helper symlink is rejected', onlyMac, async t => {
  const fixture = await bundleFixture(t);
  const elsewhere = join(fixture.root, 'external-helper');
  await stubHelper(elsewhere);
  await symlink(elsewhere, join(fixture.runtime, 'keychain-helper'));
  assert.equal(await fixture.createKeychainEncryption(fixture.data).isAvailable(), false);
});

test('packaged encryption rejects a helper that does not return a 32-byte key', onlyMac, async t => {
  const fixture = await bundleFixture(t);
  await stubHelper(join(fixture.runtime, 'keychain-helper'), 'invalid');
  const encryption = fixture.createKeychainEncryption(fixture.data);
  assert.equal(await encryption.isAvailable(), false);
  await assert.rejects(encryption.encrypt('fixture'), /keychain_unavailable/);
});
