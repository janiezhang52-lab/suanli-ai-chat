import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Keep the desktop app and the development launcher on the same private data.
export function dataDirectory() {
  return resolve(process.env.AI_GROUP_DATA_DIR || join(homedir(), 'Library', 'Application Support', '算力有限责任公司'));
}
