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

/** Poll until a loopback port is no longer accepting connections. */
export async function waitPortClosed(port, timeoutMs = 15000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probePort(port))) return true;
    await sleep(intervalMs);
  }
  return !(await probePort(port));
}

function classifyPublicProbe(rootStatus, rootBody, apiStatus, transport = 'node') {
  if (rootStatus !== 200 || !/(DeepSeek|__DSH_BOOT__)/i.test(rootBody || '')) {
    return { ok: false, reason: 'root', rootStatus, apiStatus, transport };
  }
  if (apiStatus === 403) {
    return { ok: false, reason: 'trusted-host', rootStatus, apiStatus, transport };
  }
  if (!Number.isInteger(apiStatus) || apiStatus >= 500) {
    return { ok: false, reason: 'api', rootStatus, apiStatus, transport };
  }
  return { ok: true, rootStatus, apiStatus, transport };
}

/** Windows fallback that honours the user's WinINET proxy/PAC configuration. */
function probePublicDshWithPowerShell(base, timeoutMs) {
  if (process.platform !== 'win32') return null;
  const seconds = Math.max(3, Math.ceil(timeoutMs / 1000));
  const script = [
    "$ErrorActionPreference='Stop'",
    '$base=$env:DSH_MOBILE_LINK_PROBE_URL',
    '$timeout=[int]$env:DSH_MOBILE_LINK_PROBE_TIMEOUT',
    'function Probe([string]$uri,[bool]$needBody){',
    '  try {',
    '    $r=Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec $timeout',
    '    $body=\'\'; if($needBody){$body=[string]$r.Content}',
    '    return @{status=[int]$r.StatusCode;body=$body}',
    '  } catch {',
    '    if($_.Exception.Response){return @{status=[int]$_.Exception.Response.StatusCode;body=\'\'}}',
    '    throw',
    '  }',
    '}',
    '$root=Probe ($base+\'/\') $true',
    '$api=Probe ($base+\'/api/session.list\') $false',
    '@{rootStatus=$root.status;rootBody=$root.body;apiStatus=$api.status}|ConvertTo-Json -Compress',
  ].join("\n");
  try {
    const out = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs * 2 + 5000,
      env: {
        ...process.env,
        DSH_MOBILE_LINK_PROBE_URL: base,
        DSH_MOBILE_LINK_PROBE_TIMEOUT: String(seconds),
      },
    });
    const data = JSON.parse(out.replace(/^\uFEFF/, '').trim());
    return classifyPublicProbe(Number(data.rootStatus), String(data.rootBody || ''), Number(data.apiStatus), 'wininet');
  } catch (error) {
    return { ok: false, reason: 'network', detail: error && error.message ? error.message : String(error), transport: 'wininet' };
  }
}

/**
 * Verify that a public URL serves the DSH shell and that /api is not rejected
 * by the trusted-host fence. A 404/405 API response is acceptable because the
 * exact route and method vary by DSH version; 403 is the mismatch signal.
 */
export async function probePublicDsh(url, timeoutMs = 12000) {
  const base = String(url || '').replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(base)) {
    return { ok: false, reason: 'invalid-url', detail: base };
  }
  try {
    let dispatcher = null;
    try { dispatcher = resolveProxyDispatcher(base); } catch { /* system fallback below */ }
    const request = { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), ...(dispatcher ? { dispatcher } : {}) };
    const root = await fetch(base + '/', request);
    const body = await root.text();
    const api = await fetch(base + '/api/session.list', {
      ...request,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return classifyPublicProbe(root.status, body, api.status, 'node');
  } catch (error) {
    const fallback = probePublicDshWithPowerShell(base, timeoutMs);
    if (fallback) return fallback;
    return { ok: false, reason: 'network', detail: error && error.message ? error.message : String(error), transport: 'node' };
  }
}

/** Wait for the public DSH URL to pass both shell and trusted-host probes. */
export async function waitPublicDsh(url, timeoutMs = 90000, intervalMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false, reason: 'not-probed' };
  while (Date.now() < deadline) {
    last = await probePublicDsh(url);
    if (last.ok || last.reason === 'trusted-host') return last;
    await sleep(intervalMs);
  }
  return last;
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
      // Boundary-match the exact local address so e.g. 3080 does not hit 30801.
      const localRe = new RegExp('(^|\\s)127\\.0\\.0\\.1:' + port + '(\\s|$)');
      const line = ns.split(/\r?\n/).find((l) => localRe.test(l) && /LISTENING/i.test(l));
      const pid = line ? Number.parseInt(line.trim().split(/\s+/).pop(), 10) : NaN;
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const script = "Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "' | ForEach-Object { $_.CommandLine }";
      const cmd = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();
      const trusted = cmd.match(/--trusted-host(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
      const profile = cmd.match(/--profile(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
      const isDsh = /@deepseek-ai[\\/]dsh[\\/].*lib[\\/]bin\.js|\bdsh(?:\.cmd)?\b/i.test(cmd);
      const webAlias = /(?:lib[\\/]bin\.js"?|\bdsh(?:\.cmd)?)\s+web(?:\s|$)/i.test(cmd);
      return {
        pid,
        trustedHost: trusted ? (trusted[1] || trusted[2] || trusted[3]) : null,
        profile: profile ? (profile[1] || profile[2] || profile[3]) : null,
        profileKnown: Boolean(profile || webAlias),
        isDsh,
        commandLine: cmd,
      };
    }
    const ps = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
    // Boundary-match the exact --port value so e.g. 3080 does not hit 30801.
    const portRe = new RegExp('--port(?:=|\\s+)' + port + '(?=\\s|$)');
    const line = ps.split(/\r?\n/).find((l) => portRe.test(l));
    const pid = line ? Number.parseInt(line.trim().split(/\s+/)[0], 10) : NaN;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const trusted = line.match(/--trusted-host(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const profile = line.match(/--profile(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const webAlias = /\bdsh\s+web(?:\s|$)/i.test(line);
    return {
      pid,
      trustedHost: trusted ? (trusted[1] || trusted[2] || trusted[3]) : null,
      profile: profile ? (profile[1] || profile[2] || profile[3]) : null,
      profileKnown: Boolean(profile || webAlias),
      isDsh: /\bdsh\b/i.test(line),
      commandLine: line,
    };
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
