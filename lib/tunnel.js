// cloudflared quick-tunnel management: locate/download the binary, start a
// tunnel for a loopback port, reuse a live one, and extract the public URL.
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { download, ensureMobileDir, findOnPath, mib, mobileDir, runSyncOk, sleep } from './util.js';

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

const ASSETS = {
  'win32-x64': { file: 'cloudflared-windows-amd64.exe', kind: 'binary' },
  'win32-ia32': { file: 'cloudflared-windows-386.exe', kind: 'binary' },
  'win32-arm64': { file: 'cloudflared-windows-arm64.exe', kind: 'binary' },
  'darwin-x64': { file: 'cloudflared-darwin-amd64.tgz', kind: 'tgz' },
  'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', kind: 'tgz' },
  'linux-x64': { file: 'cloudflared-linux-amd64', kind: 'binary' },
  'linux-ia32': { file: 'cloudflared-linux-386', kind: 'binary' },
  'linux-arm64': { file: 'cloudflared-linux-arm64', kind: 'binary' },
  'linux-arm': { file: 'cloudflared-linux-arm', kind: 'binary' },
};

function platformKey() {
  return process.platform + '-' + process.arch;
}

function binaryName() {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

export function binaryPath() {
  return path.join(mobileDir(), 'bin', binaryName());
}

export function logPath(port = null) {
  return path.join(mobileDir(), port ? 'cloudflared-' + port + '.log' : 'cloudflared.log');
}

function statePath() {
  return path.join(mobileDir(), 'tunnel-state.json');
}

function lockPath() {
  return path.join(mobileDir(), 'tunnel.lock');
}

export function readState() {
  try {
    // Tolerate a UTF-8 BOM: PowerShell's `Set-Content -Encoding UTF8` writes
    // one, and JSON.parse silently fails on it (issue #5).
    const raw = fs.readFileSync(statePath(), 'utf8').replace(/^\uFEFF/, '');
    const state = JSON.parse(raw);
    return typeof state === 'object' && state !== null ? state : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  ensureMobileDir();
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Confirm a pid is cloudflared forwarding exactly the requested port. */
function processMatchesTunnel(pid, port) {
  if (!processAlive(pid) || !Number.isInteger(port)) return false;
  try {
    const target = 'http://127.0.0.1:' + port;
    if (process.platform === 'win32') {
      const script = "Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "' | ForEach-Object { $_.Name + '|' + $_.CommandLine }";
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
      return /^cloudflared(?:\.exe)?\|/i.test(out.trim()) && out.includes(target);
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
    return /cloudflared/.test(out) && out.includes(target);
  } catch {
    return false;
  }
}

async function stopManagedProcess(pid) {
  if (!processAlive(pid)) return;
  try { process.kill(pid); } catch { return; }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && processAlive(pid)) await sleep(200);
}

/**
 * Best-effort adoption of a cloudflared quick tunnel started OUTSIDE this
 * plugin (state file missing): match a live process whose command line
 * forwards the given loopback port. Returns { pid, port } or null.
 * The tunnel's public URL cannot be recovered from the process alone, so
 * adopted tunnels get status/stop support but not URL reuse.
 */
function findTunnelProcesses(port) {
  if (!Number.isInteger(port) || port <= 0) return [];
  try {
    const target = 'http://127.0.0.1:' + port;
    if (process.platform === 'win32') {
      const script = "Get-CimInstance Win32_Process | Where-Object { ($_.Name -match '^cloudflared(.exe)?$') -and ($_.CommandLine -like '*" + target + "*') } | ForEach-Object { $_.ProcessId }";
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
      return out.split(/\r?\n/).map((line) => Number.parseInt(line.trim(), 10)).filter((pid) => Number.isInteger(pid) && pid > 0);
    }
    const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
    return out.split(/\r?\n/)
      .filter((line) => /cloudflared/.test(line) && line.includes(target))
      .map((line) => Number.parseInt(line.trim().split(/\s+/)[0], 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

export function findOrphanTunnel(port) {
  const pid = findTunnelProcesses(port)[0];
  return pid ? { pid, port } : null;
}

/** Extract the newest trycloudflare URL from the tunnel log. */
export function extractUrl(text) {
  const matches = text.match(/https?:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/gi);
  return matches ? matches[matches.length - 1].replace(/\/$/, '') : null;
}

/** Minimum plausible size for a real cloudflared binary (it is 40+ MB). */
const MIN_BINARY_SIZE = 30 * 1024 * 1024;

/**
 * A cached binary is only trustworthy when it is non-trivial in size; a
 * 0-byte or half-written .exe must be treated as missing so it gets re-downloaded
 * rather than spawned into an unrecoverable "empty log -> timeout" loop (R0).
 */
function usableBinary(candidate) {
  try {
    return fs.statSync(candidate).size > MIN_BINARY_SIZE;
  } catch {
    return false;
  }
}

/** Locate an existing cloudflared: PATH first, then common locations and the plugin cache. */
export function findCloudflared() {
  const onPath = findOnPath('cloudflared');
  // A PATH hit still gets a size gate: a stray/truncated cloudflared on PATH
  // must not be trusted (R1).
  if (onPath && usableBinary(onPath)) return onPath;
  const candidates = [];
  const home = os.homedir();
  if (process.platform === 'win32') {
    candidates.push(
      path.join(home, 'AppData', 'Roaming', 'npm', 'cloudflared.exe'),
      path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
      path.join(home, '.cloudflared', 'cloudflared.exe'),
      path.join(home, 'scoop', 'shims', 'cloudflared.exe'),
      path.join(home, '.local', 'bin', 'cloudflared.exe'),
      'C:\\ProgramData\\chocolatey\\bin\\cloudflared.exe',
      path.join(home, 'scoop', 'apps', 'cloudflared', 'current', 'cloudflared.exe'),
      'C:\\Program Files\\cloudflared\\cloudflared.exe',
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      path.join(home, 'Library', 'Application Support', 'cloudflared'),
      path.join(home, '.cloudflared', 'cloudflared'),
      path.join(home, '.local', 'bin', 'cloudflared'),
      '/opt/homebrew/bin/cloudflared',
      '/usr/local/bin/cloudflared',
    );
  } else {
    candidates.push(
      path.join(home, '.cloudflared', 'cloudflared'),
      path.join(home, '.local', 'bin', 'cloudflared'),
      '/usr/local/bin/cloudflared',
      '/usr/bin/cloudflared',
      '/snap/bin/cloudflared',
    );
  }
  candidates.push(binaryPath());
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && usableBinary(candidate)) return candidate;
  }
  return null;
}

/**
 * Validate a freshly acquired cloudflared binary: it must be non-trivial in
 * size and, when possible, respond to `--version` with exit code 0. On failure
 * the file is removed so the next run cannot be poisoned by a bad cache entry
 * (R0/R1).
 */
function validateBinary(target) {
  let size = 0;
  try {
    size = fs.statSync(target).size;
  } catch {
    throw new Error('cloudflared 二进制不存在');
  }
  if (size <= MIN_BINARY_SIZE) {
    try { fs.unlinkSync(target); } catch { /* ignore */ }
    throw new Error(`cloudflared 二进制异常偏小 (${mib(size)})，可能下载失败；已删除，请重试（或设 CLOUDFLARED_BASE 镜像）`);
  }
  // Execution check: `cloudflared --version` must exit 0 and print something
  // that looks like a version banner (stdout or stderr). A broken / wrong-arch
  // binary fails here and is removed so it cannot poison the cache (R1).
  let versionOk = false;
  try {
    const r = runSyncOk(target, ['--version']);
    const banner = r.out + '\n' + r.err;
    versionOk = r.ok && /cloudflared version/i.test(banner);
  } catch {
    versionOk = false;
  }
  if (!versionOk) {
    // Strictly enforce a runnable binary; a cached-but-broken exe must not spawn.
    try { fs.unlinkSync(target); } catch { /* ignore */ }
    throw new Error('cloudflared 二进制无法执行 (--version 失败)；已删除，请重试（或设 CLOUDFLARED_BASE 镜像）');
  }
  return target;
}

/** Ensure a working cloudflared binary exists, downloading it if necessary. */
export async function ensureCloudflared(log = console.log) {
  const existing = findCloudflared();
  if (existing) return existing;

  const asset = ASSETS[platformKey()];
  if (!asset) {
    throw new Error(`暂不支持的平台 ${platformKey()}，请手动安装 cloudflared 并加入 PATH`);
  }
  const base = (process.env.CLOUDFLARED_BASE || '').replace(/\/$/, '');
  const url = base ? `${base}/${asset.file}` : `${RELEASE_BASE}/${asset.file}`;
  ensureMobileDir();
  const binDir = path.join(mobileDir(), 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  log(`[cloudflared] 未找到，正在下载 ${asset.file} ...`);
  const target = binaryPath();
  if (asset.kind === 'tgz') {
    const tarball = path.join(binDir, asset.file);
    await download(url, tarball);
    // The tarball contains ./cloudflared
    const un = runSyncOk('tar', ['-xzf', tarball, '-C', binDir]);
    try { fs.unlinkSync(tarball); } catch { /* ignore */ }
    if (!un.ok) {
      throw new Error(`解压 cloudflared 失败 (tar exit ${un.status})` + (un.err ? ':\n' + un.err : ''));
    }
    try { fs.chmodSync(target, 0o755); } catch { /* ignore */ }
    return validateBinary(target);
  }
  await download(url, target);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(target, 0o755); } catch { /* ignore */ }
  }
  return validateBinary(target);
}

const TUNNEL_STATE_VERSION = 2;

/** Extract the actual loopback metrics origin selected by cloudflared. */
export function extractMetricsUrl(text) {
  const matches = text.match(/Starting metrics server on (?:https?:\/\/)?([^\s/]+)\/metrics/gi);
  if (!matches) return null;
  const last = matches[matches.length - 1];
  const authority = last.replace(/^.*Starting metrics server on (?:https?:\/\/)?/i, '').replace(/\/metrics.*$/i, '');
  return authority ? 'http://' + authority : null;
}

async function tunnelMetricsHealthy(state) {
  if (!state.metricsUrl) return false;
  try {
    const resp = await fetch(state.metricsUrl.replace(/\/$/, '') + '/metrics', { signal: AbortSignal.timeout(5000) });
    const text = await resp.text();
    const active = /cloudflared_tunnel_ha_connections\s+[1-9][0-9]*/.test(text);
    const hosts = [...text.matchAll(/userHostname="(https:\/\/[a-z0-9-]+\.trycloudflare\.com)"/gi)].map((m) => m[1]);
    return resp.ok && active && hosts.includes(state.url);
  } catch {
    return false;
  }
}

/**
 * Ensure a quick tunnel for a loopback port is running.
 * Reuse requires an exact pid/port/url/metrics match. Legacy state is replaced.
 * Returns { url, reused, pid }.
 */
async function ensureTunnelUnlocked(port, { log = console.log, timeoutMs = 60000 } = {}) {
  let state = readState();
  const managedMatches = state.port === port && processMatchesTunnel(state.pid, port);
  if (managedMatches && state.stateVersion === TUNNEL_STATE_VERSION &&
      state.url && /^https:\/\//.test(state.url) && await tunnelMetricsHealthy(state)) {
    // Even a healthy managed tunnel becomes ambiguous when another quick
    // tunnel forwards the same origin. Keep exactly one authoritative process.
    for (const pid of findTunnelProcesses(port)) {
      if (pid !== state.pid) {
        log('[tunnel] 正在停止同端口的重复 cloudflared (pid ' + pid + ')...');
        await stopManagedProcess(pid);
      }
    }
    return { url: state.url, reused: true, pid: state.pid };
  }

  if (managedMatches) {
    log('[tunnel] 旧版或不健康的受管隧道 (pid ' + state.pid + ') 将被替换...');
    await stopManagedProcess(state.pid);
  }
  writeState({ stateVersion: TUNNEL_STATE_VERSION, pid: null, port, url: null, metricsUrl: null });
  state = {};

  // A second quick tunnel for the same origin can make DSH trust one hostname
  // while this CLI prints another. Stop such orphan processes before creating
  // the single authoritative tunnel managed by this plugin.
  for (let count = 0; count < 5; count++) {
    const orphan = findOrphanTunnel(port);
    if (!orphan) break;
    log('[tunnel] 检测到同端口的外部 cloudflared (pid ' + orphan.pid + ')，为避免链接主机名冲突，正在停止并替换...');
    await stopManagedProcess(orphan.pid);
  }

  const bin = await ensureCloudflared(log);
  ensureMobileDir();
  const logFile = logPath(port);
  const fd = fs.openSync(logFile, 'w');
  const child = spawn(bin, [
    'tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate',
    '--metrics', '127.0.0.1:0',
  ], {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  child.unref();
  try { fs.closeSync(fd); } catch { /* child inherited the handles */ }
  log(`[tunnel] cloudflared 已启动 (pid ${child.pid})，等待 URL 与边缘连接注册...`);

  const deadline = Date.now() + timeoutMs;
  let url = null;
  let metricsUrl = null;
  let registered = false;
  while (Date.now() < deadline) {
    try {
      const tail = fs.readFileSync(logFile, 'utf8').slice(-200000);
      if (/quick Tunnel has been created/i.test(tail)) url = extractUrl(tail);
      metricsUrl = extractMetricsUrl(tail) || metricsUrl;
      registered = /Registered tunnel connection/i.test(tail);
      if (url && metricsUrl && registered) break;
    } catch { /* log not readable yet */ }
    if (child.exitCode !== null) break;
    await sleep(500);
  }
  if (!url || !metricsUrl || !registered) {
    await stopManagedProcess(child.pid);
    let tailText = '';
    try { tailText = fs.readFileSync(logFile, 'utf8').slice(-4000); } catch { /* ignore */ }
    throw new Error('隧道启动超时，未同时取得 URL/metrics/边缘注册。日志尾部:\n' + (tailText || '(空日志)'));
  }

  state = { stateVersion: TUNNEL_STATE_VERSION, pid: child.pid, port, url, metricsUrl, startedAt: Date.now() };
  writeState(state);
  const metricsDeadline = Date.now() + 15000;
  while (Date.now() < metricsDeadline) {
    if (await tunnelMetricsHealthy(state)) return { url, reused: false, pid: child.pid };
    await sleep(500);
  }
  await stopManagedProcess(child.pid);
  writeState({ ...state, pid: null, url: null });
  throw new Error('cloudflared 已给出 URL，但 metrics 未确认活动连接；已停止该隧道，未显示或推送无效链接。');
}

/** Serialize tunnel creation/replacement across CLI and tree-auto invocations. */
export async function ensureTunnel(port, options = {}) {
  ensureMobileDir();
  const timeoutMs = options.timeoutMs || 60000;
  const deadline = Date.now() + timeoutMs + 30000;
  let fd = null;
  while (Date.now() < deadline) {
    try {
      fd = fs.openSync(lockPath(), 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, port, at: Date.now() }));
      break;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath());
        if (Date.now() - stat.mtimeMs > 180000) fs.unlinkSync(lockPath());
      } catch { /* another process released it */ }
      await sleep(250);
    }
  }
  if (fd === null) throw new Error('等待隧道管理锁超时；请确认没有卡住的 dsh-mobile-link 进程。');
  try {
    return await ensureTunnelUnlocked(port, options);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lockPath()); } catch { /* ignore */ }
  }
}

