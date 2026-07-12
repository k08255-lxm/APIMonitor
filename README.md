# API Monitor

API Monitor 是一个零依赖的 Node.js 监控工具，提供移动优先的 PWA 和可选的
Android 主屏幕小组件。它可以通过兼容 OpenAI 的 `/v1` 代理采集请求，接收其他
网关上报的标准化事件，读取 Sub2API 统计数据，并以只读方式导入 cc-switch 使用记录。

## 环境要求

- Node.js 22.5 或更高版本（建议使用 Node 24，以获得 cc-switch 导入所需的内置
  `node:sqlite` 读取器）。
- 无需执行 `npm install`。

## 启动

Windows 用户直接双击根目录的 `启动监控.cmd` 即可。启动器会检查 Node.js 版本，复用
已经运行的服务；如果服务未运行，就在后台启动 `server.mjs`，等待 `/health` 正常后
自动打开浏览器。启动日志写入 `data/launcher.log`。

双击 `关闭监控.cmd` 可以一键关闭当前监控服务。关闭器会先核对本机服务的实例标识和
端口，再发出关闭请求；不会按端口强制结束其他 Node.js 程序。

也可以使用命令行启动：

```powershell
Copy-Item .env.example .env
# 编辑 .env，然后执行：
npm.cmd start
```

打开 `http://127.0.0.1:8787/`。如果 PowerShell 阻止了 `npm.ps1`，请使用
`npm.cmd`，或者直接运行服务端：

```powershell
node --env-file-if-exists=.env server.mjs
```

需要脚本化时可以使用 `启动监控.cmd --no-browser`，或用 `--host`、`--port` 覆盖
本次启动参数。

### 手机访问

手机和电脑连接到同一个受信任 Wi-Fi 后，先在 `.env` 中设置较长的
`DASHBOARD_PASSWORD`，然后双击 `启动手机监控.cmd`。这个启动器会强制绑定
`0.0.0.0`，启动完成后会在窗口中显示手机访问地址。访问地址形如
`http://<computer-ip>:8787/`；电脑切换网络后 IP 可能变化，需要重新查看启动窗口。
浏览器的标准 Basic Auth 登录框使用用户名 `monitor` 和你配置的密码。

首次让手机访问时，还需要在 Windows 防火墙中只为“专用网络”允许 TCP `8787` 入站连接。
双击 `允许手机访问.cmd` 并确认 Windows 管理员提示即可自动创建该规则；它只接受
`Private` 网络配置文件上的 TCP `8787`，若发现同名但范围不一致的现有规则会拒绝修改。
也可在“Windows Defender 防火墙 - 高级设置 - 入站规则”中创建该规则，或在以管理员身份运行的
PowerShell 中执行：

```powershell
New-NetFirewallRule -DisplayName "API Monitor (Private LAN)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787 -Profile Private
```

不要为公用网络创建该规则，也不要把面板暴露到互联网。关闭服务时双击 `关闭监控.cmd`。

局域网明文 HTTP 仅适合快速的私有测试。Service Worker 和可安装的 PWA 模式要求
HTTPS（localhost 除外）；正式部署请使用受信任的反向代理、Tailscale Serve 或其他
HTTPS 终止服务。

## 后端状态与控制

网页面板和 Android 原生仪表盘都会通过 `GET /api/backend` 显示 Node.js 后端的
运行状态、监听地址和运行时间；该接口使用与监控面板相同的 Basic Auth 身份验证。

配置 `DASHBOARD_PASSWORD` 后，网页和 Android App 还会提供“重启”和“关闭”按钮，
并以用户名 `monitor` 和该密码向 `POST /api/backend` 发送控制请求。未配置面板密码时，
远程控制会保持禁用，服务端返回 `403`。重启会先让旧实例完成清理，再使用相同的
host/port 启动新实例。

