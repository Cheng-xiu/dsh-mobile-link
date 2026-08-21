// Standalone CLI: runs in its own process, spawns dsh web itself.
// Commands: start | send | setup | tunnel | doctor | status
import { Command } from 'commander';
import { createRequire } from 'node:module';
import { spawnDshWeb } from './core.js';
import { ensureTunnel, findCloudflared, tunnelStatus, stopTunnel } from './tunnel.js';
import { push } from './send.js';
import { channelReady, CHANNEL_LABELS, loadConfig, setupInteractive } from './store.js';
import { extractHostname, listenerInfo, probePort, probePublicDsh, waitPort, waitPortClosed, waitPublicDsh } from './util.js';

// Read the version from package.json so it cannot drift from the CLI banner.
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function fail(error) {
  console.error('[dsh-mobile-link][ERROR]', error && error.message ? error.message : String(error));
  process.exitCode = 1;
}

/** Start or restart DSH so its trusted-host exactly matches the tunnel URL. */
async function ensureTrustedDsh({ port, host, requestedProfile = null }) {
  let info = listenerInfo(port);
  if (!info) {
    console.log('[2/5] 启动 DSH Web，信任主机 ' + host + ' ...');
    spawnDshWeb({ trustedHost: host, port, profile: requestedProfile || null });
  } else if (info.trustedHost !== host) {
    if (!info.isDsh) {
      throw new Error('端口 ' + port + ' 被非 DSH 进程占用 (pid ' + info.pid + ')；为避免误杀进程，未继续。');
    }
    if (!requestedProfile && !info.profileKnown) {
      throw new Error('检测到 DSH trusted-host 不匹配，但无法可靠识别其 profile；请关闭该 DSH 后重跑 start。');
    }
    const profile = requestedProfile || info.profile || null;
    console.log('[2/5] DSH 当前信任 ' + (info.trustedHost || '(无)') + '，与隧道 ' + host + ' 不一致。');
    console.log('[2/5] 正在重启 DSH (pid ' + info.pid + ') 以修复手机 API 403...');
    try { process.kill(info.pid); } catch (error) {
      throw new Error('无法停止旧 DSH (pid ' + info.pid + '): ' + error.message);
    }
    if (!(await waitPortClosed(port, 20000))) {
      throw new Error('旧 DSH 未在 20 秒内释放端口 ' + port + '，未推送链接。');
    }
    spawnDshWeb({ trustedHost: host, port, profile });
  } else {
    console.log('[2/5] 已运行的 DSH trusted-host 与当前隧道一致。');
  }

  console.log('[3/5] 等待 DSH Web 就绪...');
  if (!(await waitPort(port, 120000))) {
    throw new Error('等待端口 ' + port + ' 超时，DSH Web 未就绪');
  }
  info = listenerInfo(port);
  if (info && info.trustedHost && info.trustedHost !== host) {
    throw new Error('DSH 重启后仍信任 ' + info.trustedHost + '，并非 ' + host + '；未显示或推送错误链接。');
  }
}

async function requirePublicDsh(url) {
  console.log('[4/5] 验证公网 DSH 首页与 /api 信任栅栏...');
  const publicProbe = await waitPublicDsh(url, 90000);
  if (!publicProbe.ok) {
    const detail = publicProbe.reason === 'trusted-host'
      ? '公网首页可达，但 /api 返回 403（trusted-host 不匹配）'
      : '公网探针失败: ' + publicProbe.reason + (publicProbe.detail ? ' (' + publicProbe.detail + ')' : '');
    throw new Error(detail + '；未显示或推送该链接。');
  }
  return publicProbe;
}

