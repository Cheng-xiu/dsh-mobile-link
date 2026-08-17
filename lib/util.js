// Shared helpers for dsh-mobile-link: paths, ports, downloads, authority checks.
import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** DSH home directory; honors the standard $DSH_HOME override. */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** This plugin's state directory: ~/.dsh/mobile-link */
export function mobileDir() {
  return path.join(dshHome(), 'mobile-link');
}

export function ensureMobileDir() {
  fs.mkdirSync(mobileDir(), { recursive: true });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether a TCP port on loopback is accepting connections. */
export function probePort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(1200);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}

/** Poll a loopback port until it listens or the timeout elapses. */
export async function waitPort(port, timeoutMs = 90000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(port)) return true;
    await sleep(intervalMs);
  }
  return probePort(port);
}

/**
 * Best-effort info about the process listening on a loopback port: its pid
 * and, when it looks like a dsh web process, the --trusted-host value from
 * its command line. Returns { pid, trustedHost } or null when undetectable.
 */
export function listenerInfo(port) {
  if (!Number.isInteger(port) || port <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const ns = execFileSync('netstat.exe', ['-ano'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
      const line = ns.split(/\r?\n/).find((l) => l.includes('127.0.0.1:' + port) && /LISTENING/i.test(l));
      const pid = line ? Number.parseInt(line.trim().split(/\s+/).pop(), 10) : NaN;
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const script = "Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "' | ForEach-Object { $_.CommandLine }";
      const cmd = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();
      const m = cmd.match(/--trusted-host\s+(\S+)/);
      return { pid, trustedHost: m ? m[1].replace(/^"|"$/g, '') : null };
    }
    const ps = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
    const line = ps.split(/\r?\n/).find((l) => l.includes('--port') && l.includes(String(port)));
    const pid = line ? Number.parseInt(line.trim().split(/\s+/)[0], 10) : NaN;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const m = line.match(/--trusted-host\s+(\S+)/);
    return { pid, trustedHost: m ? m[1] : null };
  } catch {
    return null;
  }
}

/** Locate an executable on PATH ('where' on Windows, 'which' elsewhere). */
export function findOnPath(name) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const lines = out.split(/\r?\n/).filter((l) => l && l.length);
    if (process.platform === 'win32') {
      // `where dsh` may list an extensionless bash shim first (e.g. npm's
      // `dsh` next to `dsh.cmd`); `cmd.exe start` cannot execute those, so
      // prefer a real Windows executable suffix and skip extensionless shims.
      const win = lines.find((l) => /\.(cmd|exe|bat)$/i.test(l.trim()));
      if (win) return win.trim();
    }
    return lines.length ? lines[0] : null;
  } catch {
    return null;
  }
}

/**
 * A bare authority for the trust fence: hostname, optionally hostname:port.
 * The dsh /api fence validates entries the same way, so never push anything
 * fancier (schemes, paths, wildcards) into trustedHosts.
 */
export function assertAuthority(entry) {
  if (typeof entry !== 'string') throw new Error('authority must be a string');
  if (!/^[a-z0-9.-]+(:[0-9]{1,5})?$/i.test(entry)) {
    throw new Error(`invalid authority ${JSON.stringify(entry)}: expected a bare host or host:port`);
  }
  return entry;
}

/**
 * Detect a configured proxy for a given URL from the standard env vars
 * (HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy), honouring NO_PROXY.
 * Returns the proxy origin (e.g. http://127.0.0.1:7890) or null.
 */
