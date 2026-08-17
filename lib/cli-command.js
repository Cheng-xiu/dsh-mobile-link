// Standalone CLI: runs in its own process, spawns dsh web itself.
// Commands: start | send | setup | tunnel | doctor | status
import { Command } from 'commander';
import { spawnDshWeb } from './core.js';
import { ensureTunnel, findCloudflared, tunnelStatus, stopTunnel } from './tunnel.js';
import { push } from './send.js';
import { channelReady, CHANNEL_LABELS, loadConfig, setupInteractive } from './store.js';
import { extractHostname, listenerInfo, probePort, waitPort } from './util.js';

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function fail(error) {
  console.error('[dsh-mobile-link][ERROR]', error && error.message ? error.message : String(error));
  process.exitCode = 1;
}

/** When a dsh web already runs on the port, check whether it trusts the tunnel host. */
function warnIfTrustMismatch(port, url) {
  const host = extractHostname(url);
  if (!host) return;
  const info = listenerInfo(port);
  if (info && info.trustedHost && info.trustedHost !== host) {
    console.log('[warn] 端口 ' + port + ' 上的 DSH Web (pid ' + info.pid + ') 信任主机为 ' + info.trustedHost + '，与当前隧道主机 ' + host + ' 不一致：手机访问 /api 会被信任栅栏拦截 (403)。');
    console.log('[warn] 解决：重启该 dsh（若已 node bin/cli.js setup --auto，重启后会自动放行新主机名），或关闭现有实例后重新运行 node bin/cli.js start（自动带 --trusted-host 启动）。');
  } else if (!info || !info.trustedHost) {
    console.log('[warn] 若该实例不是由 dsh-mobile-link 启动的，手机访问 /api 可能被信任栅栏拦截 (403)。建议关闭现有实例后重新运行 node bin/cli.js start。');
  }
}

async function cmdStart(options) {
  const config = loadConfig();
  const port = toInt(options.port, config.webPort || 3080);
  const listening = await probePort(port);
  if (!listening) {
    console.log('[1/4] 未检测到 DSH Web (端口 ' + port + ')，先确保隧道...');
    const tunnel = await ensureTunnel(port);
    const host = extractHostname(tunnel.url);
    console.log('[2/4] 启动 dsh web --trusted-host ' + host + ' ...');
    spawnDshWeb({ trustedHost: host, port, profile: options.profile });
    console.log('[3/4] 等待 DSH Web 就绪...');
    const ready = await waitPort(port, 120000);
    if (!ready) throw new Error('等待端口 ' + port + ' 超时，DSH Web 未就绪');
    console.log('[4/4] 推送手机链接...');
    const result = await push(config, { url: tunnel.url, test: options.test, dryRun: options.dryRun });
    console.log(result);
    console.log('');
    console.log('手机打开 DSH: ' + tunnel.url);
    return;
  }
  console.log('[i] 端口 ' + port + ' 已有 DSH Web 在运行，复用/新建隧道后推送。');
  const tunnel = await ensureTunnel(port);
  warnIfTrustMismatch(port, tunnel.url);
  const result = await push(config, { url: tunnel.url, test: options.test, dryRun: options.dryRun });
  console.log(result);
  console.log('');
  console.log('手机打开 DSH: ' + tunnel.url);
}

async function cmdSend(options) {
  const config = loadConfig();
  const port = toInt(options.port, config.webPort || 3080);
  const tunnel = await ensureTunnel(port);
  if (await probePort(port)) warnIfTrustMismatch(port, tunnel.url);
  const result = await push(config, { url: tunnel.url, test: options.test, dryRun: options.dryRun });
  console.log(result);
  console.log('手机打开 DSH: ' + tunnel.url);
}

async function cmdTunnel(options) {
  const config = loadConfig();
  const port = toInt(options.port, config.webPort || 3080);
  if (options.stop) {
    const stopped = stopTunnel(port);
    console.log(stopped ? '[tunnel] 已停止隧道进程' : '[tunnel] 没有运行中的隧道');
    return;
  }
  const tunnel = await ensureTunnel(port);
  console.log('手机打开 DSH: ' + tunnel.url);
}

function cmdStatus() {
  const config = loadConfig();
  const status = tunnelStatus(config.webPort);
  console.log('cloudflared 路径:', findCloudflared() || '(未找到，start 时会自动下载)');
  if (status.adopted) {
    console.log('隧道进程: 运行中 (pid ' + status.pid + ', 已收养的孤儿隧道, URL 未知)');
  } else {
    console.log('隧道进程:', status.alive ? '运行中 (pid ' + status.pid + ')' : '未运行');
  }
  console.log('当前 URL:', status.freshUrl || status.url || '(无)');
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
  if (status.alive) console.log('隧道: 运行中, URL =', status.freshUrl || status.url);
}

export function buildProgram() {
  const program = new Command()
    .name('dsh-mobile-link')
    .description('一键让手机通过互联网连接本机 DSH：cloudflared 隧道 + 多渠道推送手机链接。')
    .version('0.1.2', '-V, --version');

  program
    .command('start')
    .description('一键：确保隧道 → 启动 DSH Web(带 --trusted-host) → 推送手机链接')
    .option('--port <port>', 'DSH Web 端口（默认取配置）')
    .option('--profile <name>', 'dsh profile 名（默认 web）')
    .option('--test', '发送测试消息而非真实链接')
    .option('--dry-run', '只打印将发送的内容，不真正推送')
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
    .description('显示隧道与配置状态')
    .action(function () {
      cmdStatus();
    });

  program
    .command('doctor')
    .description('环境诊断：cloudflared、端口、渠道连通性')
    .action(function () {
      cmdDoctor().catch(fail);
    });

  return program;
}