关闭后，HTTP API 已不可用，网页或 Android App 无法让服务自行恢复；请回到电脑双击
`启动监控.cmd`，需要手机访问时则双击 `启动手机监控.cmd`。`关闭监控.cmd` 使用
`data/server-state.json` 中仅供本机校验的控制 token。绝不要复制、上传或向网页、
Android App、他人泄露该文件及其中的 token。

### Windows 开机自启

网页“后端管理”和 Android App“后端管理”均可管理当前 Windows 用户的登录启动项。该操作要求已经设置 `DASHBOARD_PASSWORD`，并与“重启/关闭后端”使用相同的 Basic Auth；它只会写入或删除
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\APIMonitor`，不会创建管理员级服务、计划任务或防火墙规则。

- **登录后持续运行**：登录 Windows 后调用既有启动器，以无浏览器方式保持监控服务运行。
- **随 cc-switch 启动**：登录后只启动轻量监听器；它连续两次检测到 `cc-switch.exe` 已启动后，才调用既有启动器启动监控服务。
- 关闭开关会移除上述当前用户启动项。该功能仅支持 Windows；非 Windows 服务端会如实显示为不可用。

## 数据来源

### 本地代理

让兼容 OpenAI 的客户端指向 `http://127.0.0.1:8787/v1`，而不是上游 URL。
`UPSTREAM_BASE_URL` 默认值为 `https://api.openai.com`。设置 `UPSTREAM_API_KEY`
即可使用一个服务端凭据；留空时，服务会透传请求传入的 Authorization 请求头。
请求正文、提示词和响应内容不会写入事件日志，只保留模型、用量和耗时等元数据。

当服务端使用 `UPSTREAM_API_KEY` 且 `HOST` 不是回环地址时，还必须设置
`PROXY_TOKEN`。客户端调用 API Monitor 时将该 token 作为 API 密钥，监控服务会将
它替换为上游密钥。若代理对局域网可见但没有 proxy token，服务将拒绝启动。

### Sub2API

可以配置管理员密钥或用户 JWT：

```dotenv
SUB2API_BASE_URL=https://sub2api.example.com
SUB2API_ADMIN_KEY=replace-me
SUB2API_SCOPE=admin
SUB2API_TIMEZONE=Asia/Hong_Kong
```

如果只查看用户范围的数据，请使用 `SUB2API_SCOPE=user` 和 `SUB2API_TOKEN`。
连接器使用 Sub2API 的面板和用量接口，并按 `CONNECTOR_CACHE_SECONDS` 缓存结果
（默认 10 秒）。它不会连接或读取 Sub2API 数据库。

服务启动后，打开面板右上角的齿轮按钮即可在应用内修改这些信息。管理员 Key 和用户
JWT 只会保存到服务端 `data/settings.json`，设置接口不会把密钥回传到浏览器；输入框显示
“已保存”时留空即可保留原凭据。若服务绑定到非回环地址，修改设置前必须配置
`DASHBOARD_PASSWORD`。应用内保存的数据源设置优先于对应的环境变量；如需恢复为
`.env` 配置，请先停止服务，再删除 `data/settings.json` 后重新启动。

### cc-switch

连接器会在 Windows 上自动检测 `%USERPROFILE%\\.cc-switch\\cc-switch.db`
（其他系统为 `~/.cc-switch/cc-switch.db`）。也可以通过以下配置覆盖路径：

```dotenv
CC_SWITCH_DB_PATH=C:\\Users\\you\\.cc-switch\\cc-switch.db
```

数据库使用 Node 的 `node:sqlite` 以只读方式打开；不会修改或复制数据库文件。
如果文件不存在，该数据源会自动保持未启用。此连接器要求较新的 Node 运行时。
也可以在面板的设置界面关闭自动检测，或填写服务端电脑上的自定义数据库路径；保存后会
立即重建连接器，不需要手动编辑配置文件。

### 选择数据源

配置多个数据源时，`/api/dashboard?source=auto`（默认）按以下顺序选择一个主数据源：
Sub2API、cc-switch、本地代理。这样可以避免 cc-switch 经由 Sub2API 发送流量时被
重复统计。使用 `source=local`、`source=sub2api` 或 `source=cc-switch` 查看单个
数据源；如果确实需要相加统计总数，则明确使用 `source=all`。

