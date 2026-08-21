# GPT Pro 部署与恢复

## 运行组成

| 容器 | 作用 | 对宿主机发布 |
| --- | --- | --- |
| `gpt-pro-cloud-gateway` | 管理、路径登录、敏感操作策略、文件传输、WebSocket 画面与输入、管理员浏览器反代 | 普通入口 `:36090`；管理员浏览器入口默认仅回环 `:36091` |
| `gpt-pro-cloud-desktop` | 一只 KasmVNC 桌面、一只 Chromium 进程、一份持久 Profile、任意数量独立顶层工作区窗口 | 无 |

只有 gateway 进程向宿主机发布监听。desktop 的 KasmVNC `3000/3001`、Chromium CDP `9222/9223` 均不映射到宿主机；网关也不挂 Docker Socket。KasmVNC 的资源依赖原生根路径，因此同一 gateway 进程使用独立管理员监听转发，默认绑定 `127.0.0.1:36091`。

持久数据：

| 路径 | 内容 |
| --- | --- |
| `./data/browser/` | 唯一 Chromium Profile、ChatGPT Cookie、站点存储和机器标识 |
| `./data-panel/state.json` | 管理员、用户密码摘要、工作区、编辑器功能白名单、敏感操作黑名单、起始/最后 URL 与全局浏览器环境设置 |
| `./data-panel/sessions.json` | 管理页和各工作区路径的网关会话 |
| `./data-panel/transfers.json` | 用户私人上传与 Chromium 下载的归属、文件名和状态索引 |
| `./data-transfer/` | 与 Chromium Profile 分离的用户私人上传与远端下载文件 |

三个数据根均被 `.gitignore` 排除。备份时要保护为敏感数据，不能上传到 Git、工单或公开日志。

## 首次启动

```bash
cp .env.example .env
# 按需修改 BIND_ADDR、HTTP_PORT、时区/语言部署值、代理与内部 VNC 密码
./scripts/up.sh
```

若 `AUTH_PASSWORD` 留空，打开 `http://127.0.0.1:36090/admin/` 创建管理员。初始化向导只在没有管理员时出现；必须先在可信本机或内网完成，再开放远程入口。

随后：

1. 核对管理页“浏览器环境”显示的时区和语言。首次启动会尝试通过 Chromium 实际出口自动探测；失败时管理页会明确要求手动核对。
2. 在管理页创建逻辑工作区。ID 会成为 `/w/<id>/`，创建后不支持改 ID；“起始 / 项目地址”建议填写该工作区的 ChatGPT 项目页，以启用严格项目路由限制。
3. 核对“普通工作区 `@` / `+` 功能白名单”。每行是菜单显示的一个完整功能名，不使用位置或数量规则；默认四项为 `Add photos & files`、`Create image`、`Web search` 和 `Deep research`。Sources 的 Add sources 固定只保留 `Upload` 与 `Text input`。
4. 核对“普通工作区敏感操作黑名单”。默认把账号菜单、设置、退出登录、订阅、安全和破坏性全局操作保留给管理员；可按 ChatGPT 当前界面补充文字和 URL 通配规则。
5. 创建本地用户和密码，为其勾选允许访问的工作区。管理员自动拥有全部工作区。
6. 登录 `/admin/` 后，在系统功能区点击“打开管理员浏览器”；在里面登录唯一的 ChatGPT Pro 账号并完成 MFA。退出 ChatGPT、修改全局账号设置和安装 Chrome 扩展也只在这里进行。
7. 打开每个工作区窗口并刷新。每个工作区对应独立顶层 Chromium 窗口，但共用刚才建立的 ChatGPT Cookie。
8. 在办公室、实验室、家里等客户端分别收藏对应 `/w/<id>/` 地址；每条路径可使用不同的网关用户名与密码。

## 校园内网部署

- 只在可信校园网或 VPN 中使用明文 HTTP。
- `BIND_ADDR=0.0.0.0` 会监听所有网卡；如果主机同时有公网网卡，应改成具体内网地址或 VPN 地址。
- 校园网经常存在客户端隔离、动态地址或入站端口限制。先在服务器本机验证 `127.0.0.1:36090`，再从同网段设备验证主机内网 IP。
- 地址会变化时，优先为主机配置校内 DNS、DHCP 保留地址或已有 VPN，不要把网关直接暴露到公网。

## 公网 HTTPS

