# GPT Pro 部署与恢复

## 运行组成

| 容器 | 作用 | 对宿主机发布 |
| --- | --- | --- |
| `gpt-pro-cloud-caddy` | 公共受信证书的 DNS-01 签发、续期与普通入口反代 | 内网 HTTPS `:443` |
| `gpt-pro-cloud-gateway` | 管理、路径登录、敏感操作策略、文件传输、WebSocket 画面、输入与通知、管理员浏览器反代 | 本机管理 `:36090`；管理员浏览器默认仅回环 `:36091` |
| `gpt-pro-cloud-desktop` | 一只 KasmVNC 桌面、一只 Chromium 进程、一份持久 Profile、任意数量独立顶层工作区窗口，以及标准 XDG FileChooser Portal 后端 | 无 |

Caddy 是普通用户唯一入口。gateway 的明文端口默认仅绑定 `127.0.0.1`，desktop 的 KasmVNC `3000/3001`、Chromium CDP `9222/9223` 均不映射到宿主机；网关也不挂 Docker Socket。KasmVNC 的资源依赖原生根路径，因此同一 gateway 进程使用独立管理员监听转发，监听地址和管理页跳转均固定为 `http://127.0.0.1:36091/`。

持久数据：

| 路径 | 内容 |
| --- | --- |
| `./data/browser/` | 唯一 Chromium Profile、ChatGPT Cookie、站点存储和机器标识 |
| `./data-panel/state.json` | 管理员、用户密码摘要、工作区、编辑器功能白名单、敏感操作黑名单、起始/最后 URL 与全局浏览器环境设置 |
| `./data-panel/sessions.json` | 管理页和各工作区路径的网关会话 |
| `./data-panel/transfers.json` | 用户私人上传与 Chromium 下载的归属、文件名和状态索引 |
| `./data-transfer/` | 与 Chromium Profile 分离的用户私人上传与远端下载文件 |

三个数据根均被 `.gitignore` 排除。备份时要保护为敏感数据，不能上传到 Git、工单或公开日志。

Compose 的 `portal-runtime` 卷只保存 desktop 与 gateway 之间的两个运行期 Unix socket。它不保存文件、会话或配置，启动时会重建，不属于备份范围。

## 首次启动

```bash
cp .env.example .env
# 填写 DNSPod 专用 CAM 子用户的 SecretId、SecretKey，再按需修改其它部署值
./scripts/up.sh
```

若 `AUTH_PASSWORD` 留空，在部署主机打开 `http://127.0.0.1:36090/admin/` 创建管理员。初始化向导只在没有管理员时出现；普通用户不访问这个明文本机入口。

随后：

1. 核对管理页“浏览器环境”显示的时区和语言。首次启动会尝试通过 Chromium 实际出口自动探测；失败时管理页会明确要求手动核对。
2. 在管理页创建逻辑工作区。ID 会成为 `/w/<id>/`，创建后不支持改 ID；“起始 / 项目地址”建议填写该工作区的 ChatGPT 项目页，以启用严格项目路由限制。
3. 核对“普通工作区 `@` / `+` 功能白名单”。每行是菜单显示的一个完整功能名，不使用位置或数量规则；默认四项为 `Add photos & files`、`Create image`、`Web search` 和 `Deep research`。Sources 的 Add sources 固定只保留 `Upload` 与 `Text input`。
4. 核对“普通工作区敏感操作黑名单”。默认把账号菜单、设置、退出登录、订阅、安全和破坏性全局操作保留给管理员；可按 ChatGPT 当前界面补充文字和 URL 通配规则。
5. 创建本地用户和密码，为其勾选允许访问的工作区。管理员自动拥有全部工作区。
6. 登录 `/admin/` 后，在系统功能区点击“打开管理员浏览器”；管理页会用三十秒内单次消费的随机凭据把当前管理员登录态交接到 `127.0.0.1:36091`，无需再次登录网关。在里面登录唯一的 ChatGPT Pro 账号、完成 MFA，并允许 `chatgpt.com` 发送通知。退出 ChatGPT、修改全局账号设置和安装 Chrome 扩展也只在这里进行。
7. 打开每个工作区窗口并刷新。每个工作区对应独立顶层 Chromium 窗口，但共用刚才建立的 ChatGPT Cookie。
8. 在办公室、实验室、家里等客户端分别收藏 `https://pro.lyhbio.cn/w/<id>/`；每条路径可使用不同的网关用户名与密码。任务完成提醒会直接显示在当前连接的普通页面中。

