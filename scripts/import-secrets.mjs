import { createKeychainEncryption, createSecretStore } from '../server/secrets.mjs';
import { dataDirectory } from '../server/storage-location.mjs';

// Receive JSON via a protected pipe. Never place credentials in shell arguments.
process.umask(0o077);
try {
  const directory = dataDirectory();
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('input_too_large');
    chunks.push(chunk);
  }
  const values = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const store = createSecretStore(directory, createKeychainEncryption(directory));
  const names = await store.import(values);
  console.log(JSON.stringify({ saved: names, storage: 'mac-keychain-encrypted-local-file' }));
} catch {
  console.error('密钥未保存；请检查输入格式和 Mac 钥匙串状态。原有密钥保持不变。');
  process.exitCode = 1;
}
