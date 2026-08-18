# dsh-mobile-link

一键让手机通过互联网连接本机 DeepSeek Harness（DSH），并把手机链接自动推送到你的微信（或你选择的其它渠道）。

One-click phone access to your local DeepSeek Harness: a Cloudflare quick tunnel exposes the DSH Web GUI to the internet, and the phone link is pushed to your WeChat through the notification channel you choose.

## 功能特性

- **一键启动**：双击 `bin\start-mobile.cmd`（Windows）或 `bin/start-mobile.sh`（macOS/Linux），或命令行运行 `node bin/cli.js start`。
- **Cloudflare 隧道**：自动检测/下载 cloudflared，启动 quick tunnel 转发 DSH Web 端口（默认 3080），复用已有隧道，绝不要求你注册 Cloudflare 账号。
- **自动放行 /api**：命令行启动时以 `dsh web --trusted-host <隧道主机名>` 启动 DSH，树内自动模式则把隧道主机名动态加入信任栅栏，手机打开不会遇到 403。
- **多渠道推送**：推送渠道可选，不强绑定任何服务：
  - **Server酱**（默认，微信服务号「方糖」推送，免费额度每日有限）
  - **PushPlus**（公众号推送）
  - **Bark**（iOS App 推送，官方或自建服务器）
  - **ntfy**（通用通知，任何端可订阅，官方或自建服务器）
  - **自定义 webhook**（`POST JSON {title, content, url}`，接入你自己的通道）
- **可选自动推送**：配置 `autoSend` 后，每次 `dsh web` 启动约 8 秒后自动完成隧道 + 推送手机链接。
- **零键鼠接管、不依赖 PC 微信客户端**：纯 HTTP 推送，微信没开机也能收到。
- **不依赖 Cloudflare 账号**：quick tunnel 匿名可用。

## 一键安装（Windows，推荐）

1. 打开仓库右上角 **Code → Download ZIP**，解压到任意目录。
2. 双击根目录的 `install.cmd`。
3. 向导会检查 Node.js、DSH、pnpm，安装 GitHub 插件，然后显示 Server酱获取步骤并询问 SendKey。
4. 登录 <https://sct.ftqq.com>（微信扫码），在 **SendKey** 页面复制形如 `SCT...` 的密钥，粘贴给向导。
5. 向导把密钥写入本机 `~/.dsh/mobile-link/config.json`，询问是否立即启动并推送手机链接。

也可在 PowerShell 指定 profile、端口和自动推送：

```powershell
.\\install.ps1 -Profile web -Port 3080 -AutoSend
```

> SendKey 只保存在用户本机，安装脚本不会把它写入仓库或日志。Server酱免费额度有限，以其官网当前说明为准。安装后目标 DSH profile 必须重启一次，插件才会进入启动树。

> `commander` 由插件作为运行时依赖自行安装，避免全新 profile 或独立 `DSH_HOME` 中出现 `ERR_MODULE_NOT_FOUND`；`@deepseek-ai/schemastery` 仍为可选 peer，仅供树内配置 schema 使用。

## 手动安装

前置要求：已安装 dsh CLI（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)）、Node.js >= 18.17，且 `pnpm` 在 PATH 中（`dsh plugin` 依赖它完成安装，找不到会报 `pnpm not found on PATH`）。

本插件尚未发布到 npm，请从本地路径或 GitHub 安装：

```sh
# 从 GitHub 仓库安装
dsh plugin --profile web add github:Cheng-xiu/dsh-mobile-link

# 或从本地路径安装
dsh plugin --profile web add C:\path\to\dsh-mobile-link
```

> 插件会在**下一次 dsh 启动时**生效——安装完成后需要重启 `dsh web`（重启会短暂断开当前会话，属正常现象）。

> 若 pnpm 提示需要为构建脚本授权（pnpm 10+），按提示把该包加入 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 后重试。本插件是纯 JavaScript，无原生构建。

