# dsh-mobile-link 一键安装向导（Windows PowerShell）
# 用法：在本目录运行 .\install.ps1，或从 GitHub 下载后右键“使用 PowerShell 运行”。
[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [int]$Port = 3080,
  [string]$SendKey = '',
  [switch]$AutoSend,
  [switch]$SkipPluginInstall,
  [switch]$SkipSetup,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$Repo = 'github:Cheng-xiu/dsh-mobile-link#v0.1.5'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$InstalledCli = Join-Path $DshHome "profiles\$Profile\node_modules\dsh-mobile-link\bin\cli.js"

function Require-Command([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name 未找到。$Hint"
  }
}
function Read-SecretValue([string]$Prompt) {
  $value = Read-Host -Prompt $Prompt
  if ([string]::IsNullOrWhiteSpace($value)) { throw 'SendKey 不能为空。' }
  return $value.Trim()
}

Write-Host ''
Write-Host '=== dsh-mobile-link 一键安装向导 ===' -ForegroundColor Cyan
Write-Host '功能：安装插件、配置 Server酱、启动 DSH 手机隧道并推送微信。' -ForegroundColor Gray
Write-Host ''

Require-Command 'node' '请先安装 Node.js 18.17+：https://nodejs.org/'
Require-Command 'dsh' '请先安装 DeepSeek Harness，并确认 dsh 在 PATH 中。'
$nodeVersion = (& node -p "process.versions.node").Trim()
$nodeParts = $nodeVersion.Split('.')
if (([int]$nodeParts[0] -lt 18) -or (([int]$nodeParts[0] -eq 18) -and ([int]$nodeParts[1] -lt 17))) {
  throw "Node.js $nodeVersion 不受支持；需要 18.17 或更高版本。"
}
if (-not $SkipPluginInstall) {
  Require-Command 'pnpm' '请先安装 pnpm：corepack enable 或 npm install -g pnpm。'
  $pnpmVersion = (& pnpm --version).Trim()
  Write-Host "[i] Node.js $nodeVersion | pnpm $pnpmVersion" -ForegroundColor DarkGray
  Write-Host "[1/4] 安装 GitHub 插件到 profile '$Profile' ..." -ForegroundColor Yellow
  & dsh plugin --profile $Profile add $Repo
  if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败（退出码 $LASTEXITCODE）。请检查 GitHub 网络和 pnpm。" }
} else { Write-Host '[1/4] 跳过插件安装。' -ForegroundColor DarkGray }

if (-not $SkipSetup) {
  Write-Host ''
  Write-Host '[2/4] Server酱配置' -ForegroundColor Yellow
  Write-Host '获取 SendKey：' -ForegroundColor White
  Write-Host '  1. 用微信扫码登录 https://sct.ftqq.com' -ForegroundColor Gray
  Write-Host '  2. 在网站的“SendKey”页面复制形如 SCT... 的密钥' -ForegroundColor Gray
  Write-Host '  3. 只在下面输入框粘贴；密钥仅保存到本机 ~/.dsh/mobile-link/config.json，不会写入仓库。' -ForegroundColor Gray
  $key = if ([string]::IsNullOrWhiteSpace($SendKey)) { Read-SecretValue '请输入 Server酱 SendKey（SCT...）' } else { $SendKey.Trim() }
  if ($key -notmatch '^SCT') { Write-Warning 'SendKey 通常以 SCT 开头，请确认输入正确。' }
  if (-not (Test-Path $InstalledCli)) { throw "插件安装后找不到 CLI：$InstalledCli。请确认 profile '$Profile' 安装成功。" }
  $args = @($InstalledCli, 'setup', '--channel', 'serverchan', '--key', $key, '--port', $Port)
  if ($AutoSend) { $args += '--auto' } else { $args += '--no-auto' }
  Write-Host '[3/4] 写入本机配置 ...' -ForegroundColor Yellow
  & node @args
  if ($LASTEXITCODE -ne 0) { throw "配置失败（退出码 $LASTEXITCODE）。" }
} else { Write-Host '[2/4] 跳过凭证配置（将使用已有配置）。' -ForegroundColor DarkGray }

Write-Host ''
Write-Host '[4/4] 安装完成。' -ForegroundColor Green
Write-Host "目标 profile：$Profile    DSH Web 端口：$Port" -ForegroundColor White
Write-Host '重要：插件安装后必须重启目标 dsh profile 才会注入启动树。' -ForegroundColor Yellow
Write-Host ''
$start = if ($NoStart) { 'n' } else { Read-Host '现在启动/复用 DSH 并推送手机链接？(Y/n)' }
if ($start -notmatch '^[Nn]$') {
  & node @($InstalledCli, 'start', '--port', $Port, '--profile', $Profile)
  if ($LASTEXITCODE -ne 0) { throw "启动失败（退出码 $LASTEXITCODE）。可运行 node `"$InstalledCli`" doctor 查看诊断。" }
} else {
  Write-Host "稍后运行：node `"$InstalledCli`" start --port $Port --profile $Profile" -ForegroundColor Cyan
}
Write-Host ''
Write-Host '常用命令：status / doctor / send / tunnel --stop' -ForegroundColor Gray