如确需公网，先完成管理员初始化，再把 `.env` 设为：

```dotenv
BIND_ADDR=127.0.0.1
```

然后让受信任的 HTTPS 反向代理或隧道指向 `http://127.0.0.1:36090`。临时 Cloudflare Tunnel 示例：

```bash
cloudflared tunnel --url http://127.0.0.1:36090
```

不要在公网网卡上以 `0.0.0.0` 发布明文网关。隧道之外仍建议增加组织身份层或访问策略。

普通工作区不需要暴露管理员浏览器端口。若确实需要远程完成 MFA、扩展管理或恢复，可在普通入口的同一主机名上为 `127.0.0.1:36091` 配置另一个受保护的 HTTPS 端口或监听，并把完整地址写入 `MAINTENANCE_PUBLIC_URL`，例如普通入口是 `https://gpc.example.com/`，管理员浏览器可设为 `https://gpc.example.com:8443/`。管理员会话 Cookie 是 Host-only，换成另一个主机名后无法复用登录态；不要与普通入口共用子路径，也不要直接把该端口暴露到公网。

## 代理

`PROXY_URL` 是整个 Chromium 进程的全局代理。宿主机上的 `127.0.0.1`、`localhost` 与 `[::1]` 会改写为 `host.docker.internal`。

所有工作区共享一只 Chromium 进程和网络服务，因此不能让不同 Target 使用不同代理出口。需要多出口时必须运行多份完整部署；那也意味着多份 Profile 和分别登录，不属于本项目的单登录目标。

## 管理员浏览器与普通工作区黑名单

管理员浏览器保留 Chromium 的标签栏、地址栏和菜单。入口直接使用 KasmVNC 核心页面，不启动其音频/文件包装层；Kasm WebSocket 存续时，网关会把未受管的管理员 Chromium 窗口保持在普通工作区窗口之前。管理员可以在这里登录或退出 ChatGPT，打开 `chrome://extensions/`，以及从 Chrome Web Store 安装扩展。该入口不加载普通工作区黑名单，并由管理员网关会话和独立监听共同保护。

普通工作区没有浏览器地址栏、永久顶栏或底部提示，只显示项目画布、常驻的项目首页按钮和默认折叠的控制面板。页面标题使用工作区名称，管理员浏览器标题使用 `GPT Pro`。默认黑名单同时做三件事：

1. 按文字、可访问名称、链接和测试标识隐藏命中控件，并对新增 DOM 做增量复核；
2. 在发送鼠标按下或键盘激活前再次检查命中控件；
3. 通过 Chromium `Network.setBlockedURLs` 阻断匹配的退出登录、停用账号等 URL。

任一受管 Target 若无法完整安装或更新黑名单，不会继续以“已就绪”状态服务；网关会关闭并按持久配置重建它。

项目专注层会隐藏 ChatGPT 网页侧边栏、左上角项目名称/图标入口、项目菜单、分享、Chat/Work 切换、听写和语音入口。固定规则使用当前实测的项目首页、对话与单条消息控件属性，并由项目首页 URL 识别项目名称链接。编辑器功能白名单使用菜单中的完整功能名做不区分大小写的精确匹配，不读取“前五个”或任何下标；未列入的 `@` / `+` 功能会隐藏。普通页面打开的新窗口会立即关闭，顶层页面不能离开 `chatgpt.com`。若“起始 / 项目地址”符合当前支持的项目路由，网关允许项目首页进入或新建项目对话，不要求对话 URL 的 `g-p` 标识与项目首页相同；进入某一对话后，只允许停留在该对话或通过右上角常驻的项目首页按钮返回。

普通点击和键盘激活先由网关读取目标控件的可访问属性与链接，再决定是否发送 CDP `Input` 事件。分享、敏感控件和越界链接不会发送到网页。普通文档请求不经过 CDP `Fetch`，页面也不安装捕获阶段事件拦截器；只有管理员配置的 URL 黑名单使用 `Network.setBlockedURLs`。页面自身导航到越界地址时，导航事件仍会把该 Target 恢复到最后一个允许地址。

上述白名单用于普通页面交互收敛，不会撤销账号已授予第三方的 OAuth 权限。要真正断开 GitHub、Notion、Gmail 等已连接 app，由管理员在 ChatGPT `Settings > Apps` 中执行 Disconnect。

