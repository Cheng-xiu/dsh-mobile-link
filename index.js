// dsh-mobile-link — one-click phone access to DeepSeek Harness.
// Cordis plugin: optional auto mode. After dsh web boots it ensures the
// cloudflared quick tunnel, grants the tunnel hostname to the live /api trust
// fence, waits for the web port, and pushes the phone link via the channel
// configured in ~/.dsh/mobile-link/config.json.
//
// The interactive CLI is a separate process (bin/cli.js); it spawns
// `dsh web --trusted-host <tunnel-host>` itself, so this row never touches
// the launcher command line.
import z from '@deepseek-ai/schemastery';
import { runStart } from './lib/core.js';
import { configExists, loadConfig } from './lib/store.js';

export const name = 'mobile-link';

export const Config = z.object({
  /** DSH Web port the tunnel should forward (config.json wins when present). */
  webPort: z.number().min(1).max(65535).default(3080),
  /** Automatically tunnel + push right after dsh web boots. */
  autoSend: z.boolean().default(false),
  /** Delay before the auto-send flow starts, letting the web server settle. */
  autoSendDelayMs: z.number().min(0).default(8000),
});

function schedule(ctx, delayMs, fn) {
  // Plain timers + dispose cleanup: ctx.setTimeout would require the optional
  // cordis 'timer' service, which not every deployment exposes.
  const timer = setTimeout(fn, delayMs);
  ctx.on('dispose', function () { clearTimeout(timer); });
  return function () { clearTimeout(timer); };
}

export function apply(ctx, config) {
  let storeConfig = null;
  try {
    // A missing config.json yields DEFAULTS (autoSend:false); that must not
    // clobber an explicit cordis/plugin value, so only trust the store when
    // the file actually exists.
    storeConfig = configExists() ? loadConfig() : null;
  } catch (error) {
    console.warn('[mobile-link] 读取配置失败:', error.message);
  }
  const autoSend = storeConfig
    ? (typeof storeConfig.autoSend === 'boolean' ? storeConfig.autoSend : config.autoSend)
    : config.autoSend;
  if (!autoSend) return;

  schedule(ctx, config.autoSendDelayMs, function () {
    runStart({ ctx, cordisConfig: config })
      .then(function (url) { console.log('[mobile-link] 自动推送完成: ' + url); })
      .catch(function (error) {
        console.warn('[mobile-link] 自动推送失败: ' + (error && error.message ? error.message : error));
      });
  });
}
