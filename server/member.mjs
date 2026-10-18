import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { createChatGPT } from '@siwc/local';
import { HttpError } from './state.mjs';

const friendly = {
  sign_in_required: '请先登录 ChatGPT 并允许本机群聊使用会员额度。',
  sharing_not_enabled: '尚未允许使用会员额度，请在 ChatGPT 设置里开启后重新连接。',
  subscription_sharing_usage_limit_exceeded: 'ChatGPT 会员额度已达到上限，请在用量设置中查看。',
  subscription_sharing_usage_unavailable: '当前会员暂时不能提供额度，请查看 ChatGPT 用量设置。',
  storage_encryption_unavailable: '请解锁 Mac 钥匙串后重试；已有凭据会保留。',
  cancelled: '本次连接已取消。',
};
export function memberError(error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,100}$/i.test(error.code) ? error.code : 'member_unavailable';
  return { code, message: friendly[code] || 'ChatGPT 暂时未完成连接或响应，请重试或重新登录。' };
}

export function chooseDefaultModel(models) {
  return models.find(m => m.slug === 'gpt-6.1-sol')?.slug
    || models.find(m => /sol/.test(m.slug) && !/astra|pro/.test(m.slug))?.slug
    || models.find(m => /mini|luna/.test(m.slug))?.slug
    || models[0]?.slug || '';
}

export function createMember(directory, encryption) {
  let authUrl = '';
  let startResolve, startReject;
  let pending = null;
  let lastError = null;
  let catalog = [];
  let catalogAt = 0;
  let discovery;
  const storageDir = join(directory, 'chatgpt');
  const client = createChatGPT({
    appName: '算力有限责任公司', appId: 'kaigehui-local',
    redirectPort: 0, storageDir, credentialEncryption: encryption, sendHostId: true,
    openBrowser(url) {
      const target = new URL(url);
      if (target.origin !== 'https://auth.openai.com' || target.pathname !== '/api/accounts/authorize') throw new Error('unexpected_authorization_host');
      authUrl = url;
      startResolve?.(url);
    },
  });
  async function session() {
    // Do not touch OS credentials merely because an unconnected page polls status.
    if (!pending && !await access(join(storageDir, 'chatgpt-auth.json')).then(() => true, () => false)) return { status: 'disconnected', sharing: false };
    return client.getSession();
  }
  async function models() {
    if (catalog.length && Date.now() - catalogAt < 300000) return catalog;
    if (!discovery) discovery = client.listModels({ signal: AbortSignal.timeout(20000) }).then(value => {
      catalog = value; catalogAt = Date.now(); return catalog;
    }).finally(() => { discovery = undefined; });
    return discovery;
  }
  return {
    async status() {
      const current = await session();
      if (current.status === 'connected' && current.sharing && !pending) {
        try { await models(); lastError = null; } catch (error) { lastError = memberError(error); }
      }
      const statusError = lastError || (current.error ? memberError(current.error) : null);
      return {
        connected: current.status === 'connected', planUsageEnabled: current.sharing,
        pending: Boolean(pending), status: current.status, model: chooseDefaultModel(catalog),
        models: catalog.map(item => ({ slug: item.slug, display_name: item.displayName })),
        usageUrl: 'https://chatgpt.com/settings/usage',
        ...(current.identity?.email ? { account: current.identity.email } : {}),
        ...(statusError ? { error: statusError.message, errorCode: statusError.code } : {}),
      };
    },
    async start() {
      if (pending) {
        if (authUrl) return authUrl;
        throw new HttpError(409, '会员登录正在准备中，请稍后重试。');
      }
      authUrl = ''; lastError = null; catalog = []; catalogAt = 0;
      const started = new Promise((resolve, reject) => { startResolve = resolve; startReject = reject; });
      pending = client.signIn().then(() => { lastError = null; }).catch(error => {
        lastError = memberError(error);
        startReject?.(new HttpError(503, lastError.message));
      }).finally(() => { pending = null; authUrl = ''; startResolve = undefined; startReject = undefined; });
      return started;
    },
    async respond({ model, instructions, input, signal }) {
      const current = await session();
      if (current.status !== 'connected' || !current.sharing) throw new HttpError(409, '请先登录 ChatGPT，并允许使用会员额度。');
      const available = await models();
      const selected = model || chooseDefaultModel(available);
      if (!available.some(item => item.slug === selected)) throw new HttpError(400, '这个 GPT 型号不在当前会员目录中，请在成员设置里重新选择。');
      try {
        const result = await client.streamResponse({ model: selected, instructions, input, signal });
        if (!result.text.trim()) throw new HttpError(502, 'GPT 没有返回文字，请重试。');
        return { content: result.text.trim().slice(0, 20000), model: selected, provider: 'openai' };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        const safe = memberError(error);
        throw new HttpError(safe.code.includes('limit') ? 429 : 502, safe.message, safe.code);
      }
    },
    cancel() { client.cancelSignIn(); },
  };
}