隐藏会向受管文档插入样式和观察器，CDP 远程输入也不是本地浏览器原生事件来源；这些行为可能被网页脚本观察。它们用于降低误操作与越权面，不能宣称“ChatGPT 无法探查”、规避风控或对未来页面结构永久有效。ChatGPT 更改项目 URL 或控件结构后，管理员必须在测试工作区复核。

管理页可逐行编辑编辑器功能白名单、页面文字黑名单和 URL 通配规则。若 ChatGPT 更新了功能名、菜单文字、可访问名称或端点，应在测试工作区上检查后调整规则。管理员敏感操作直接使用管理员浏览器。

## 本机输入法直通

- 普通工作区 viewport 跟随访问页面的实际可用区域。网关将 Chromium 窗口恢复为普通状态，动态测量浏览器边框并同步调整真实窗口与页面视口，移动端画面与输入坐标使用同一块全屏画布。只有点击远端可编辑区域或取得非空远端文本选区后，当前页面的隐藏文本框才获得浏览器焦点；点击 Chat、Sources 等普通控件不会唤起输入法。访问设备的系统输入法负责英文、中文、日文、韩文、表情、dead key、语音转文字和粘贴等文本生成，项目不提供语言按钮、词典、候选服务或输入源快捷键。
- 浏览器组合输入期间，`compositionstart` 到 `compositionend` 之间的候选中间值只留在本机；最终确认文本只提交一次，再通过所属 CDP `sessionId` 的 `Input.insertText` 交给远端焦点。Enter、Backspace、方向键及远端快捷键仍通过 `Input.dispatchKeyEvent` 发送。
- `Cmd/Ctrl+V` 由本机浏览器正常粘贴到隐藏文本框；网关将该文本写入远端 Chromium 剪贴板，再执行一次原生 Paste 编辑事务，不程序化读取本机剪贴板，也不把大段多行文本交给 `Input.insertText`。本机粘贴与 ChatGPT 原生复制共用一个跨工作区队列，多个窗口同时操作时不会串线。
- ChatGPT 原生复制按钮产生的远端剪贴板文本在 CDP 隔离环境读取，不向 ChatGPT 主页面挂载项目状态；十二个窗口短间隔复制仍按远端系统剪贴板顺序逐个返回所属本机窗口。
- macOS 本机的 `Command` 组合按远端 `Control` 语义发送，因此 `Command+A` 会执行远端全选；其它平台继续把本机 `Control` 发送为远端 `Control`。复制、剪切和粘贴仍留在本机浏览器。
- 鼠标或键盘选区完成后，远端纯文本只映射到当前用户页面的隐藏文本框。`Cmd/Ctrl+C` 与 `Cmd/Ctrl+X` 由本机浏览器原生写入本机剪贴板；剪切再通过 Chromium 编辑命令作用于当前远端选区。该通道不广播选区，不程序化读取本机剪贴板，也不复制富文本、图片或文件格式。
- ChatGPT 消息复制按钮保持可见。网关在按钮释放前监听远端 `clipboardchange`，按跨工作区全局顺序完成复制与读取，再把纯文本只交给触发操作的本机窗口；不轮询剪贴板，也不按时间推断归属。
- 管理员浏览器直接强制启用 KasmVNC 官方 IME Input Mode；KasmVNC 自己监听本机组合事件并发送 Unicode，不再加载第二套项目输入法。当前真实事件序列与管理员通道以 Chromium 系浏览器为验收目标。
- 输入桥接代码只处理最终文本和键盘路由，不读取或修改 `/config/chromium/`；容器重建仍由原有卷保留 ChatGPT 登录态。

## 文件传输

普通工作区点击“上传文件”后，文件只流式写入 `data-transfer/uploads/<user-id>/`，不访问网页文件控件。要把文件交给 ChatGPT，用户必须先在 ChatGPT 页面手动点击上传；网关收到该次 `Page.fileChooserOpened` 后才显示当前用户的私人文件，用户勾选并点击“选择文件”后，网关只对该次选择器调用 `DOM.setFileInputFiles`。项目不主动查找 `<input type=file>`，也不保留等待下次选择器的自动注入任务。私人上传默认保留 24 小时，管理页或工作区文件面板也可提前删除。