> `dsh plugin` 是 pnpm 转发器：`add` 后面的参数会原样传给 pnpm，因此 `dsh plugin --profile web --help` 显示的是 pnpm 的帮助；spec 支持 npm 包名、`github:owner/repo`、`git+https://...git`、`file:/path`、`link:/path` 等形式。

## 快速开始

### 1. 安装并重启 dsh web

见上节。重启 dsh web 让插件注入前端运行时。

### 2. 配置推送渠道（一次性）

交互式向导（推荐）：

```sh
node bin/cli.js setup
```

或非交互配置（示例为 Server酱）：

```sh
node bin/cli.js setup --channel serverchan --key SCTxxxxxxxxxxxxxxxx --port 3080
```

凭证保存在本机 `~/.dsh/mobile-link/config.json`（权限 0600），不会离开你的机器，也永远不会写进仓库或日志。

### 3. 一键启动 + 推送

双击 `bin\start-mobile.cmd`（Windows）或运行 `bin/start-mobile.sh`（macOS/Linux），等价于：

```sh
node bin/cli.js start
```

控制台会依次完成：确保隧道 → 启动 DSH Web（带 `--trusted-host`）→ 等待 Web 就绪 → 推送手机链接。你的微信（或所选渠道）会收到一条「[DSH 已启动] 手机链接」，点开即可在手机上使用 DSH。

### 4.（可选）每次启动自动推送

```sh
node bin/cli.js setup --auto
```

之后每次 `dsh web` 启动约 8 秒后会自动完成隧道与推送，无需任何操作。

## 命令参考

独立 CLI（`node bin/cli.js <命令>`）：

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `start` | 一键：唯一隧道 → 修复/重启 DSH Web（`--trusted-host` 与隧道一致）→ 公网首页 + `/api` 双探针验证 → 推送链接 | `--port <p>` `--profile <name>` `--test` `--dry-run` `--no-push` |
| `send` | 只推送（复用已有隧道，无则新建） | `--test` `--dry-run` `--port <p>` |
| `setup` | 配置渠道与凭证（交互式，也可纯参数） | `--channel` `--key` `--token` `--device-key` `--topic` `--url` `--ntfy-server` `--ntfy-token` `--port` `--auto` `--no-auto` |
| `tunnel` | 只管理隧道，打印手机 URL | `--port <p>` `--stop` |
| `doctor` | 环境诊断（cloudflared、端口、渠道连通性） | — |
| `status` | 隧道与配置状态 | — |

常用示例：

```sh
node bin/cli.js start                # 一键启动 + 推送
node bin/cli.js start --dry-run      # 只打印将发送的内容，不真正推送
node bin/cli.js start --test         # 发送测试消息而非真实链接
node bin/cli.js send --port 3099     # 只推送，指定端口
node bin/cli.js tunnel --stop        # 停止本插件管理的隧道
node bin/cli.js status               # 查看隧道与配置状态
node bin/cli.js doctor               # 环境诊断
```

`start` / `send` / `tunnel` / `setup` 默认端口取配置 `config.json` 的 `webPort`（缺省 3080），都可用 `--port <p>` 覆盖。

## 配置字段

`~/.dsh/mobile-link/config.json`：

```json
{
  "channel": "serverchan",
  "serverchan": { "sendKey": "SCT..." },
  "pushplus": { "token": "" },
  "bark": { "deviceKey": "", "server": "" },
  "ntfy": { "topic": "", "server": "", "token": "" },
  "custom": { "url": "", "headers": {} },
  "autoSend": false,
  "webPort": 3080
}
```

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `channel` | string | `serverchan` | 当前渠道：`serverchan`|`pushplus`|`bark`|`ntfy`|`custom` |
| `serverchan.sendKey` | string | `""` | Server酱 SendKey（形如 `SCT...`） |
| `pushplus.token` | string | `""` | PushPlus token |
| `bark.deviceKey` | string | `""` | Bark device key |
| `bark.server` | string | `""` | Bark 自建服务器地址（空则用官方） |
| `ntfy.topic` | string | `""` | ntfy topic |
| `ntfy.server` | string | `""` | ntfy 服务器（空则用 `https://ntfy.sh`） |
| `ntfy.token` | string | `""` | ntfy access token（可选） |
| `custom.url` | string | `""` | 自定义 webhook URL |
| `custom.headers` | object | `{}` | 自定义 webhook 额外请求头 |
| `autoSend` | boolean | `false` | dsh web 启动后自动隧道 + 推送 |
| `webPort` | number | `3080` | 隧道转发的 DSH Web 端口 |

