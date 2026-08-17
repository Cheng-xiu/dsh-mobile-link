// Config store: ~/.dsh/mobile-link/config.json (channels + credentials).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ensureMobileDir, mobileDir } from './util.js';

export const CHANNELS = ['serverchan', 'pushplus', 'bark', 'ntfy', 'custom'];

export const CHANNEL_LABELS = {
  serverchan: 'ServerChan (微信服务号「方糖」推送)',
  pushplus: 'PushPlus (公众号推送)',
  bark: 'Bark (iOS 自建/官方推送)',
  ntfy: 'ntfy (通用通知, 可在任意端订阅)',
  custom: '自定义 webhook (POST JSON)',
};

export const DEFAULTS = {
  channel: 'serverchan',
  serverchan: { sendKey: '' },
  pushplus: { token: '' },
  bark: { deviceKey: '', server: '' },
  ntfy: { topic: '', server: '', token: '' },
  custom: { url: '', headers: {} },
  autoSend: false,
  webPort: 3080,
};

export function configPath() {
  return path.join(mobileDir(), 'config.json');
}

export function loadConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) return structuredClone(DEFAULTS);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalize({ ...structuredClone(DEFAULTS), ...raw });
  } catch (error) {
    throw new Error(`无法读取配置 ${file}: ${error.message}`);
  }
}

function normalize(config) {
  config.channel = CHANNELS.includes(config.channel) ? config.channel : 'serverchan';
  config.webPort = Number.isInteger(config.webPort) ? config.webPort : 3080;
  config.autoSend = Boolean(config.autoSend);
  config.serverchan = { sendKey: '', ...(config.serverchan ?? {}) };
  config.pushplus = { token: '', ...(config.pushplus ?? {}) };
  config.bark = { deviceKey: '', server: '', ...(config.bark ?? {}) };
  config.ntfy = { topic: '', server: '', token: '', ...(config.ntfy ?? {}) };
  config.custom = { url: '', headers: {}, ...(config.custom ?? {}) };
  return config;
}

export function saveConfig(config) {
  ensureMobileDir();
  const file = configPath();
  const data = JSON.stringify(config, null, 2);
  fs.writeFileSync(file, data + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows: no-op */ }
  return file;
}

/** Whether the configured channel has its credential filled in. */
export function channelReady(config) {
  switch (config.channel) {
    case 'serverchan': return Boolean(config.serverchan.sendKey && config.serverchan.sendKey.startsWith('SCT'));
    case 'pushplus': return Boolean(config.pushplus.token);
    case 'bark': return Boolean(config.bark.deviceKey);
    case 'ntfy': return Boolean(config.ntfy.topic);
    case 'custom': return Boolean(config.custom.url && /^https?:\/\//i.test(config.custom.url));
    default: return false;
  }
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

/** Interactive setup wizard (also usable non-interactively via options). */
export async function setupInteractive(options = {}) {
  const config = loadConfig();
  const hasOpts = Object.keys(options).filter((key) => options[key] !== undefined && key !== 'interactive').length > 0;

  if (options.channel) {
    if (!CHANNELS.includes(options.channel)) throw new Error(`未知渠道 ${options.channel}，可选: ${CHANNELS.join(', ')}`);
    config.channel = options.channel;
  }

  const interactive = options.interactive !== false && !hasOpts && process.stdin.isTTY && process.stdout.isTTY;
  if (!interactive) {
    // non-interactive: only apply explicit options
    applyOptions(config, options);
    if (!channelReady(config)) {
      throw new Error(
        '非交互模式需要渠道凭证参数。示例: node bin/cli.js setup --channel serverchan --key SCTxxxxxx\n' +
        '或交互式运行: node bin/cli.js setup'
      );
    }
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('');
      console.log('=== dsh-mobile-link 配置向导 ===');
      console.log('手机链接将通过你选择的渠道推送到你的微信/手机。凭证只保存在本机。');
      console.log('');
      console.log('选择推送渠道:');
      CHANNELS.forEach((channel, index) => console.log(`  ${index + 1}) ${CHANNEL_LABELS[channel]}`));
      let choice = await ask(rl, `请输入编号 [1-${CHANNELS.length}] (默认 1): `);
      const index = Number.parseInt(choice || '1', 10) - 1;
      if (index >= 0 && index < CHANNELS.length) config.channel = CHANNELS[index];

      if (config.channel === 'serverchan') {
        const key = await ask(rl, 'Server酱 SendKey (https://sct.ftqq.com 登录后可见, 形如 SCT...): ');
        if (key) config.serverchan.sendKey = key;
      } else if (config.channel === 'pushplus') {
        const token = await ask(rl, 'PushPlus token (https://www.pushplus.plus 扫码后可见): ');
        if (token) config.pushplus.token = token;
      } else if (config.channel === 'bark') {
        const deviceKey = await ask(rl, 'Bark device key (App 内可见): ');
        if (deviceKey) config.bark.deviceKey = deviceKey;
        const server = await ask(rl, 'Bark 服务器地址 (默认官方, 自建才填, 含 https://): ');
        if (server) config.bark.server = server;
      } else if (config.channel === 'ntfy') {
        const topic = await ask(rl, 'ntfy topic: ');
        if (topic) config.ntfy.topic = topic;
        const server = await ask(rl, 'ntfy 服务器 (默认 https://ntfy.sh, 自建才填): ');
        if (server) config.ntfy.server = server;
        const token = await ask(rl, 'ntfy access token (可选): ');
        if (token) config.ntfy.token = token;
      } else if (config.channel === 'custom') {
        const url = await ask(rl, 'webhook URL (POST JSON {title, content, url}): ');
        if (url) config.custom.url = url;
      }

      const portAnswer = await ask(rl, `DSH Web 端口 (默认 ${config.webPort}): `);
      const port = Number.parseInt(portAnswer, 10);
      if (Number.isInteger(port) && port > 0) config.webPort = port;

      const autoAnswer = await ask(rl, '每次 dsh web 启动后自动隧道并推送? (y/N): ');
      config.autoSend = /^y/i.test(autoAnswer);
    } finally {
      rl.close();
    }
  }

  if (!channelReady(config)) throw new Error('渠道凭证不完整，配置未保存。请重新运行 setup。');
  const file = saveConfig(config);
  console.log(`配置已保存: ${file}`);
  console.log(`渠道: ${CHANNEL_LABELS[config.channel]} | web 端口: ${config.webPort} | 自动推送: ${config.autoSend ? '开' : '关'}`);
  return config;
}

function applyOptions(config, options) {
  if (options.key) config.serverchan.sendKey = options.key;
  if (options.token) config.pushplus.token = options.token;
  if (options['device-key']) config.bark.deviceKey = options['device-key'];
  if (options.topic) config.ntfy.topic = options.topic;
  if (options.url) config.custom.url = options.url;
  if (options['ntfy-server']) config.ntfy.server = options['ntfy-server'];
  if (options['ntfy-token']) config.ntfy.token = options['ntfy-token'];
  if (options.port !== undefined) {
    const port = Number.parseInt(String(options.port), 10);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`--port 必须是正整数, 收到 ${JSON.stringify(options.port)}`);
    config.webPort = port;
  }
  if (options.auto) config.autoSend = true;
  if (options['no-auto']) config.autoSend = false;
  if (options.channel && config.channel === 'custom' && !options.url) {
    // non-interactive custom channel needs --url; covered by channelReady check
  }
}