/** Stop the managed tunnel process, or an adopted orphan tunnel for the port (best effort). */
export function stopTunnel(port = null) {
  const state = readState();
  const targetPort = Number.isInteger(state.port) ? state.port : port;
  // Never kill a recycled/unrelated pid merely because it appears in state.
  if (processMatchesTunnel(state.pid, targetPort)) {
    try {
      process.kill(state.pid);
      writeState({ ...state, url: null, pid: null });
      return true;
    } catch {
      return false;
    }
  }
  const orphan = findOrphanTunnel(targetPort);
  if (orphan) {
    try { process.kill(orphan.pid); return true; } catch { return false; }
  }
  return false;
}

export function tunnelStatus(port = null) {
  const state = readState();
  const targetPort = Number.isInteger(state.port) ? state.port : port;
  if (state.stateVersion === TUNNEL_STATE_VERSION && processMatchesTunnel(state.pid, targetPort)) {
    let freshUrl = null;
    try {
      const tail = fs.readFileSync(logPath(targetPort), 'utf8').slice(-200000);
      freshUrl = extractUrl(tail);
    } catch { /* ignore */ }
    return { ...state, alive: true, freshUrl };
  }
  const orphan = findOrphanTunnel(targetPort);
  if (orphan) {
    // Adopted tunnel: the process is visible but its URL is not (its log was
    // written elsewhere), so status/stop work while URL reuse does not.
    return { pid: orphan.pid, port: orphan.port, url: null, alive: true, adopted: true, freshUrl: null };
  }
  return { ...state, alive: false, freshUrl: null };
}
