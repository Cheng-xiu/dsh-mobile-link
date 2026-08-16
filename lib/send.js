// Notification channels. Each push returns a short human-readable result
// string and throws on failure.
export function buildMessage(url, { test = false } = {}) {
  if (test) {
    return {
      title: '[DSH 已启动] 测试消息',
      content: '这是一条来自 dsh-mobile-link 的测试消息。' + (url ? '\n手机打开 DSH: ' + url : ''),
    };
  }
  return {
    title: '[DSH 已启动] 手机链接',
    content: '手机打开 DSH: [' + url + '](' + url + ')',
  };
}

async function postJson(url, payload, headers = {}, expect = null) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* plain text response */ }
  if (expect && !expect(resp.status, data, text)) {
    throw new Error(url + ' 返回异常: HTTP ' + resp.status + ' ' + text.slice(0, 200));
  }
  return { resp, data, text };
}

export async function push(config, { url, test = false, dryRun = false } = {}) {
  const message = buildMessage(url, { test });
  switch (config.channel) {
    case 'serverchan': {
      const sendKey = config.serverchan.sendKey;
      if (!sendKey) throw new Error('缺少 Server酱 SendKey，请先运行: dsh web mobile-link setup');
      const endpoint = 'https://sctapi.ftqq.com/' + sendKey + '.send';
      const payload = { title: message.title, desp: message.content };
      if (dryRun) return describe('serverchan', endpoint, payload);
      const { data } = await postJson(endpoint, payload, {}, (status, data) => status === 200 && data && data.code === 0);
      return 'Server酱推送成功 (pushid ' + (data && data.data && data.data.pushid ? data.data.pushid : '?') + ')';
    }
    case 'pushplus': {
      const token = config.pushplus.token;
      if (!token) throw new Error('缺少 PushPlus token，请先运行: dsh web mobile-link setup');
      const endpoint = 'https://www.pushplus.plus/send';
      const payload = { token, title: message.title, content: message.content, template: 'markdown' };
      if (dryRun) return describe('pushplus', endpoint, payload);
      const { data } = await postJson(endpoint, payload, {}, (status, data) => status === 200 && data && data.code === 200);
      return 'PushPlus 推送成功';
    }
    case 'bark': {
      const { deviceKey, server } = config.bark;
      if (!deviceKey) throw new Error('缺少 Bark device key，请先运行: dsh web mobile-link setup');
      const base = server || 'https://api.day.app';
      const endpoint = base.replace(/\/$/, '') + '/' + deviceKey;
      const plainBody = message.content.replace(/\[[^\]]*\]\(([^)]+)\)/g, '$1');
      const payload = { title: message.title, body: plainBody, url };
      if (dryRun) return describe('bark', endpoint, payload);
      const { data } = await postJson(endpoint, payload, {}, (status, data) => status === 200 && data && data.code === 200);
      return 'Bark 推送成功';
    }
    case 'ntfy': {
      const { topic, server, token } = config.ntfy;
      if (!topic) throw new Error('缺少 ntfy topic，请先运行: dsh web mobile-link setup');
      const base = server || 'https://ntfy.sh';
      const endpoint = base.replace(/\/$/, '') + '/' + topic;
      const headers = { title: message.title };
      if (token) headers.authorization = 'Bearer ' + token;
      const body = message.content.replace(/\[[^\]]*\]\(([^)]+)\)/g, '$1');
      if (dryRun) return describe('ntfy', endpoint, { headers, body });
      const resp = await fetch(endpoint, { method: 'POST', headers, body });
      if (!resp.ok) throw new Error('ntfy 返回异常: HTTP ' + resp.status);
      return 'ntfy 推送成功';
    }
    case 'custom': {
      const { url: endpoint, headers } = config.custom;
      if (!endpoint) throw new Error('缺少自定义 webhook URL，请先运行: dsh web mobile-link setup');
      const payload = { title: message.title, content: message.content, url };
      if (dryRun) return describe('custom', endpoint, payload, headers);
      await postJson(endpoint, payload, headers || {}, (status) => status >= 200 && status < 300);
      return '自定义 webhook 推送成功';
    }
    default:
      throw new Error('未知渠道 ' + config.channel);
  }
}

function describe(channel, endpoint, payload, headers = {}) {
  const extra = Object.keys(headers).length ? { headers } : {};
  return '[dry-run] ' + channel + ' POST ' + endpoint + '\n' + JSON.stringify({ ...payload, ...extra }, null, 2);
}