async function cmdStart(options) {
  const config = loadConfig();
  const port = toInt(options.port, config.webPort || 3080);
  console.log('[1/5] 建立唯一的受管 cloudflared 隧道 (127.0.0.1:' + port + ')...');
  const tunnel = await ensureTunnel(port);
  const host = extractHostname(tunnel.url);
  if (!host) throw new Error('cloudflared 返回了无效 URL；未显示或推送链接。');
  await ensureTrustedDsh({ port, host, requestedProfile: options.profile || null });
  await requirePublicDsh(tunnel.url);
  // Commander's `--no-push` maps to options.push === false (default true).
  if (options.push === false) {
    console.log('[5/5] 已按要求跳过推送。');
  } else {
    console.log('[5/5] 推送已经验证的手机链接...');
    const result = await push(config, { url: tunnel.url, test: options.test, dryRun: options.dryRun });
    console.log(result);
    console.log('');
  }
  console.log('手机打开 DSH（已验证）: ' + tunnel.url);
}

async function cmdSend(options) {
  const config = loadConfig();
  const port = toInt(options.port, config.webPort || 3080);
  if (!(await probePort(port))) throw new Error('端口 ' + port + ' 没有 DSH Web；请运行 start。');
  const tunnel = await ensureTunnel(port);
  const host = extractHostname(tunnel.url);
  const info = listenerInfo(port);
  if (!info || info.trustedHost !== host) {
    throw new Error('当前 DSH trusted-host 与隧道不一致；为避免发送打不开的链接，请运行 start 自动修复。');
  }
  await requirePublicDsh(tunnel.url);
  const result = await push(config, { url: tunnel.url, test: options.test, dryRun: options.dryRun });
  console.log(result);
  console.log('手机打开 DSH（已验证）: ' + tunnel.url);
}

async function cmdTunnel(options) {
  const config = loadConfig();
  if (options.stop) {
    let stopPort;
    if (options.port === undefined) {
      // No explicit --port: hand stopTunnel the resolved default port (pre-fix
      // behavior) so it can still scan for orphan tunnels when
      // tunnel-state.json is missing; passing null would match nothing.
      stopPort = toInt(options.port, config.webPort || 3080);
    } else {
      // An explicit but invalid --port must fail loudly instead of silently
      // falling back to config.webPort (which could stop the wrong tunnel).
      stopPort = toInt(options.port, null);
      if (stopPort === null) {
        throw new Error('无效的 --port 值: ' + options.port + '（需要正整数端口号）');
      }
    }
    const stopped = stopTunnel(stopPort);
    console.log(stopped ? '[tunnel] 已停止隧道进程' : '[tunnel] 没有运行中的隧道');
    return;
  }
  const port = toInt(options.port, config.webPort || 3080);
  const tunnel = await ensureTunnel(port);
  const publicProbe = await probePublicDsh(tunnel.url);
  if (!publicProbe.ok) {
    console.log('[warn] 隧道已建立，但尚未验证为可用 DSH；不显示链接。');
    console.log('[warn] 原因: ' + publicProbe.reason + '。请运行 start 完成 DSH trusted-host 修复与验证。');
    return;
  }
  console.log('手机打开 DSH（已验证）: ' + tunnel.url);
}

async function cmdStatus() {
  const config = loadConfig();
  const status = tunnelStatus(config.webPort);
  console.log('cloudflared 路径:', findCloudflared() || '(未找到，start 时会自动下载)');
  if (status.adopted) {
    console.log('隧道进程: 运行中 (pid ' + status.pid + ', 外部隧道, URL 未知)');
  } else {
    console.log('隧道进程:', status.alive ? '运行中 (pid ' + status.pid + ')' : '未运行');
  }
  const url = status.freshUrl || status.url || null;
  if (url && status.alive) {
    const publicProbe = await probePublicDsh(url);
    console.log('当前 URL:', publicProbe.ok ? url + ' (已验证)' : '(未验证，不显示为可用链接)');
    if (!publicProbe.ok) console.log('URL 诊断:', publicProbe.reason, publicProbe.apiStatus || '');
  } else {
    console.log('当前 URL: (无)');
  }
  console.log('推送渠道:', CHANNEL_LABELS[config.channel], channelReady(config) ? '(已配置)' : '(未配置凭证!)');
  console.log('Web 端口:', config.webPort, '| 自动推送:', config.autoSend ? '开' : '关');
}