## 内网 HTTPS

- DNSPod 的 `pro.lyhbio.cn` A 记录指向部署主机私网地址 `10.16.30.152`，TTL 为 600；它不把服务暴露到公网，公网访问者也无法路由到该私网地址。
- Caddy 使用 DNS-01 临时创建 `_acme-challenge.pro.lyhbio.cn` TXT 记录，签发后删除；证书数据保存在 `caddy-data` 卷中并由 Caddy 自动续期。DNS-01 不要求公网能连接部署主机。
- 专用 CAM 子用户只授予 `dnspod:DescribeRecordList`、`dnspod:CreateRecord` 和 `dnspod:DeleteRecord`，不得绑定 DNSPod 全读写或其它腾讯云权限。SecretId 与 SecretKey 只写入被 Git 和 Docker 构建上下文排除的 `.env`。
- `BIND_ADDR=127.0.0.1` 保证普通用户不能绕过 Caddy 访问明文网关。校园网若启用了客户端隔离或阻断 TCP 443，需要由网络管理员放通该主机的内网 443 入站，而不是另加应用 fallback。
- 部署主机地址变化时更新 `pro` 记录并为主机配置 DHCP 保留地址；普通用户书签不变。

普通工作区不需要暴露管理员浏览器端口。管理员登录、MFA、扩展管理与恢复默认只在部署主机完成；不要把 `:36091` 直接发布给普通用户。

## 代理

`PROXY_URL` 是整个 Chromium 进程的全局代理。宿主机上的 `127.0.0.1`、`localhost` 与 `[::1]` 会改写为 `host.docker.internal`。

所有工作区共享一只 Chromium 进程和网络服务，因此不能让不同 Target 使用不同代理出口。需要多出口时必须运行多份完整部署；那也意味着多份 Profile 和分别登录，不属于本项目的单登录目标。

## 管理员浏览器与普通工作区黑名单

管理员浏览器保留 Chromium 的标签栏、地址栏和菜单。入口直接使用 KasmVNC 核心页面，不启动其音频/文件包装层；管理页点击后生成随机交接凭据，三十秒内只允许消费一次，并在本机入口复用当前管理员会话。URL 不包含长期会话令牌，不扩大 Cookie 域，也不通过 Caddy 暴露管理员监听。Kasm WebSocket 存续时，网关会把未受管的管理员 Chromium 窗口保持在普通工作区窗口之前。管理员可以在这里登录或退出 ChatGPT，打开 `chrome://extensions/`，以及从 Chrome Web Store 安装扩展。该入口不加载普通工作区黑名单，并由管理员网关会话和独立监听共同保护。

普通工作区没有浏览器地址栏、永久顶栏或底部提示，只显示项目画布、默认下移且可直接拖动菜单图标整体移动的项目首页、刷新与菜单工具组，以及随工具组移动且默认折叠的紧凑控制面板；项目首页和刷新使用无文字的常见图标常驻显示，刷新紧邻项目首页右侧，低留白的折叠菜单只保留上传文件、查看文件、进入全屏和退出登录。不保留独立拖动把手。当前访问浏览器按工作区保存拖动位置，下次打开时恢复并限制在当前可见视口内。页面标题使用工作区名称，管理员浏览器标题使用 `GPT Pro`。默认黑名单同时做三件事：

1. 按文字、可访问名称、链接和测试标识隐藏命中控件，并对新增 DOM 做增量复核；
2. 在发送鼠标按下或键盘激活前再次检查命中控件；
3. 通过 Chromium `Network.setBlockedURLs` 阻断匹配的退出登录、停用账号等 URL。

任一受管 Target 若无法完整安装或更新黑名单，不会继续以“已就绪”状态服务；网关会关闭并按持久配置重建它。