Chromium 下载统一写入 `data-transfer/downloads/`。网关优先让 CDP 按下载 GUID 命名；Chromium 的持久默认下载目录也固定到同一位置，因此其它 DevTools 会话重置该行为时，网关仍可依据完成事件报告的受限目录路径接管并改名，且不会读取 Profile 内的 `Downloads`。由普通工作区触发的下载只出现在该工作区的“查看文件”面板；管理员可在管理页查看全部下载。由管理员浏览器触发且无法归属工作区的下载只对管理员可见。点击“保存到本机”后，由网关鉴权并以附件响应传给当前设备。

`MAX_FILE_BYTES` 限制单个上传或下载，`TRANSFER_QUOTA_BYTES` 限制目录总量。超过限制的上传会在流式接收过程中终止；Chromium 下载会被取消并删除不完整文件。gateway 和 desktop 只共享 `data-transfer/`，gateway 不挂载 `data/browser/`。

## 时区与语言

`PROFILE_AUTO_DETECT=true` 时，只有在 `state.json` 还没有环境设置的首次启动，网关才会自动请求 `PROFILE_GEO_ENDPOINT`。请求复用已有 CDP 连接，由临时 `about:blank` Target 以 `credentials: omit` 与 `cache: no-store` 发起，经过 Chromium 的真实网络路径和 `PROXY_URL`；读取后立即关闭 Target，不发送 Profile Cookie，也不留下提供商页面历史。

默认 `PROFILE_GEO_ENDPOINT` 用 `fields=success,country_code,timezone.id` 只请求国家代码和 IANA 时区，不要求响应包含公网 IP、地区明细或坐标。网关用国家代码与 CLDR likely-subtags 推导默认语言。自定义端点必须提供同名 JSON 字段；其它字段不会被读取或保存。外部提供商仍能看到请求来源；需要完全离线时使用：

```dotenv
PROFILE_AUTO_DETECT=false
PROFILE_TIMEZONE=Asia/Shanghai
PROFILE_LOCALE=zh-CN
```

管理员手动保存会切换为手动值。点击“按出口 IP 重新探测”才会再次访问外部服务。两种操作都会统一应用以下值并刷新所有工作区 Target 和管理员浏览器页面：

- `Intl.DateTimeFormat().resolvedOptions().timeZone`；
- JavaScript 默认 locale；
- `navigator.language` / `navigator.languages`；
- HTTP `Accept-Language`。

点击“核验当前页面”后，应显示 `N/N` 页面一致；此检查会从当前页面读回时区、locale、语言列表和 User-Agent Client Hints 保留状态，未被网关认领的页面会按不一致处理。

网关保留 Chromium 原生 User-Agent 与 User-Agent Client Hints，不为工作区生成多套设备身份。自动探测失败时优先使用 `PROFILE_TIMEZONE` / `PROFILE_LOCALE`，未设置时采用 `TZ` 与容器 locale，并在管理页保留核对提示。

## 健康检查

```bash
docker compose ps
curl -fsS http://127.0.0.1:36090/healthz
```

健康响应示例：

```json
{
  "ok": true,
  "browser": {
    "connected": true,
    "workspaces": 12,
    "targets": 12,
    "viewers": 12,
    "focusedViewers": 6,
    "visibleViewers": 12,
    "activeWorkspaces": 6,
    "maintenanceActive": false,
    "captureMode": "target-screencast",
    "frameFps": 8,
    "activeFrameFps": 60,
    "capturing": 12,
    "frames": 10542,
    "droppedFrames": 0,
    "throttledFrames": 2130,
    "idleFrames": 640,
    "heartbeatFrames": 96,
    "streamRestarts": 18,
    "streamTier": "congested",
    "streamMaxWidth": 800,
    "streamMaxHeight": 500,
    "streamQuality": 60
  }
}
```

字段含义：