网页界面在提供数据源选择器时也会显示相同选项。数据源状态标记会独立显示各连接器
的健康状况，不受当前统计数据源选择影响。

## 事件上报

其他网关可以向 `POST /api/events` 发送元数据。如果设置了 `INGEST_TOKEN`，请发送
`Authorization: Bearer <token>`。

```powershell
$event = @{
  service = 'gateway-a'
  model = 'gpt-5.5'
  inputTokens = 1200
  outputTokens = 340
  latencyMs = 820
  status = 200
  cost = 0.0042
  keyId = 'team-a' # 使用标签或哈希值，绝不要使用原始密钥
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/events `
  -ContentType 'application/json' -Body $event
```

该接口也接受最多 1000 条事件组成的数组。健康事件可以使用 `type=health`、
`service`、`healthy` 和 `status` 字段。

## Android 小组件

`android-widget/` 包含一个标准 Java `AppWidgetProvider` 和一个原生 Material Design 3 仪表盘。
该目录是源码，不包含可直接安装的 APK；必须先构建并把 APK 安装到手机，系统的
“小组件”列表才会出现“API 监测台”。完整的构建、安装、添加到桌面和后续修改配置的
步骤见 [android-widget/README.md](android-widget/README.md)。构建工具准备完成后，
双击 `构建安卓小组件.cmd`，在窗口中审阅并确认 Android SDK 许可证；脚本会安装 SDK 35
并生成和验证 `android-widget/app/build/outputs/apk/release/app-release.apk`。它会保存本机私有
签名信息，确保后续版本可覆盖更新。签名备份和“签名不一致”的处理步骤见
[android-widget/SIGNING.md](android-widget/SIGNING.md)。小组件按照 Android
通常的 30 分钟最短周期轮询，也支持手动刷新。组件目标为 `4 x 5`，点击组件主体会进入
原生 Material Design 3 仪表盘，其中包含网页面板的核心指标、数据源/时间范围、趋势、
最近调用、模型排行和累计总览；不会跳转到浏览器。

小组件始终只显示最近五条，保证 `4 x 5` 布局稳定；App 仪表盘则最多显示最近 50 条。App 支持 6/12/24 小时或全部趋势窗口、模型横向柱状排行，以及点按数据在紧凑单位和精确数值之间切换。后端管理页提供运行详情、启停和开机自启模式。首页的“检查更新”会查询 GitHub 正式发布，发现新版本后可下载、校验并交给 Android 系统安装器完成更新；首次更新需要在系统页面授权该 App 安装未知来源应用。

如果使用局域网 HTTP URL，需要按照 `android-widget/README.md` 的说明启用明文流量；
生产环境请使用 HTTPS 并关闭明文访问。

## 检查

```powershell
node --check server.mjs
node --check public/app.js
node --test
```

`npm.cmd run check` 会运行以上全部检查。服务启动后还可以运行演示数据写入器：

```powershell
npm.cmd run demo
```

演示事件会通过公开的事件上报接口发送；停止服务后删除 `data/events.jsonl` 即可
移除这些数据。

## 安全说明

- 除非确实需要局域网访问，否则保持默认的回环地址绑定。
- 在让其他设备访问面板前设置 `DASHBOARD_PASSWORD`。
- 在接受其他进程上报事件前设置 `INGEST_TOKEN`。
- 只要局域网可见的代理使用了 `UPSTREAM_API_KEY`，就必须设置 `PROXY_TOKEN`。
- 绝不要把上游密钥放进浏览器 URL 或事件负载中。
- 代理只转发 `/v1` 路径，会阻止路径穿越、移除逐跳请求头，并限制请求/响应大小和
  超时时间。
- 当前紧凑面板会把未知模型的价格显示为零；需要准确计费时，请提供明确的 `cost`
  值或配置 `MODEL_PRICING_JSON`。
