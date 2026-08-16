// cloudflared quick-tunnel management: locate/download the binary, start a
// tunnel for a loopback port, reuse a live one, and extract the public URL.
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { download, ensureMobileDir, extractHostname, findOnPath, mib, mobileDir, probePort, runSyncOk, sleep } from './util.js';

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

export function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
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

/**
 * Ensure a quick tunnel for a loopback port is running.
 * Reuses the live tunnel when the pid is alive and its log still has a URL.
 * Returns { url, reused, pid }.
 */
export async function ensureTunnel(port, { log = console.log, timeoutMs = 60000 } = {}) {
  const state = readState();
  if (state.port === port && processAlive(state.pid) && state.url && /^https:\/\//.test(state.url)) {
    // Verify the pid really is a cloudflared serving our port. On Windows a
    // recycled PID can make processAlive() lie, so beyond re-checking the log
    // tail we (a) confirm the local web port still listens and (b) probe the
    // published URL; either failing means the tunnel is dead and we rebuild.
    try {
      const tail = fs.readFileSync(logPath(port), 'utf8').slice(-200000);
      const fresh = extractUrl(tail);
      const portUp = await probePort(port);
      if (fresh && portUp) {
        const urlUp = await fetch(fresh, { signal: AbortSignal.timeout(8000) })
          .then((r) => r.ok)
          .catch(() => false);
        if (urlUp) {
          return { url: fresh, reused: true, pid: state.pid };
        }
        log('[tunnel] 已复用的隧道 URL 探测失败，正在重建...');
      }
    } catch { /* fall through to restart */ }
  }

  const bin = await ensureCloudflared(log);
  ensureMobileDir();
  const logFile = logPath(port);
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  child.unref();
  log(`[tunnel] cloudflared 已启动 (pid ${child.pid})，等待隧道就绪...`);

  const deadline = Date.now() + timeoutMs;
  let url = null;
  while (Date.now() < deadline) {
    try {
      const tail = fs.readFileSync(logFile, 'utf8').slice(-200000);
      url = extractUrl(tail);
      if (url) break;
    } catch { /* log not readable yet */ }
    if (child.exitCode !== null) break;
    await sleep(1000);
  }
  if (!url) {
    let tailText = '';
    try { tailText = fs.readFileSync(logFile, 'utf8').slice(-4000); } catch { /* ignore */ }
    throw new Error('隧道启动超时，未取得 trycloudflare 地址。日志尾部:\n' + (tailText || '(空日志)'));
  }
  writeState({ pid: child.pid, port, url, startedAt: Date.now() });
  return { url, reused: false, pid: child.pid };
}

/** Stop the managed tunnel process (best effort). */
export function stopTunnel() {
  const state = readState();
  if (!processAlive(state.pid)) return false;
  try {
    process.kill(state.pid);
    writeState({ ...state, url: null, pid: null });
    return true;
  } catch {
    return false;
  }
}

export function tunnelStatus() {
  const state = readState();
  const alive = processAlive(state.pid);
  let freshUrl = null;
  try {
    const tail = fs.readFileSync(logPath(state.port), 'utf8').slice(-200000);
    freshUrl = extractUrl(tail);
  } catch { /* ignore */ }
  return { ...state, alive, freshUrl };
}
