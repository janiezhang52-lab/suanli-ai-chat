import { request } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = 'http://127.0.0.1:47631';

function inspectRunningApp() {
  return new Promise(resolveResult => {
    const req = request(`${url}/api/state`, { timeout: 5000 }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 600 * 1024) { response.destroy(); resolveResult('occupied'); return; }
        chunks.push(chunk);
      });
      response.on('error', () => resolveResult('occupied'));
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks));
          const validState = body.state === null || (body.state && Array.isArray(body.state.agents) && Array.isArray(body.state.rooms));
          resolveResult(response.statusCode === 200 && body.ownerKey === 'local-device' && Number.isSafeInteger(body.revision) && body.revision >= 0 && validState ? 'ready' : 'occupied');
        } catch { resolveResult('occupied'); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', error => resolveResult(error.code === 'ECONNREFUSED' ? 'absent' : 'occupied'));
    req.end();
  });
}

async function openPage() {
  await exec('/usr/bin/open', [url]);
  console.log('已打开算力有限责任公司本机版。');
}

const current = await inspectRunningApp();
if (process.argv.includes('--check')) {
  console.log(JSON.stringify({ service: current, url, node: process.version }));
  process.exitCode = current === 'ready' ? 0 : 1;
} else if (current === 'ready') {
  // Reuse the verified service; do not start another process.
  await openPage();
} else if (current === 'occupied') {
  console.error('端口 47631 已被占用，但未核实为算力有限责任公司本机版。为保留现有服务，本次没有启动新进程。');
  process.exitCode = 1;
} else {
  console.log('正在启动算力有限责任公司本机版……');
  console.log('请保留此终端窗口。按 Control+C 或关闭此窗口可停止本次启动的服务。');
  const child = spawn(process.execPath, [resolve(root, 'scripts/start.mjs')], { cwd: root, stdio: 'inherit', detached: false });
  let ended = false;
  let signaled = false;
  const finished = new Promise(resolveFinished => {
    child.once('error', () => { ended = true; resolveFinished(1); });
    child.once('exit', code => { ended = true; resolveFinished(code ?? 0); });
  });
  const stop = () => { signaled = true; if (!ended) child.kill('SIGTERM'); };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, stop);
  let ready = false;
  for (let attempt = 0; attempt < 40 && !signaled; attempt++) {
    await delay(250);
    if (await inspectRunningApp() === 'ready') { ready = true; break; }
    if (ended) break;
  }
  if (ready && !signaled) await openPage();
  else if (!signaled) { console.error('本机服务未完成启动，请把终端里的提示交给 Codex。'); stop(); }
  process.exitCode = await finished;
}