项目专注层会隐藏 ChatGPT 网页侧边栏、左上角项目名称/图标入口、项目菜单、分享、Chat/Work 切换、听写和语音入口。固定规则使用当前实测的项目首页、对话与单条消息控件属性，并由项目首页 URL 识别项目名称链接。编辑器功能白名单使用菜单中的完整功能名做不区分大小写的精确匹配，不读取“前五个”或任何下标；未列入的 `@` / `+` 功能会隐藏。普通页面打开的新窗口会立即关闭，顶层页面不能离开 `chatgpt.com`。若“起始 / 项目地址”符合当前支持的项目路由，网关允许项目首页进入或新建项目对话，不要求对话 URL 的 `g-p` 标识与项目首页相同；进入某一对话后，只允许停留在该对话或通过本地工具组中的项目首页图标返回。

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
- 管理员浏览器直接强制启用 KasmVNC 官方 IME Input Mode；KasmVNC 自己监听本机组合事件并发送 Unicode，不再加载第二套项目输入法。管理员本机粘贴使用浏览器当次 `paste` 事件的纯文本，先触发 KasmVNC Clipboard Up，再在同一 VNC WebSocket 上发送一次远端 `Ctrl+V`；不读取 Clipboard API，也不使用固定延时。当前真实事件序列与管理员通道以 Chromium 系浏览器为验收目标。
- 输入桥接代码只处理最终文本和键盘路由，不读取或修改 `/config/chromium/`；容器重建仍由原有卷保留 ChatGPT 登录态。

## 普通页面通知

管理员先在完整管理员浏览器中允许 `chatgpt.com` 发送通知；这是共享 Chromium Profile 的全局权限，普通用户页面不会修改。受管 ChatGPT Page Target 实际调用原生 `Notification` 构造器后，网关只把标题和正文实时发给该 Target 所属工作区的当前连接页面，不判断普通对话、Deep Research 或其它任务类型，也不扫描完成状态。

普通页面收到网关消息后，若 `https://pro.lyhbio.cn` 已获普通用户浏览器的网页通知权限，则直接发送系统通知；否则在右上角显示五秒后自动关闭的页面提醒，并在此期间标记标签页标题。用户首次点击普通页面时立即打开浏览器原生授权弹窗；页面加载时不申请，因为浏览器要求权限请求由用户手势触发。提醒不操作远端 ChatGPT、不改变 URL，也不发送输入。

