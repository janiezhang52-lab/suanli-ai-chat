import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicPrivateWrite, readPrivate, serialQueue } from './files.mjs';
import { stateSchema } from './validation.mjs';

export const OWNER_KEY = 'local-device';
export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export function createStateStore(directory) {
  const path = join(directory, 'chat-state.json');
  const serial = serialQueue();
  async function read() {
    const bytes = await readPrivate(path, 600 * 1024);
    if (!bytes) return { state: null, revision: 0, ownerKey: OWNER_KEY };
    const record = JSON.parse(bytes);
    if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error('invalid_state');
    return { state: stateSchema.parse(record.state), revision: record.revision, ownerKey: OWNER_KEY };
  }
  return {
    read,
    write({ state, revision, expectedOwnerKey }) {
      return serial(async () => {
        if (expectedOwnerKey !== OWNER_KEY) throw new HttpError(403, '当前存储位置已变化，请刷新页面。', 'identity_changed');
        const existing = await read();
        if (revision !== existing.revision) throw new HttpError(409, '另一个页面已更新群聊，请重新载入最新记录。');
        const record = { state: stateSchema.parse(state), revision: revision + 1, ownerKey: OWNER_KEY };
        await atomicPrivateWrite(path, JSON.stringify(record));
        return record;
      });
    },
    import(state, replace = false) {
      return serial(async () => {
        const parsed = stateSchema.parse(state);
        const existing = await read();
        if (existing.state && !replace) throw new HttpError(409, '本机已有群聊。请明确选择先备份再导入。', 'state_exists');
        let backup;
        if (existing.state) {
          backup = `state-before-import-${Date.now()}-${randomUUID()}.json`;
          await atomicPrivateWrite(join(directory, 'backups', backup), JSON.stringify(existing));
        }
        const record = { state: parsed, revision: existing.revision + 1, ownerKey: OWNER_KEY };
        await atomicPrivateWrite(path, JSON.stringify(record));
        return { ...record, ...(backup ? { backup } : {}) };
      });
    },
  };
}
