import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join } from 'node:path';
import { stat, lstat, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { atomicPrivateWrite, privateDirectory, readPrivate, serialQueue } from './files.mjs';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('./keychain.swift', import.meta.url));
// Installed apps contain a precompiled helper. Its location is derived only
// from this module, never from a request, stored setting, or environment value.
const serverDirectory = dirname(fileURLToPath(import.meta.url));
const backendDirectory = dirname(serverDirectory);
const resourcesDirectory = dirname(backendDirectory);
const isAppBundle = basename(serverDirectory) === 'server'
  && basename(backendDirectory) === 'backend'
  && basename(resourcesDirectory) === 'Resources'
  && basename(dirname(resourcesDirectory)) === 'Contents';
const bundledHelper = join(resourcesDirectory, 'runtime', 'keychain-helper');

async function keychainHelper(directory) {
  if (isAppBundle) {
    const info = await lstat(bundledHelper);
    if (!info.isFile() || info.isSymbolicLink() || !(info.mode & 0o111)) throw new Error('keychain_unavailable');
    return bundledHelper;
  }
  // Developers running from source may compile once. Installed apps never
  // enter this branch, including when their helper is damaged or missing.
  const binDir = join(directory, 'bin');
  await privateDirectory(binDir);
  const helper = join(binDir, 'keychain-helper');
  const sourceInfo = await stat(source);
  const binaryInfo = await stat(helper).catch(() => null);
  if (!binaryInfo || binaryInfo.mtimeMs < sourceInfo.mtimeMs) {
    await exec('/usr/bin/xcrun', ['swiftc', source, '-o', helper], { timeout: 60000, maxBuffer: 256 * 1024 });
    await chmod(helper, 0o700);
  }
  return helper;
}
export function createKeychainEncryption(directory) {
  let keyPromise;
  async function getKey() {
    if (!keyPromise) keyPromise = (async () => {
      if (process.platform !== 'darwin') throw new Error('mac_keychain_required');
      const helper = await keychainHelper(directory);
      const { stdout } = await exec(helper, [], { encoding: 'buffer', timeout: 60000, maxBuffer: 4096 });
      if (stdout.length !== 32) throw new Error('keychain_unavailable');
      return stdout;
    })().catch(() => { keyPromise = undefined; throw new Error('keychain_unavailable'); });
    return keyPromise;
  }
  return {
    id: 'kaigehui-macos-keychain-aes256gcm-v1',
    async isAvailable() { try { await getKey(); return true; } catch { return false; } },
    async encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', await getKey(), iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    async decrypt(ciphertext) {
      const data = Buffer.from(ciphertext);
      if (data.length < 28) throw new Error('invalid_ciphertext');
      const decipher = createDecipheriv('aes-256-gcm', await getKey(), data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

export const SECRET_NAMES = ['MOONSHOT_API_KEY', 'DOUBAO_API_KEY', 'ZHIPU_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY'];
export const MODEL_NAMES = ['MOONSHOT_MODEL', 'DOUBAO_MODEL', 'ZHIPU_MODEL', 'DEEPSEEK_MODEL', 'GEMINI_MODEL', 'XAI_MODEL'];
const allowed = new Set([...SECRET_NAMES, ...MODEL_NAMES]);
export function createSecretStore(directory, encryption) {
  const path = join(directory, 'provider-secrets.enc');
  const serial = serialQueue();
  async function read() {
    const stored = await readPrivate(path);
    if (!stored) return {};
    const value = JSON.parse(await encryption.decrypt(stored));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_secret_store');
    for (const [name, secret] of Object.entries(value)) {
      if (!allowed.has(name) || typeof secret !== 'string' || secret.length > 4096) throw new Error('invalid_secret_store');
    }
    return value;
  }
  return {
    async values() {
      const saved = await read();
      for (const name of allowed) if (typeof process.env[name] === 'string' && process.env[name].trim()) saved[name] = process.env[name].trim();
      return saved;
    },
    import(values) {
      return serial(async () => {
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('invalid_keys');
        for (const [name, value] of Object.entries(values)) {
          if (!allowed.has(name) || typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error('invalid_keys');
        }
        const merged = { ...await read(), ...values };
        await atomicPrivateWrite(path, await encryption.encrypt(JSON.stringify(merged)));
        return Object.keys(values);
      });
    },
  };
}
