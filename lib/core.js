// Core one-click flow: tunnel -> dynamic trust fence grant -> wait web -> push.
import { push } from './send.js';
import { ensureTunnel } from './tunnel.js';
import { assertAuthority, extractHostname, findOnPath, probePort, waitPort, waitPublicDsh } from './util.js';
import { CHANNEL_LABELS, loadConfig } from './store.js';
import { spawn } from 'node:child_process';

/**
 * Start `dsh web --trusted-host <tunnelHost>` as a detached background process.
 * The --trusted-host grant is what lets the phone browser pass the /api fence
 * when the CLI runs outside the dsh tree (auto mode instead pushes the
 * host into the live connection service's trustedHosts array).
 */
export function spawnDshWeb({ trustedHost, port, profile = null }) {
  const dsh = findOnPath('dsh');
  if (!dsh) throw new Error('PATH 中找不到 dsh CLI，请先安装 DeepSeek Harness');
  const args = [];
  if (profile) args.push('--profile', profile);
  else args.push('web');
  args.push('--port', String(port), '--trusted-host', trustedHost);
  let child;
  if (process.platform === 'win32') {
    // `start` opens the service in its own minimized console window. The whole
    // command line must be passed verbatim: quoting a path inside an argv
    // element would be re-escaped by Node's own Windows quoting and `start`
    // would silently launch nothing.
    const cmdLine = ['start', '"DSH Service"', '/min', '"' + dsh + '"', ...args].join(' ');
    child = spawn('cmd.exe', ['/d', '/s', '/c', cmdLine], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
  } else {
    child = spawn(dsh, args, { detached: true, stdio: 'ignore' });
  }
  child.unref();
  return child;
}


/**
 * Ensure the phone URL exists (tunnel for the web port) and, when the plugin
 * lives inside a dsh web process, append the tunnel authority to the live
 * /api trust fence so the phone browser is not blocked with 403.
 */
export async function ensureMobileUrl({ ctx, port, log = console.log }) {
  const tunnel = await ensureTunnel(port, { log });
  const host = extractHostname(tunnel.url);
  if (host) {
    assertAuthority(host);
    // The /api fence reads the connection service's trustedHosts array per
    // request, but the array is a copy made when the row's config was
    // resolved — so mutate the live service property instead of the
    // webRuntime snapshot.
    try {
      const conn = ctx && ctx.get('connection');
      if (conn && Array.isArray(conn.trustedHosts) && !conn.trustedHosts.includes(host)) {
        conn.trustedHosts.push(host);
        log('[trust] 已将隧道主机名加入 /api 信任栅栏: ' + host);
      } else if (!conn) {
        log('[trust] 本进程无 connection 服务，跳过动态信任（纯 CLI 模式）。');
      }
    } catch {
      log('[trust] 本进程无 connection 服务，跳过动态信任（纯 CLI 模式）。');
    }
  }  return tunnel;
}

/**
 * The full one-click flow used by `start` and by the auto-send mode.
 * Returns the public URL on success; throws with a readable message on failure.
 */
export async function runStart({ ctx, cordisConfig, options = {} }) {
  // Test-friendly environment switches (CLI flags win).
  options.dryRun = options.dryRun || process.env.DSH_MOBILE_LINK_DRY_RUN === '1';
  options.test = options.test || process.env.DSH_MOBILE_LINK_TEST === '1';
  const config = loadConfig();
  const port = options.port ?? (Number.isInteger(config.webPort) ? config.webPort : (cordisConfig && cordisConfig.webPort) || 3080);
  const webListening = await probePort(port);
  if (!webListening && !options.allowMissingWeb) {
    throw new Error(
      '端口 ' + port + ' 上没有 DSH Web 服务。请先运行 node bin/cli.js start（会同时启动 DSH Web）' +
      '或手动启动 dsh web 后重试，或确认 Web 端口是否为 ' + port + '（可用 setup 修改）。'
    );
  }

  console.log('[1/4] 确保 cloudflared 隧道运行（转发 127.0.0.1:' + port + '）...');
  const tunnel = await ensureMobileUrl({ ctx, port });
  console.log('[2/4] 等待 DSH Web 就绪...');
  const ready = await waitPort(port, 90000);
  if (!ready) throw new Error('等待端口 ' + port + ' 超时，DSH Web 未就绪');
  console.log('[3/4] 验证公网 DSH 首页与 /api 信任栅栏...');
  const publicProbe = await waitPublicDsh(tunnel.url, 90000);
  if (!publicProbe.ok) {
    throw new Error('公网链接验证失败 (' + publicProbe.reason + ')，未显示或推送该链接。');
  }
  console.log('[4/4] 通过 ' + CHANNEL_LABELS[config.channel] + ' 推送已验证链接...');
  const result = await push(config, { url: tunnel.url, test: options.test, dryRun: options.dryRun });
  console.log(result);
  return tunnel.url;
}