- `connected`：网关是否已连接 Chromium CDP；
- `workspaces`：持久配置中的工作区数量；
- `targets`：当前已认领或重建的逻辑 Target 数量；
- `viewers`：当前普通工作区 WebSocket 数量；
- `focusedViewers` / `visibleViewers`：客户端报告为聚焦或可见的画面连接数；
- `activeWorkspaces`：存在聚焦观看者或两秒内刚发生输入的工作区数；
- `maintenanceActive`：管理员浏览器是否存在活动的 KasmVNC WebSocket；
- `captureMode`：应为 `target-screencast`，表示每个独立窗口使用 Chromium 主动连续帧流；
- `frameFps` / `activeFrameFps`：可见后台和聚焦/最近交互窗口的采样与交付上限，不是实得帧率；
- `capturing`：当前正在运行连续帧流的工作区数量；
- `frames`：网关已接受并交付的源帧数；
- `droppedFrames`：因客户端发送缓冲过高而主动丢弃的过期帧计数；
- `throttledFrames`：已及时确认、但因前后台帧率上限而未继续发送的源帧数；
- `idleFrames`：页面没有 DOM、滚动、输入或尺寸活动时抑制的合成帧数；
- `heartbeatFrames`：静止画面按 `FRAME_IDLE_MS` 复用最后一帧的发送次数；
- `streamRestarts`：观看者可见性或自适应画质档位变化后重启源流的次数；
- `streamTier` / `streamMaxWidth` / `streamMaxHeight` / `streamQuality`：当前按可见工作区数量选择的源流档位、最大尺寸与 JPEG 质量。

网关进程即使在 Chromium 短暂重启时仍可提供管理页，因此容器健康检查不以 `connected` 为唯一生死条件；运行验收应同时检查该字段与 `targets == workspaces`。

## 十二窗口画面压力基线

当前画面调度默认为：聚焦或最近交互窗口交付上限 60 FPS，未聚焦但可见窗口交付上限 8 FPS，静止画面每 2000 毫秒复用最后一帧保活。命名 CDP 隔离环境中的页面信号只监听 DOM 节点/文字、滚动、输入和尺寸变化；一次活动会开启 250 毫秒发送窗口，避免 CDP 事件与合成帧先后顺序造成隔帧误丢。网关按真实经过时间累积前后台帧预算，不假设 Chromium 固定输出 60 FPS。没有可见观看者时停止 `Page.startScreencast` 并最小化远端窗口；源帧立即 ACK，慢客户端只丢弃过期帧。

源流尺寸与质量按可见工作区数量选择：一个窗口最高 `2560×1600` / 质量 90，二至四个为 `1280×800` / 70，五至八个为 `960×600` / 66，九个及以上为 `800×500` / 60。`JPEG_QUALITY` 还会继续限制质量。页面 viewport 不随源流降档，而是跟随当前访问页面的实际尺寸；输入坐标与远端布局保持一致。

2026-08-20 参考实验使用 20 逻辑核、32 GiB 主机，Docker 虚拟环境向容器显示 7.75 GiB。完整链路包含 desktop、gateway、真实 WebSocket 客户端和持续 DOM/变换动画，配置为 JPEG 72、后台 8 FPS、前台 60 FPS。下表均为实得值。

| 场景 | 实得帧率 | 总客户端带宽 | 资源观察 | 网关背压丢帧 |
| --- | --- | --- | --- | --- |
| 1 个前台动态工作区 | 38.30 FPS | 0.87 MiB/s | 未单独采样 | 0 |
| 6 个前台动态 + 6 个后台动态 | 前台 10.33–11.07 FPS；后台 7.47–7.73 FPS | 0.83 MiB/s | 未单独采样 | 0 |
| 12 个前台动态 + 0 个后台 | 每窗 9.20–11.60 FPS | 0.95 MiB/s | desktop 约 172–192% CPU / 1.17–1.26 GiB；gateway 越过建连尖峰后约 11–14% CPU / 63–71 MiB | 0 |
| 1 个静止前台工作区，观察 7 秒 | 4 帧保活；11 帧纯合成画面被抑制 | 极低 | 未单独采样 | 0 |

十二前台的客户端交付速率与页面自身 9.27–11.67 FPS 的动画速率基本一致，说明此时瓶颈是单个 headful Chromium 对十二个同时动态后台窗口的渲染调度，而不是网关串行、限速或背压。`FRAME_ACTIVE_FPS=60` 只是上限；在“一只 Chromium 进程、一份 Profile、一次登录”约束内，无法把十二个操作系统后台窗口变成十二只独立前台浏览器进程。合成页结果也不能替代十二个真实已登录 ChatGPT 对话的长期容量验收。

## 日志

```bash
docker compose logs -f gateway
docker compose logs -f desktop
```

日志不得打印密码、Cookie、会话令牌、探测返回的公网 IP 或 ChatGPT 内容。排障时如需检查 `state.json`，只在主机本地进行；不要把原文件贴到公开渠道。

## 重启恢复验收

网关重启与浏览器重启是两条不同恢复路径：

