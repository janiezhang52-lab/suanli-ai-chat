import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateDirectory } from '../server/files.mjs';
import { createKeychainEncryption, createSecretStore } from '../server/secrets.mjs';
import { createStateStore } from '../server/state.mjs';
import { createMember } from '../server/member.mjs';
import { createProviders } from '../server/providers.mjs';
import { createApp } from '../server/app.mjs';
import { dataDirectory } from '../server/storage-location.mjs';

process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = dataDirectory();
const port = process.env.AI_GROUP_PORT ? Number(process.env.AI_GROUP_PORT) : 47631;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid_local_port');
await privateDirectory(directory);
const encryption = createKeychainEncryption(directory);
const secrets = createSecretStore(directory, encryption);
const member = createMember(directory, encryption);
const server = createApp({ stateStore: createStateStore(directory), providers: createProviders(secrets, member), member, secretStore: secrets, staticDir: resolve(root, 'dist') });
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `本机群聊已经打开，或端口 ${port} 被占用。` : '本机群聊未能启动。');
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`算力有限责任公司：http://127.0.0.1:${port}（仅这台电脑可访问）`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { member.cancel(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