该入口由 Caddy 使用 DNSPod DNS-01 自动签发和续期公共受信证书；普通客户端无需安装证书、策略、扩展或隧道。DNS-01 只要求公网权威 DNS 短暂提供 `_acme-challenge.pro.lyhbio.cn` TXT 记录，不要求公网能连接部署主机。实现依据见 [Caddy DNS challenge](https://caddyserver.com/docs/automatic-https#dns-challenge) 与 [Tencent Cloud DNS Caddy 模块](https://github.com/caddy-dns/tencentcloud)。

通知仅在普通页面仍打开且 WebSocket 保持连接时转发。页面关闭、退出登录、浏览器退出或设备离线后不补发；项目不注册本地 Service Worker，不保存通知内容，也不建立 Push 订阅或离线队列。

## 文件传输

普通工作区点击“上传文件”后，文件只流式写入 `data-transfer/uploads/<user-id>/`，不访问网页文件控件。要把文件交给 ChatGPT，用户必须先在 ChatGPT 页面手动点击上传。Chromium 随后通过会话 D-Bus 调用标准 XDG Desktop Portal FileChooser，并携带触发窗口的 X11 XID；自定义 Portal 后端只接受带 `_GPC_WINDOW_KIND=workspace` 与有效 `_GPC_WORKSPACE_ID` 的 Chromium 顶层窗口，再通过运行期 Unix socket 把请求交给 gateway。网关消费该工作区近期输入所属的用户和普通窗口，只向这个窗口显示私人文件面板。用户确认后，gateway 解析其拥有的上传记录，Portal 再把受限的 `file://` URI 返回 Chromium，由 Chromium 自行创建网页标准 `FileList`。

这条路径不启用 `Page.setInterceptFileChooserDialog`，不调用 `DOM.setFileInputFiles`，不查找网页 `<input type=file>`，也不使用 Linux 对话框坐标自动化。管理员顶层窗口带独立 `administrator` 标记，其 FileChooser 请求由同一后端转交 `xdg-desktop-portal-gtk`，所以完整管理员浏览器仍显示原生 GTK 文件选择器。无有效窗口标记、无近期所属用户输入、用户或工作区归属不一致、请求连接关闭时都取消当次选择，不保留等待下一次选择器的任务。私人上传默认保留 24 小时，管理页或工作区文件面板也可提前删除。

Chromium 下载统一写入 `data-transfer/downloads/`。普通用户明确点击 ChatGPT 的 `Download` 或 `Download file` 后，网关会把网页的同源内容导航转换为带原文件名的 Chromium 下载；当前对话保持不变，普通页面的其它导航限制也不会放宽。网关优先让 CDP 按下载 GUID 命名；Chromium 的持久默认下载目录也固定到同一位置，因此其它 DevTools 会话重置该行为时，网关仍可依据完成事件报告的受限目录路径接管并改名，且不会读取 Profile 内的 `Downloads`。下载完成后，普通用户浏览器发送包含文件名和已保存到私人文件区的系统通知，未授权时改为右上角五秒页面提醒；下载失败时按相同方式显示文件名和网关返回的失败原因。由普通工作区触发的下载只出现在该工作区的“查看文件”面板；管理员可在管理页查看全部下载。由管理员浏览器触发且无法归属工作区的下载只对管理员可见。点击“保存到本机”后，由网关鉴权并以附件响应传给当前设备。

`MAX_FILE_BYTES` 限制单个上传或下载，`TRANSFER_QUOTA_BYTES` 限制目录总量。超过限制的上传会在流式接收过程中终止；Chromium 下载会被取消并删除不完整文件。gateway 和 desktop 只共享 `data-transfer/` 与不持久化的 Portal 运行期 socket，gateway 不挂载 `data/browser/`。

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
    "visibleViewers": 12,
    "maintenanceActive": false,
    "captureMode": "target-screencast",
    "activeFrameFps": 60,
    "capturing": 12,
    "frames": 10542,
    "droppedFrames": 0,
    "throttledFrames": 2130,
    "streamRestarts": 18,
    "streamMaxWidth": 2560,
    "streamMaxHeight": 1600,
    "streamQuality": 72
  }
}
```

字段含义：

- `connected`：网关是否已连接 Chromium CDP；
- `workspaces`：持久配置中的工作区数量；
- `targets`：当前已认领或重建的逻辑 Target 数量；
- `viewers`：当前普通工作区 WebSocket 数量；
- `visibleViewers`：客户端报告为可见的画面连接数；
- `maintenanceActive`：管理员浏览器是否存在活动的 KasmVNC WebSocket；
- `captureMode`：应为 `target-screencast`，表示每个独立窗口使用 Chromium 主动连续帧流；
- `activeFrameFps`：可见窗口的采样与交付上限，不是实得帧率；
- `capturing`：当前正在运行连续帧流的工作区数量；
- `frames`：网关已接受并交付的源帧数；
- `droppedFrames`：因客户端发送缓冲过高而主动丢弃的过期帧计数；
- `throttledFrames`：已及时确认、但因可见页面帧率上限而未继续发送的源帧数；
- `streamRestarts`：观看者可见性、viewport 调整或连接恢复后重启源流的次数；
- `streamMaxWidth` / `streamMaxHeight` / `streamQuality`：所有可见工作区共用的源流最大尺寸与 JPEG 质量；实际帧尺寸不超过当前 viewport。

网关进程即使在 Chromium 短暂重启时仍可提供管理页，因此容器健康检查不以 `connected` 为唯一生死条件；运行验收应同时检查该字段与 `targets == workspaces`。

## 画面资源边界

当前画面调度默认为：普通页面可见时交付上限 60 FPS，并持续交付 Chromium 产生的全部源帧；隐藏时停止 `Page.startScreencast` 并最小化远端窗口，重新可见后立即恢复。网关按真实经过时间累积可见工作区帧预算，不假设 Chromium 固定输出 60 FPS。源帧立即 ACK，慢客户端只丢弃过期帧。

所有可见工作区统一使用最高 `2560×1600` 的源流上限和 `JPEG_QUALITY` 配置的 JPEG 质量；实际源帧不超过当前访问页面的 viewport。其它工作区变为可见时不会再重启当前源流或降低分辨率与压缩质量；输入坐标与远端布局继续跟随 viewport。

固定画质会让多个可见窗口共享更高的渲染与 JPEG 编码负载。`FRAME_ACTIVE_FPS=60` 只是上限；在“一只 Chromium 进程、一份 Profile、一次登录”约束内，实得帧率仍受共享渲染、CPU、内存和带宽限制。修改画质策略后必须重新记录一个、六个与十二个可见工作区的实得帧率、CPU、内存、带宽和背压丢帧，不得沿用低分辨率档位下的历史数据。

## 日志

```bash
docker compose logs -f gateway
docker compose logs -f desktop
```

日志不得打印密码、Cookie、会话令牌、探测返回的公网 IP、通知标题正文或其它 ChatGPT 内容。排障时如需检查 `state.json`，只在主机本地进行；不要把原文件贴到公开渠道。

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
3. 各 `/w/<id>/` 路径会话仍归属原用户；同一用户的新页面或“在此窗口继续”能立即接管，旧页面自动重连不能反向抢回所有权；
4. 每个窗口能重新收到画面；
5. 在一个窗口输入不会出现在其它窗口；
6. 十二个工作区与管理员浏览器页共十三页读取到相同的时区、locale 和语言列表；
7. 十二个工作区同时在线时 `captureMode` 为 `target-screencast`，`viewers` 与 `capturing` 均为 `12`，`frames` 持续增加且 `droppedFrames` 保持可接受；
8. 普通工作区能从项目首页进入对话并通过常驻首页图标返回首页，右侧常驻刷新图标能刷新当前页面，折叠菜单不再重复显示刷新；项目、对话和单条消息的分享入口均不可见且输入前被拒绝；ChatGPT 消息复制按钮可把远端系统剪贴板定向复制到触发窗口；`@` / `+` 菜单只显示管理员按名称允许的功能，命中敏感按钮或 URL 时收到提示，管理员浏览器仍可完整操作；
9. 本机上传只进入当前用户的私人目录；普通工作区手动打开文件选择器后，XDG Portal 请求必须携带该窗口的 X11 工作区标记并只显示近期输入所属用户的私人文件，确认后 Chromium 页面收到标准 `FileList`；源码与运行日志中不存在 CDP 文件选择拦截或 DOM 文件输入写入，管理员窗口仍出现 GTK 原生文件选择器；远端下载成功或失败时已授权浏览器发送系统通知，未授权时在右上角显示五秒页面提醒，文件只能由所属工作区或管理员取回。
10. 管理员浏览器已允许 `chatgpt.com` 通知，真实 ChatGPT 完成通知的标题正文只转发到所属工作区的普通页面；该页面已授权时发送系统通知，未授权时显示右上角五秒页面提醒，其它工作区不收到。

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
- 每个可见工作区使用 `FRAME_ACTIVE_FPS` 上限的独立连续帧流并交付全部源帧；页面隐藏后停止源流，慢客户端会丢弃过期帧。不能把配置上限当作实得帧率或容量承诺。
- 编辑器功能白名单依赖 ChatGPT 当前的完整功能名和菜单 DOM，黑名单依赖管理员维护的页面文字、可访问名称和 URL 通配规则；项目专注层还依赖当前项目 URL 与分享控件属性。控件隐藏、网关输入检查、网络 URL 阻断和项目导航规则均需在 ChatGPT 改版后复核，不能视为对未知未来端点的永久证明或不可探查机制。
- 管理员浏览器可安装扩展，因此可自行选择 WebRTC、Canvas、GPU、地理位置或硬件信息相关扩展；项目不验证这些扩展的正确性、安全性或风控效果。扩展运行在共享 Profile 中，可影响所有工作区。
- 时区和语言一致性不会伪造一套全新设备指纹，也不能保证规避风控、MFA 或账号挑战。
- 真实 ChatGPT Pro 验收必须由账号持有人在管理员浏览器完成一次授权登录。本仓库和自动化测试不会保存或代填该凭据。