```bash
# 只重启网关：应通过窗口内运行标记重新认领现有 Target，不能重复开窗口
docker compose restart gateway

# 重启 Chromium 容器：应从 state.json 的 lastUrl 重建每个 Target
docker compose restart desktop
```

两次操作后都检查：

1. `/healthz` 的 `connected` 为 `true`；
2. `targets` 等于 `workspaces`；
3. 各 `/w/<id>/` 路径会话仍归属原用户；
4. 每个窗口能重新收到画面；
5. 在一个窗口输入不会出现在其它窗口；
6. 十二个工作区与管理员浏览器页共十三页读取到相同的时区、locale 和语言列表；
7. 十二个工作区同时在线时 `captureMode` 为 `target-screencast`，`viewers` 与 `capturing` 均为 `12`，`frames` 持续增加且 `droppedFrames` 保持可接受；
8. 普通工作区能从项目首页进入对话并通过常驻按钮返回首页；项目、对话和单条消息的分享入口均不可见且输入前被拒绝；ChatGPT 消息复制按钮可把远端系统剪贴板定向复制到触发窗口；`@` / `+` 菜单只显示管理员按名称允许的功能，命中敏感按钮或 URL 时收到提示，管理员浏览器仍可完整操作；
9. 本机上传只进入当前用户的私人目录；页面未手动打开文件选择器时不得调用 `DOM.setFileInputFiles`，确认后也只能选择该用户的文件；远端下载只能由所属工作区或管理员取回。

Chromium Target ID 和 CDP sessionId 只存在内存，不写入状态文件；重启后发生变化是正确行为。

## 备份与恢复

停止容器后备份可获得最一致的快照：

```bash
docker compose down
tar -czf gpt-pro-cloud-data.tar.gz data/browser data-panel data-transfer
docker compose up -d --wait
```

备份包含 ChatGPT 登录态和本地密码摘要，应当加密保存。恢复时把目录放回原路径，确认文件属主与 `.env` 的 `PUID`、`PGID` 一致，再启动 Compose。

## 更新与回滚

更新代码前先备份数据，然后：

```bash
docker compose up -d --build --wait
npm test
curl -fsS http://127.0.0.1:36090/healthz
```

代码回滚不会自动回滚 `state.json`。代码与状态数据契约必须匹配；不要只回滚镜像却继续使用未经确认的状态文件。

## 已知边界

- 普通工作区不传输声音、麦克风或 ChatGPT 语音模式；这是明确不支持的范围。
- 本机粘贴、远端纯文本选区复制/剪切和 ChatGPT 消息复制按钮均可用；本机粘贴与消息复制经同一全局原子队列操作远端系统剪贴板，复制结果只定向写入触发窗口。富文本、图片和文件剪贴板格式不做同步，文件通过工作区文件面板双向流通。
- 普通工作区依赖访问设备浏览器提供标准 `composition` 与 `input` 事件，管理员浏览器依赖 KasmVNC IME Input Mode；当前正式验收覆盖 Chromium 系浏览器。网页不会替用户切换操作系统输入源。
- 每个可见工作区使用独立连续帧流；聚焦/最近交互、可见后台和静止画面分别使用 `FRAME_ACTIVE_FPS`、`FRAME_FPS` 和 `FRAME_IDLE_MS`。没有可见观看者时停止源流，慢客户端会丢弃过期帧；不能把配置上限当作实得帧率或容量承诺。
- 编辑器功能白名单依赖 ChatGPT 当前的完整功能名和菜单 DOM，黑名单依赖管理员维护的页面文字、可访问名称和 URL 通配规则；项目专注层还依赖当前项目 URL 与分享控件属性。控件隐藏、网关输入检查、网络 URL 阻断和项目导航规则均需在 ChatGPT 改版后复核，不能视为对未知未来端点的永久证明或不可探查机制。
- 管理员浏览器可安装扩展，因此可自行选择 WebRTC、Canvas、GPU、地理位置或硬件信息相关扩展；项目不验证这些扩展的正确性、安全性或风控效果。扩展运行在共享 Profile 中，可影响所有工作区。
- 时区和语言一致性不会伪造一套全新设备指纹，也不能保证规避风控、MFA 或账号挑战。
- 真实 ChatGPT Pro 验收必须由账号持有人在管理员浏览器完成一次授权登录。本仓库和自动化测试不会保存或代填该凭据。