## 渠道凭证获取方式（一句话）

- **Server酱**：登录 <https://sct.ftqq.com> 获取 SendKey（形如 `SCT...`），`--channel serverchan --key <SendKey>`。
- **PushPlus**：<https://www.pushplus.plus> 扫码后获取 token，`--channel pushplus --token <token>`。
- **Bark**：在 Bark App 内查看 device key，`--channel bark --device-key <key>`。
- **ntfy**：自选 topic（可加自建服务器与 access token），`--channel ntfy --topic <topic>`。
- **自定义 webhook**：`--channel custom --url <webhook-url>`，会收到 `POST JSON {title, content, url}`。

## 树内自动模式

插件在 dsh web 进程内注册了一个自动模式（cordis 插件行 `mobile-link`，无命令行界面）。当 `config.json` 的 `autoSend` 为 `true`（或在 dsh 配置里开启 `autoSend`）时，`dsh web` 启动约 8 秒后自动执行与 `start` 相同的流程：确保隧道 → 把隧道主机名动态加入 /api 信任栅栏 → 等待 Web 就绪 → 推送手机链接。

- 开启：`node bin/cli.js setup --auto`，或把 `config.json` 的 `autoSend` 改为 `true`。
- 延迟可在 dsh 配置的 `autoSendDelayMs` 调整（默认 8000 毫秒）。
- **干跑调试**（无需真发，方便验证流程）：
  - `DSH_MOBILE_LINK_DRY_RUN=1`：只打印将发送的内容，不真正推送。
  - `DSH_MOBILE_LINK_TEST=1`：发送测试消息而非真实链接。
  - CLI 的 `--dry-run` / `--test` 标志优先于这两个环境变量。

## cloudflared 说明

- **自动下载**：未在 PATH 或常见位置找到 cloudflared 时，按平台从 GitHub 官方 release 自动下载到缓存 `~/.dsh/mobile-link/bin/`（Windows 为 `cloudflared.exe`）。
- **镜像前缀**：`CLOUDFLARED_BASE` 环境变量可覆盖下载源前缀（如内网镜像 `CLOUDFLARED_BASE=https://mirror.example.com/cloudflared`），缺省用官方 `releases/latest/download`。
- **已装复用**：PATH 或常见安装位置（npm 全局、WinGet、scoop、`~/.cloudflared` 等）已有 cloudflared 时优先复用，不重复下载。
- **唯一隧道所有权**：同一 Web 端口只保留一条受管 quick tunnel。检测到旧版状态、外部/重复 cloudflared 或不健康 metrics 时会停止并替换，避免 DSH 信任主机与屏幕/微信中的 URL 分属两条隧道。
- **严格状态绑定**：复用必须同时匹配 cloudflared PID、目标端口、状态版本、metrics 地址、活动 HA 连接和 metrics 中报告的 `userHostname`；创建过程还需看到本进程的 URL、metrics 与 `Registered tunnel connection`。
- **并发锁**：CLI、安装器和树内自动模式同时触发时会串行管理隧道，不会各自创建不同 URL。日志按端口分文件（`cloudflared-<port>.log`）。

## 与已运行实例的行为

- `start` 先建立**唯一**受管隧道（同端口已有的外部/重复 cloudflared 会被替换），然后检查端口上的监听者：
  - 没有监听者 → 自动启动 `dsh web --trusted-host <隧道主机名>`；
  - 是 DSH 且 `--trusted-host` 与隧道一致 → 直接复用，不重启；
  - 是 DSH 但 `--trusted-host` 不匹配（手机 `/api` 403 的根源）→ 自动重启该 DSH 并带上正确的隧道主机名；
  - 不是 DSH 的进程占用端口 → **不误杀**，直接失败并提示。
