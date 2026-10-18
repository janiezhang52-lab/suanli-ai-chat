import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import { z } from 'zod';
import { HttpError, OWNER_KEY } from './state.mjs';
import { stateSchema, stateWriteSchema, chatRequestSchema } from './validation.mjs';

const importSchema = z.object({ state: stateSchema, replace: z.boolean().optional() }).strict();
const providerSecretNames = { moonshot: 'MOONSHOT_API_KEY', doubao: 'DOUBAO_API_KEY', deepseek: 'DOUBAO_API_KEY', zhipu: 'ZHIPU_API_KEY', gemini: 'GEMINI_API_KEY', xai: 'XAI_API_KEY' };
const providerKeySchema = z.object({
  provider: z.enum(['moonshot', 'doubao', 'deepseek', 'zhipu', 'gemini', 'xai']),
  apiKey: z.string().max(4096).transform(value => value.trim()).refine(value => !/[\s\x00-\x1f\x7f]/u.test(value)),
  expectedOwnerKey: z.string().max(120),
}).strict();
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function json(response, body, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
async function body(request, maxBytes = 500 * 1024) {
  if (Number(request.headers['content-length']) > maxBytes) throw new HttpError(413, '本次内容过大。');
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError(415, '请求需要 JSON 格式。');
  const buffers = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, '本次内容过大。');
    buffers.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(buffers)); }
  catch { throw new HttpError(400, '请求不是有效 JSON。'); }
}
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, '内容格式不正确或超出上限。');
  return result.data;
}
export function createApp({ stateStore, providers, member, secretStore, staticDir }) {
  const root = resolve(staticDir);
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port = server.address()?.port;
      const origin = `http://127.0.0.1:${port}`;
      if (request.headers.host !== `127.0.0.1:${port}` || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) throw new HttpError(403, '仅允许从这台电脑访问。');
      const url = new URL(request.url, origin);
      if (url.origin !== origin) throw new HttpError(403, '访问地址不正确。');
      const route = url.pathname;
      const isApi = route.startsWith('/api/') || route.startsWith('/auth/');
      const fetchSite = request.headers['sec-fetch-site'];
      if (isApi && (fetchSite === 'cross-site' || (request.headers.origin && request.headers.origin !== origin))) throw new HttpError(403, '请从本机群聊页面操作。');
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== origin) throw new HttpError(403, '请从本机群聊页面操作。');
      if (route === '/api/state' && request.method === 'GET') return json(response, await stateStore.read());
      if (route === '/api/state' && request.method === 'PUT') return json(response, await stateStore.write(parse(stateWriteSchema, await body(request))));
      if (route === '/api/providers' && request.method === 'GET') return json(response, { providers: await providers.statuses() });
      if (route === '/api/local/provider-key' && request.method === 'POST') {
        const value = parse(providerKeySchema, await body(request, 8 * 1024));
        if (value.expectedOwnerKey !== OWNER_KEY) throw new HttpError(403, '当前存储位置已变化，请刷新页面。', 'identity_changed');
        // An empty input is an explicit no-op, never a request to erase a key.
        if (!value.apiKey) return json(response, { saved: false, provider: value.provider });
        if (!secretStore) throw new HttpError(503, '密钥保存功能暂不可用，请重新打开 App。');
        try { await secretStore.import({ [providerSecretNames[value.provider]]: value.apiKey }); }
        catch { throw new HttpError(503, '密钥未能保存。请在 macOS 钥匙串提示中允许访问，再重试；原有密钥会保留。', 'secret_save_failed'); }
        // Never return a key, a masked fragment, or an underlying storage error.
        return json(response, { saved: true, provider: value.provider });
      }
      if (route === '/api/member/status' && request.method === 'GET') return json(response, await member.status());
      if (route === '/api/local/import' && request.method === 'POST') {
        const value = parse(importSchema, await body(request));
        return json(response, await stateStore.import(value.state, value.replace));
      }
      if (route === '/auth/chatgpt/start' && request.method === 'GET') {
        let refererOrigin;
        try { refererOrigin = new URL(request.headers.referer).origin; } catch {}
        if (fetchSite !== 'same-origin' && refererOrigin !== origin) throw new HttpError(403, '请点击本机群聊内的 Continue with ChatGPT 按钮。');
        response.writeHead(302, { Location: await member.start() }); response.end(); return;
      }
      if (route === '/api/chat' && request.method === 'POST') {
        const data = parse(chatRequestSchema, await body(request, 384 * 1024));
        if (data.expectedOwnerKey !== OWNER_KEY) throw new HttpError(403, '当前存储位置已变化，请刷新页面。', 'identity_changed');
        const controller = new AbortController();
        const stop = () => { if (!response.writableEnded) controller.abort(); };
        response.on('close', stop);
        const deadline = AbortSignal.timeout(data.agent.provider === 'openai' ? 120000 : data.agent.provider === 'zhipu' ? 75000 : 60000);
        try { return json(response, await providers.chat(data, AbortSignal.any([controller.signal, deadline]))); }
        catch (error) {
          if (controller.signal.aborted) throw new HttpError(499, '本次请求已停止。');
          if (deadline.aborted) throw new HttpError(504, '这位成员响应超时，请稍后重试。', 'provider_timeout');
          throw error;
        } finally { response.off('close', stop); }
      }
      if (isApi) throw new HttpError(404, '没有这个接口。');
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, '不支持这个操作。');
      const decoded = decodeURIComponent(route);
      const candidate = resolve(root, `.${decoded}`);
      if (candidate !== root && !candidate.startsWith(root + sep)) throw new HttpError(403, '访问路径不正确。');
      const file = extname(candidate) ? candidate : join(root, 'index.html');
      const info = await stat(file).catch(() => null);
      if (!info?.isFile() || info.size > 8 * 1024 * 1024) throw new HttpError(404, '页面尚未构建，请先运行 npm run build。');
      response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
      response.end(request.method === 'HEAD' ? undefined : await readFile(file));
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : '本机服务暂时无法完成操作，请保留页面后重试。';
      json(response, { error: message, ...(error instanceof HttpError && error.code ? { code: error.code } : {}) }, status);
    }
  });
  server.requestTimeout = 150000;
  server.headersTimeout = 10000;
  return server;
}