async function cmdDoctor() {
  const config = loadConfig();
  console.log('node:', process.version, '| 平台:', process.platform + '/' + process.arch);
  console.log('cloudflared:', findCloudflared() || '(未安装，start 时会自动下载)');
  const listening = await probePort(config.webPort);
  console.log('Web 端口 ' + config.webPort + ':', listening ? '已监听' : '未监听（dsh web 未运行）');
  console.log('推送渠道:', CHANNEL_LABELS[config.channel], channelReady(config) ? '(凭证已配置)' : '(未配置，请运行 setup)');
  if (channelReady(config)) {
    console.log('渠道 dry-run 检查（不发送）...');
    try {
      const result = await push(config, { url: 'https://example.trycloudflare.com', test: true, dryRun: true });
      console.log(result.split('\n')[0]);
    } catch (error) {
      console.log('[doctor] 渠道检查失败:', error.message);
    }
  }
  const status = tunnelStatus(config.webPort);
  if (status.alive) {
    const url = status.freshUrl || status.url;
    const publicProbe = url ? await probePublicDsh(url) : { ok: false, reason: 'url-unknown' };
    console.log('隧道:', publicProbe.ok ? '运行中且公网链接已验证' : '运行中，但公网链接不可用 (' + publicProbe.reason + ')');
  }
}

export function buildProgram() {
  const program = new Command()
    .name('dsh-mobile-link')
    .description('一键让手机通过互联网连接本机 DSH：cloudflared 隧道 + 多渠道推送手机链接。')
    .version(pkg.version, '-V, --version');

  program
    .command('start')
    .description('一键：确保隧道 → 启动 DSH Web(带 --trusted-host) → 推送手机链接')
    .option('--port <port>', 'DSH Web 端口（默认取配置）')
    .option('--profile <name>', 'dsh profile 名（默认 web）')
    .option('--test', '发送测试消息而非真实链接')
    .option('--dry-run', '只打印将发送的内容，不真正推送')
    .option('--no-push', '完成隧道、信任与公网验证，但不执行推送')
    .action(function (options) {
      cmdStart(options).catch(fail);
    });

  program
    .command('send')
    .description('推送当前手机链接（复用已有隧道，无则新建）')
    .option('--test', '发送测试消息')
    .option('--dry-run', '只打印将发送的内容')
    .option('--port <port>', 'DSH Web 端口')
    .action(function (options) {
      cmdSend(options).catch(fail);
    });

  program
    .command('setup')
    .description('交互式配置推送渠道与凭证（也可用参数非交互配置）')
    .option('--channel <channel>', '渠道: serverchan | pushplus | bark | ntfy | custom')
    .option('--key <key>', 'Server酱 SendKey')
    .option('--token <token>', 'PushPlus token')
    .option('--device-key <key>', 'Bark device key')
    .option('--topic <topic>', 'ntfy topic')
    .option('--url <url>', '自定义 webhook URL')
    .option('--ntfy-server <server>', 'ntfy 服务器地址')
    .option('--ntfy-token <token>', 'ntfy access token')
    .option('--port <port>', 'DSH Web 端口')
    .option('--auto', '开启启动自动推送')
    .option('--no-auto', '关闭启动自动推送')
    .action(function (options) {
      setupInteractive(options).catch(fail);
    });

  program
    .command('tunnel')
    .description('仅确保隧道运行并打印手机 URL')
    .option('--port <port>', 'DSH Web 端口')
    .option('--stop', '停止本插件管理的隧道（含收养的孤儿隧道）')
    .action(function (options) {
      cmdTunnel(options).catch(fail);
    });

  program
    .command('status')
    .description('显示隧道、配置与公网链接验证状态')
    .action(function () {
      cmdStatus().catch(fail);
    });

  program
    .command('doctor')
    .description('环境诊断：cloudflared、端口、渠道连通性')
    .action(function () {
      cmdDoctor().catch(fail);
    });

  return program;
}
