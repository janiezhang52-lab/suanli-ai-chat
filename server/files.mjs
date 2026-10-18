import { constants } from 'node:fs';
import { mkdir, lstat, chmod, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('unsafe_storage');
  await chmod(path, 0o700);
}

export async function readPrivate(path, maxBytes = 1024 * 1024) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('unsafe_storage');
    return await file.readFile();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { await file?.close(); }
}

export async function atomicPrivateWrite(path, contents) {
  const directory = dirname(path);
  await privateDirectory(directory);
  const temp = join(directory, `.write-${randomUUID()}.tmp`);
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    const dir = await open(directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await rm(temp, { force: true }); }
}

export function serialQueue() {
  let last = Promise.resolve();
  return (operation) => {
    const next = last.then(operation, operation);
    last = next.catch(() => {});
    return next;
  };
}