- `start` 只有在公网首页 HTTP 200 且 `/api` 不被 403 拦截后才显示/推送链接；`send`、`tunnel`、`status`、`doctor` 同样会对 URL 做公网验证，未验证的 URL 不会显示为可分享链接。
- `send` 检测到 trusted-host 不匹配时**拒绝推送**并提示运行 `start` 修复，避免再次把打不开的链接发到手机/微信。
- 桌面启动器（`DeepSeek Harness 一键启动.cmd`）已改为委托已安装插件 CLI 的 `start --no-push` 管理 3080 隧道与 DSH 信任主机；只有在插件未安装时才回退到计划任务 legacy 隧道模式。OpenBiliClaw（8420）隧道始终由其自身的计划任务管理，不受主隧道清理逻辑影响。

## 安全与隐私说明

- **quick tunnel URL 是公开的**：任何知道该 URL 的人都能访问你暴露的 DSH Web。请勿把推送消息中的链接公开分享；关闭 DSH 或隧道后链接立即失效。
- **不要外传凭证**：Server酱 SendKey、PushPlus token 等凭证仅存本机 `~/.dsh/mobile-link/config.json`（0600）。
- **插件不收集数据**：不向任何第三方上报日志、配置或使用情况；推送只发生在你主动选择的、路由到所选渠道的 HTTP 请求中。
- /api 信任栅栏仍会拦截其它来源的请求，插件只为当前隧道主机名（裸主机名或主机:端口）放行。

## 常见问题

**Q: cloudflared 下载失败 / 网络受限？**
先确认能访问 GitHub。需要走代理或内网镜像时，设置 `CLOUDFLARED_BASE` 指向可用的下载前缀，或手动安装 cloudflared 并加入 PATH（本插件会优先复用）。

**Q: 双击脚本后端口提示被占用 / 已有 DSH 实例？**
如果已有旧 DSH 实例在运行，它会缺少本插件动态放行的隧道主机名。关闭旧实例后重新双击即可。

**Q: 手机打开后界面异常 / 接口 403？**
先确认用的是本插件推送的**最新**链接（隧道 URL 每次重启都变）；然后运行 `node bin/cli.js start`——它会自动把 DSH 的 `--trusted-host` 重启成与当前隧道一致，并做公网首页 + `/api` 双探针验证，验证通过后才推送链接。403（trusted-host 不匹配）是 v0.1.4 之后可以自愈的问题。

**Q: 微信收不到推送？**
运行 `node bin/cli.js doctor` 检查渠道凭证与网络；注意 Server酱等渠道有每日免费额度上限。

**Q: 想换渠道？**
重新运行 `node bin/cli.js setup` 即可，凭证覆盖保存。

**Q: 我有多个 DSH 实例 / 想用别的端口？**
一份 `~/.dsh/mobile-link/config.json` 同时只支持一个 `webPort`。多个实例请分别为各 profile 安装插件，并用 `node bin/cli.js setup --port <端口>` 修改 `webPort` 后重启对应实例。

## 开发说明

- **双轨架构**：独立 CLI（`bin/cli.js`，自己 spawn `dsh web --trusted-host <host>`）+ 树内自动模式（`index.js` cordis 插件行，仅自动推送）。树内**不**注册任何 `dsh web <subcommand>` 命令行——这是为避免与 dsh web-startup 的参数快照解析冲突而作出的取舍，所以所有交互命令都走独立 CLI。
- **入口**：`bin/cli.js`（CLI）、`index.js`（cordis 插件）、`cordis.patch.yml`（bundle patch，只插入 `mobile-link` 插件行）。
- **依赖**：纯 JavaScript，无原生构建；peer 依赖 `@deepseek-ai/schemastery ^3.18.0` 与 `commander ^12 || ^13 || ^14 || ^15`。
- **配置 schema**：见 `index.js` 的 `Config`（`webPort` / `autoSend` / `autoSendDelayMs`）；渠道凭证存 `~/.dsh/mobile-link/config.json`。

## License

[MIT](LICENSE)