export function detectProxy(targetUrl) {
  const env = process.env;
  const isHttps = /^https:/i.test(targetUrl);
  const raw = (isHttps
    ? (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)
    : (env.HTTP_PROXY || env.http_proxy));
  if (!raw || !raw.length) return null;
  const noProxy = (env.NO_PROXY || env.no_proxy || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (noProxy.length) {
    let host;
    try { host = new URL(targetUrl).hostname; } catch { host = targetUrl; }
    if (noProxy.includes('*') || noProxy.some((h) => host === h || host.endsWith('.' + h.replace(/^\./, '')))) {
      return null;
    }
  }
  return raw;
}

/**
 * Resolve an undici dispatcher that honours HTTP(S)_PROXY, when available.
 * Undici's EnvHttpProxyAgent ships with Node >= 20.10. On Node 18 (which has no
 * built-in proxy agent) a proxy env var cannot be honoured, so we throw a clear
 * error instead of silently connecting direct and failing in a walled-off
 * network — the caller surfaces it and the user can set CLOUDFLARED_BASE to a
 * reachable mirror or upgrade Node. Returns null when no proxy is configured.
 */
export function resolveProxyDispatcher(targetUrl) {
  if (!detectProxy(targetUrl)) return null;
  let gbm;
  try {
    gbm = process.getBuiltinModule && process.getBuiltinModule('undici');
  } catch {
    gbm = null;
  }
  const EnvHttpProxyAgent = gbm && gbm.EnvHttpProxyAgent;
  if (typeof EnvHttpProxyAgent === 'function') {
    return new EnvHttpProxyAgent();
  }
  throw new Error(
    '检测到 HTTP(S)_PROXY 代理环境变量，但当前 Node 版本 (' + process.version +
    ') 无法自动走代理下载 cloudflared。请升级到 Node >= 20.10，或设置 CLOUDFLARED_BASE 指向可达的镜像地址。'
  );
}

/**
 * Download a file to disk with timeout, a bounded number of retries (for
 * network/abort errors only), and an atomic .part rename so a killed download
 * never leaves a half-written destination that later reads as "already done".
 * Returns the destination path.
 */
export async function download(url, dest, { timeoutMs = 60000, retries = 2 } = {}) {
  const part = dest + '.part';
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(Math.min(1000 * Math.pow(2, attempt - 1), 8000));
    }
    let dispatcher;
    try {
      dispatcher = resolveProxyDispatcher(url);
    } catch (err) {
      // A proxy is configured but this Node cannot honour it (Node < 20.10).
      // Retrying a direct connection will not help; fail with the clear message.
      throw err;
    }
    let resp;
    try {
      resp = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        ...(dispatcher ? { dispatcher } : {}),
      });
      if (!resp.ok) {
        // Retrying a 4xx/5xx is pointless; fail immediately.
        throw Object.assign(new Error(`download failed: HTTP ${resp.status} for ${url}`), { __noRetry: true });
      }
      const bytes = Buffer.from(await resp.arrayBuffer());
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(part, bytes);
      fs.renameSync(part, dest);
      return dest;
    } catch (err) {
      // Clean up any partial file and decide whether to retry.
      try { fs.unlinkSync(part); } catch { /* ignore */ }
      lastErr = err;
      if (err && err.__noRetry) break;
      if (attempt >= retries) break;
      // AbortError / TimeoutError / network failure are retryable; anything
      // that wrote a response already failed above with __noRetry.
    }
  }
  throw lastErr || new Error(`download failed for ${url}`);
}

/** Run a command synchronously and return trimmed stdout ('' on failure). */
export function runSync(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return r.stdout ? r.stdout.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Variant of runSync that also reports the exit code, so callers (e.g. the
 * tar extraction path) can verify a non-zero status instead of silently
 * trusting a possibly-empty stdout.
 */
export function runSyncOk(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return {
      ok: r.status === 0,
      out: r.stdout ? r.stdout.trim() : '',
      err: (r.stderr || '').trim(),
      status: r.status,
    };
  } catch (err) {
    return { ok: false, out: '', err: String(err && err.message || err), status: null };
  }
}

/** Human friendly size in MiB. */
export function mib(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MiB';
}

/** Hostname (with port) of a URL, e.g. https://x.trycloudflare.com -> x.trycloudflare.com */
export function extractHostname(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
