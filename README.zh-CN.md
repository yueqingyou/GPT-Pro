<div align="center">

<img src="assets/hero.svg" alt="GPT Pro——一份已登录的 Chromium Profile 与多个独立工作区 Target" width="100%">

# GPT Pro——一个 Pro 登录，多个独立工作窗口

[![Docker](https://img.shields.io/badge/docker-compose-2496ED?style=flat-square&logo=docker&logoColor=white)](docker-compose.yml)
[![Node.js](https://img.shields.io/badge/node.js-22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](gateway/)
[![Chromium](https://img.shields.io/badge/chromium-CDP-4587F3?style=flat-square&logo=googlechrome&logoColor=white)](docker/)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-178F5F?style=flat-square)](Deploy.md)
[![License](https://img.shields.io/badge/license-MIT-1a1a18?style=flat-square)](LICENSE)

[English](README.md) | **简体中文**

</div>

GPT Pro 在你控制的机器上运行一份持久化 Chromium Profile。你只登录一次 ChatGPT，然后按需创建任意数量的逻辑工作区。每个工作区都是一个独立顶层 Chromium 窗口中的 Page Target，拥有固定的网关地址、画面流与输入通道；所有窗口共享同一份 ChatGPT Cookie 与 Pro 权益。

这个 fork 的主要场景是一位操作者在办公室、实验室、家里等多个地点使用同一个 Pro 账号，同时希望每个项目始终回到自己的页面，不被其它窗口打断。

> **账号政策边界：**网关用户名只是本地访问与路由凭据，不是不同的 ChatGPT 身份。不同人员共用一个 ChatGPT 账号可能违反 OpenAI 的条款或政策；本软件不会让账号共享自动变得合规，也与 OpenAI 没有从属关系。

## 架构

```text
客户端 /w/project-a/ ── 路径独立登录 ─┐
客户端 /w/project-b/ ── 路径独立登录 ─┼─▶ gateway ─▶ CDP sessionId ─▶ 独立窗口 A / B / …
客户端 /w/project-n/ ── 路径独立登录 ─┘                         │
                                                                    ▼
                                                   一只 Chromium 进程 + 一份 Profile
                                                   一次 ChatGPT 登录 + 一套网络栈

管理员 ─▶ /admin/maintenance/ ─▶ 完整 KasmVNC Chromium 浏览器
```

- 工作区和用户由持久化数据动态创建；主机资源允许时可继续增减。已认证管理页无需手动刷新即可获取运行状态变化，按在线优先、离线在后排列工作区并在同组内保持配置顺序；每个折叠标题行常驻显示在线或离线，同一工作区有多个普通窗口时显示实际连接数。
- 每个普通网关用户在全部获授权工作区中只能有一个活跃观看连接，每个页面使用独立的运行期观看标识。打开新页面或显式点击继续后立即接管；自动重连只能恢复同一页面，不能在其它页面接管后反向抢回所有权。不同用户仍可同时在线，也可以连接同一工作区。
- 每个工作区 Target 会在自己的顶层窗口内写入运行标记。网关重启时认领现有窗口；Chromium 重启时按持久化的最后 URL 重建。
- 客户端窗口使用 `/w/<workspace-id>/`。其 HttpOnly Cookie 只作用于这条路径，所以同一个本地浏览器 Profile 可以在不同工作区窗口同时登录不同的网关用户。
- 鼠标、键盘和文本输入都携带当前工作区的 CDP `sessionId`；客户端拿不到原始 Target ID 或 DevTools 凭据。
- 每个可见工作区独立启动 CDP 连续帧流，由 Chromium 主动推送 JPEG，不再逐帧调用截图命令，也不存在跨工作区的全局串行队列。源帧到达后立即确认，网关按真实经过时间执行可见工作区交付预算，并持续交付 Chromium 产生的全部源帧；页面隐藏后停止流并最小化远端窗口，重新可见时立即恢复。慢客户端只丢弃过期帧，不会无界堆积缓冲。
- 普通工作区 Target 加载管理员可配置的敏感操作黑名单：命中控件会隐藏，点击或键盘激活在网关发送 CDP `Input` 事件前再次检查，明确的 URL 黑名单由 Chromium 阻断。已授权项目中的当前会话操作菜单作为一个普通用户操作面整体保留；分享、移动或移出项目和跨项目限制优先执行，其余可见菜单项均绕过账号级文字规则，包括重命名、置顶或取消置顶、归档或取消归档和删除。页面不再安装捕获阶段事件拦截器，普通文档请求也不会经 `Fetch` 暂停、继续或改写。DOM 变化只复核新增区域。账号、订阅、安全、全局设置与 ChatGPT 退出登录只在管理员浏览器操作。
- 普通入口只显示项目画布、默认下移且可直接拖动菜单图标整体移动的项目首页、刷新与菜单工具组，以及随工具组移动且默认折叠的紧凑控制面板；项目首页和刷新使用无文字的常见图标常驻显示，刷新紧邻项目首页右侧，低留白的折叠菜单只保留上传文件、查看文件、进入全屏和退出登录。控制面板标题右侧只显示当前工作区的连接健康状态；上传、文件选择、剪贴板、权限和策略结果统一使用菜单外单条五秒页面反馈，不再覆盖连接状态。不保留独立拖动把手。当前访问浏览器会按工作区记住上一次位置，并在下次打开时恢复到当前可见视口内。网页端侧边栏、左上角项目名称/图标入口、项目菜单、分享、Chat/Work 切换、听写与语音入口会在受管页面隐藏。项目首页分享、对话分享和单条消息分享在输入发送前同时拒绝。管理员可逐行配置 `@` / `+` 功能白名单，规则按完整功能名匹配，不依赖位置或数量；默认只允许 `Add photos & files`、`Create image`、`Web search` 和 `Deep research`。Sources 的 Add sources 固定只保留 `Upload` 与 `Text input`。普通页面打开的新窗口会立即关闭，顶层页面也不能离开 `chatgpt.com`。起始地址是已识别的 ChatGPT 项目 URL 时，项目首页可以进入或新建项目对话，即使 ChatGPT 为对话路由分配了不同的 `g-p` 标识；进入某一对话后，只允许停留在该对话或通过常驻首页图标返回配置的项目首页。该机制会修改 DOM/CSS，属于界面与权限收敛，不是“网页不可探查”或规避风控保证。
- 管理员入口直接使用 KasmVNC 核心页面，不启动音频/文件包装层。管理页按钮使用三十秒内单次消费的随机凭据，把当前管理员登录态交接给仅回环可达的入口；长期会话令牌不会写入 URL，也不要求再次登录。Kasm 连接存续时，桌面 IPC 只会保持唯一标记的管理员 X11 顶层窗口在最前；普通剪贴板事务不会激活工作区窗口，也不会按 CDP Target 顺序猜测管理员页面。远端管理员窗口完成的下载经已认证网关入口直接交给当前本机浏览器，不增加管理员文件查看器。该入口用于 ChatGPT 登录/退出、MFA、Profile 全局管理和 Chrome 扩展安装，不是普通工作区并发通道。
- 本机上传只保存到当前用户的私人目录，不会自动交给 ChatGPT。每个用户有 1 GiB 私人上传空间；文件保留到用户或管理员手动删除，不另设单文件或全服务器应用级上限。用户在 ChatGPT 页面点击上传后，Chromium 发出的 Linux XDG Desktop Portal FileChooser 请求按触发窗口路由到工作台私人文件面板；用户确认后，由 Chromium 从返回的本机文件 URI 生成标准网页 `FileList`。传输过程不使用 CDP 文件选择拦截、DOM 文件输入写入、网页选择器或坐标自动化；管理员窗口仍使用 GTK 原生文件选择器。用户明确触发的 ChatGPT 下载会转换为当前工作区的 Chromium 下载并只经过独立传输目录；下载完成或失败后，已获权限的普通用户浏览器发送系统通知，否则通过菜单外共用页面反馈显示文件名并在五秒后关闭。普通页面导航限制不因此放宽，gateway 也不挂载 Chromium Profile。
- 时区、JavaScript 默认 locale、`navigator.languages` 和 HTTP `Accept-Language` 是唯一 Profile 的全局设置，所有 Target 与管理员浏览器保持一致。
- 普通工作区把访问设备本机浏览器接收到的英文、中文、日文、韩文、表情、粘贴或其它最终文本直接提交给所属 Target；输入法候选和未完成组合始终留在本机。远端纯文本选区只映射到当前用户页面的隐藏输入框，因此原生 `Cmd/Ctrl+C` 与 `Cmd/Ctrl+X` 可以复制或剪切到访问设备的剪贴板。ChatGPT 消息复制按钮保持可见，并把产生的远端系统剪贴板文本交给点击它的本机窗口。管理员桌面直接启用 KasmVNC 的原生 IME Input Mode；本机粘贴会先把当次浏览器 `paste` 事件的纯文本通过 Clipboard Up 写入远端剪贴板，再发送一次远端 `Ctrl+V`，避免先粘贴上一次的远端剪贴板。
- 管理员在完整浏览器中启用 `chatgpt.com` 通知后，受管页面实际产生的原生网页通知会把标题和正文实时转发给所属工作区。系统通知严格只用于这些 ChatGPT 原生事件以及下载完成、下载失败；当前本地来源已获权限时始终发送，不根据页面焦点或可见性抑制，成功创建后也不重复显示页面提醒。权限不足、来源不安全、API 不支持或创建失败时，才通过菜单外共用页面反馈显示五秒并临时标记标签页标题。公共受信 CA 签发且只在内网解析的 HTTPS 入口不要求普通用户安装证书、策略或扩展，首次点击页面时打开浏览器原生授权弹窗；未受管的 HTTP 页面只能使用不要求本机通知权限的页面提醒。

## 本机部署

要求：Docker 与 Compose v2。macOS、Windows 可用 Docker Desktop，Linux Docker 主机也可运行。

```bash
git clone https://github.com/yueqingyou/GPT-Pro.git
cd GPT-Pro
cp .env.example .env
# 在 .env 中替换 PUBLIC_HOST，并填写 DNSPod 专用子用户凭据
./scripts/up.sh
```

管理员在部署主机打开 `http://127.0.0.1:36090/admin/`；普通用户只访问配置的 `https://gpt-pro.example.com/w/<id>/` 入口：

1. 创建管理员；若已通过 `AUTH_PASSWORD` 预设，则直接登录。
2. 核对“浏览器环境”。首次启动会按 Chromium 实际出口自动探测时区与语言；结果不合适时由管理员手动改写。
3. 若 ChatGPT 已有 Projects，点击“读取 Projects”预览并导入所选；工作区名、用户名和初始密码使用项目名，冲突项不会覆盖。也可手动新增逻辑工作区。
4. 按需手动新增本地用户并分配工作区。用户和工作区数量都不写死。
5. 核对“`@` / `+` 功能白名单”。每行保存一个菜单显示的完整功能名；清空列表会禁用所有编辑器菜单功能。
6. 核对“普通工作区敏感操作黑名单”。默认会把账号菜单、设置、退出登录、订阅、安全和破坏性全局操作保留给管理员。
7. 登录 `/admin/` 后，在系统功能区点击“打开管理员浏览器”；只在这里登录一次 ChatGPT，并完成 MFA、通知权限、退出登录与 Chrome 扩展管理。
8. 打开或刷新每个工作区，把各自的 `/w/<id>/` 地址保存为地点专属书签；任务完成提醒会直接显示在当前连接的普通页面中。

`./data/browser/` 保存唯一 Chromium Profile 与 ChatGPT 登录态；`./data-panel/state.json`、`sessions.json` 与 `transfers.json` 保存网关状态；`./data-transfer/` 保存按用户隔离的私人上传与 Chromium 下载。三个数据根均被 Git 忽略。

## 多地点、多窗口如何使用

例如管理员创建：

| 网关地址 | 本地凭据 | Chromium Target |
| --- | --- | --- |
| `/w/office-project/` | `office-login` 与其密码 | 一个持久页面 |
| `/w/lab-project/` | `lab-login` 与其密码 | 另一个持久页面 |
| `/w/home-review/` | 任意获授权用户 | 再一个持久页面 |

三个地址使用不同本地用户时，可以同时开在同一个本地 Chromium Profile 中。多个工作区的路径 Cookie 可以继续保持登录，但同一本地用户打开新的观看窗口后，会停止并接管自己的旧窗口。不同用户仍共享同一个远端 ChatGPT 登录，因为所有 Target 都在同一份远端 Profile 中。

## 配置

带注释的 [`.env.example`](.env.example) 是配置基准。

| 变量 | 作用 |
| --- | --- |
| `AUTH_USER` / `AUTH_PASSWORD` | 可选预建管理员；密码留空则使用首次访问向导 |
| `PUBLIC_HOST` | 普通用户 HTTPS 域名，例如 `gpt-pro.example.com` |
| `HTTPS_PORT` | 普通 HTTPS 入口显式发布的宿主机 IPv4 端口，默认 `443` |
| `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` | 仅允许 DNSPod 查询、创建和删除验证记录的专用 CAM 子用户凭据 |
| `BIND_ADDR` / `HTTP_PORT` | 本机网关管理与健康检查入口，默认仅回环 |
| `MAINTENANCE_PORT` | 仅管理员使用的完整 Chromium 浏览器端口；监听地址和管理页跳转固定为 `127.0.0.1` |
| `PUID` / `PGID` / `TZ` | desktop 与 gateway 数据属主及容器启动时区；`TZ` 也是自动探测失败后使用的部署值 |
| `START_URL` | 管理员浏览器的初始页面 |
| `PROXY_URL` | Chromium 全局代理；宿主机回环地址会为 Docker 改写 |
| `CADDY_PROXY_URL` | 仅供 Caddy 使用的可选容器可达 HTTP 代理；留空则直连 |
| `PROFILE_AUTO_DETECT` | 首次启动时是否按 Chromium 实际出口探测环境，默认 `true` |
| `PROFILE_GEO_ENDPOINT` / `PROFILE_GEO_TIMEOUT_MS` | 允许浏览器 CORS 且返回时区与语言或国家代码的 HTTPS 端点与超时，默认 `https://ipwho.is/?fields=success,country_code,timezone.id` / `5000` |
| `PROFILE_TIMEZONE` / `PROFILE_LOCALE` | 自动探测失败或被禁用时使用的可选部署值 |
| `VNC_PASSWORD` | 内部管理员浏览器凭据；VNC 不发布到宿主机 |
| `FRAME_ACTIVE_FPS` | 可见工作区的采样与交付上限，默认 `60` |
| `JPEG_QUALITY` | 画面流 JPEG 质量，范围 `35–90`，默认 `72` |

所有 Target 共用同一只 Chromium 进程和网络栈，因此本版有意不支持按工作区设置不同代理。

## 浏览器环境一致性

首次启动且还没有持久化设置时，网关会复用已有 CDP 连接，在临时 `about:blank` Target 中以 `credentials: omit` 和 `cache: no-store` 请求 `PROFILE_GEO_ENDPOINT`，读取后立即关闭 Target。它不会把用户页面导航到探测站点，也不会向提供商发送 Profile Cookie 或留下页面历史。因此探测看到的是 Chromium 的实际出口，设置 `PROXY_URL` 时也不会误用 gateway 容器的直连 IP。默认请求通过 `fields` 参数只要求国家代码和 IANA 时区，不要求返回公网 IP、城市或坐标；语言由国家代码与运行时 CLDR likely-subtags 推导。自定义提供商若仍返回额外字段，网关也不持久化或记录它们。探测服务仍会看到那次请求；不愿使用外部服务时设为 `PROFILE_AUTO_DETECT=false`。

自动探测只在未设置的首次启动发生，之后不会因容器重启而自动改变浏览器环境。全局代理或部署地点变化后，管理员可点击“按出口 IP 重新探测”；也可直接填写例如 `Asia/Shanghai` 和 `zh-CN`。保存后网关将同一组设置应用到所有工作区和管理员浏览器，然后统一刷新。“核验当前页面”会实际读取页面的时区、locale、语言列表和 Client Hints 保留状态；任何未被网关认领的页面也会按不一致处理，而不是只复述状态文件。

IP 归属地提供的语言只是地区默认推断，不一定等于操作者偏好，所以管理页会显示完整结果供核对。这组设置只是减少明显的 IP、时区与语言不一致，不是“规避风控”或账号安全保证。稳定的出口、设备环境、使用节奏与账号合规仍需要操作者自行负责。

## 当前交互能力

普通工作区窗口支持：

- 相互独立的 JPEG 画面流；
- 鼠标点击、拖动时的指针移动和滚轮；
- 键盘导航、快捷键与文字输入；
- 访问设备本机输入法产生的 Unicode 文本与原生粘贴；
- 把当前远端纯文本选区原生复制或剪切到访问设备的剪贴板；
- 通过 ChatGPT 消息复制按钮把远端系统剪贴板复制到触发操作的本机窗口；
- 把 ChatGPT 页面实际产生的通知标题和正文转发为系统通知，并在无法发送时使用页面反馈；
- 把本机文件保存到用户私人目录，并在 ChatGPT 手动打开原生文件选择请求后通过工作台确认使用；
- 在工作区文件面板中，把远端 Chromium 已完成的下载保存回本机；
- 执行已授权项目中呈现的会话操作，包括重命名、置顶、归档和删除；
- 返回项目首页、页面刷新与浏览器全屏；
- 默认折叠的控制面板；普通画面没有永久顶栏或底部提示，浏览器标题直接使用工作区名称。

当前限制：

- 富文本、图片和文件剪贴板格式不会同步，选区与 ChatGPT 消息复制按钮只传输纯文本；
- 音频、麦克风和 ChatGPT 语音模式尚未传输；
- 不同用户同时连接同一工作区时，只共享一套 viewport；
- Chromium 连续帧流仍消耗共享渲染器、JPEG 编码、CPU、RAM 与带宽；可见窗口使用 `FRAME_ACTIVE_FPS`，页面隐藏后停止流；
- 通知只在普通页面仍打开并保持连接时实时转发，页面关闭或设备离线后不补发；
- 帧率配置是采样与交付上限而非实得帧率保证；多页同时变化时，共享 Chromium 的渲染和编码能力仍是上限；
- 管理员安装的扩展运行在共享 Profile 中，可影响全部工作区；其权限、指纹行为和更新不属于本项目的安全保证。

普通工作区 viewport 跟随访问页面的实际可用区域，手机竖屏不会套用桌面最小宽度；网关会将 Chromium 窗口恢复为普通状态，动态测量当前浏览器边框，再同步调整真实窗口和页面视口，画面与点击坐标始终铺满同一个画布。点击远端可编辑区域或取得非空远端文本选区后，网关才让当前页面的隐藏文本框获得本机浏览器焦点，点击 Chat、Sources 等普通控件不会唤起输入法。可打印字符、dead key 与 IME 组合都由访问设备的操作系统和浏览器处理；候选更新产生的中间 `insertCompositionText` 不发送，只有最终确认文本才通过当前工作区的 CDP `sessionId` 和 `Input.insertText` 注入远端。本机原生粘贴会写入远端 Chromium 剪贴板并执行一次原生 Paste 编辑事务，不再把大段多行文本交给 `Input.insertText`。Enter、Backspace、方向键和远端快捷键仍走键盘事件通道，因此 ChatGPT 的发送、换行、删除和导航语义不变。

项目不定义输入源切换快捷键，也不保存语言模式、拼音缓冲或候选词。每个本地浏览器页面拥有自己的组合状态；一个窗口正在选词不会改变另一个窗口。鼠标或键盘选区完成后，远端纯文本只映射到当前窗口的隐藏输入框；`Cmd/Ctrl+C`、`Cmd/Ctrl+X` 与 `Cmd/Ctrl+V` 均使用访问设备浏览器的原生剪贴板事件，项目不程序化读取本机剪贴板。所有普通 Target 共用一份远端系统剪贴板，因此本机粘贴与 ChatGPT 原生复制操作共用一个跨工作区队列；远端剪贴板访问只运行在 CDP 隔离环境，并且只在当前排队事务中模拟文档焦点，不激活工作区的 X11 窗口，每次复制结果只返回触发它的窗口。macOS 本机的 `Command` 组合按远端 `Control` 语义发送，其它平台继续把本机 `Control` 发送为远端 `Control`。管理员浏览器使用 KasmVNC 官方 IME Input Mode，把同一访问设备的系统输入法直接交给远端桌面。当前真实事件序列以 Chromium 系浏览器为验收目标。

需要浏览器地址栏、标签栏、原生桌面对话框或共享 Profile 管理时，使用管理员浏览器；不要把它当作普通用户入口开放。

## 安全边界

- Caddy 只在显式配置的宿主机 IPv4 端口发布普通 HTTPS 入口；gateway 的 `:36090` 和管理员浏览器的 `:36091` 默认仅绑定回环。打开管理员浏览器时会消费一个三十秒有效的一次性交接凭据，在 `127.0.0.1` 复用已认证的管理员会话；不通过 DNS、Caddy 或父域 Cookie 扩大这个本机边界。desktop 容器、Chromium DevTools 与原始 KasmVNC 端口仍只在私有网络内。
- desktop 镜像安装与 Chromium 完全同版本的 Debian setuid sandbox，并且只有该服务增加 `SYS_ADMIN`，供 helper 创建 renderer 的 PID 与网络命名空间。Chromium 仍按 `PUID` / `PGID` 运行且没有有效 capability；部署不使用 `privileged`、`--no-sandbox` 或不受限的容器 seccomp profile。
- 网关不再挂载 `/var/run/docker.sock`。
- 密码使用逐用户随机盐的 scrypt 摘要；状态和会话文件以当前用户私有权限创建。
- 登录有限流。修改密码、停用用户或调整工作区授权时，会撤销该用户现有会话和 WebSocket。
- 每个普通用户只能保留一个活跃工作区 WebSocket；打开新页面或显式继续会替换旧连接，自动重连携带原页面标识，所有权已转移时会被拒绝。停止页面的路径独立登录仍保留，可由用户明确重新载入后接管。
- Projects 导入只捕获共享 Profile 中 ChatGPT 页面发出的已授权侧栏响应，不读取或重放登录令牌；列表需要分页或结构变化时会拒绝导入。
- 按完整名称匹配的编辑器功能白名单和敏感操作黑名单都会持久化，只作用于受管普通工作区 Target；分享、移动或移出项目和跨项目导航仍是不可由普通用户关闭的固定规则，其余可见会话菜单操作允许执行。路径会话只能通过该网关用户获授权的工作区、当前 viewer 所有权和该工作区 CDP session 发送输入。管理员明确把多个用户分配到同一工作区时，这些用户共享该项目的会话内容和操作权限；网关不宣称在一个共享项目内继续按会话创建者隔离。管理员浏览器不受影响。网站文字、DOM 和端点可能变化，ChatGPT 大幅改版后应复核这些规则。
- 隐藏并阻止未列入白名单的 ChatGPT app 不是第三方 OAuth 授权的账号级撤销；要取消已存在的 GitHub、Notion、Gmail 等连接，仍应由管理员在 ChatGPT `Settings > Apps` 执行 Disconnect。
- 私人上传只对所属用户可见；本机暂存不触发网页文件控件，只有带有效工作区窗口标记和近期所属用户输入的 XDG Portal 请求才能打开当次工作台确认。网关只返回该用户已确认的私人路径，文件列表由 Chromium 原生建立。下载只允许所属工作区或管理员取回。每个用户的私人上传总量限制为 1 GiB 并一直保留到手动删除；单文件和全服务器传输存储不另设应用级上限。
- 有副作用的 HTTP 请求与 WebSocket 升级会拒绝跨站 Origin。
- 状态、会话或文件传输索引 JSON 损坏时失败关闭，不会静默重置权限数据。
- 普通用户不得绕过配置的 HTTPS origin 直接访问明文网关；公网 DNS 只发布部署主机私网 IP，不开放公网入站端口。
- 对外开放前先在可信网络完成管理员初始化；尚无管理员时，首位访问者可以认领初始化。

## 容量与资源

程序没有“两工作区”限制，也没有人为写死的最大值。每个工作区使用独立顶层窗口和独立 `Page.startScreencast` 流；网关为每个工作区只保留一份最后画面，服务端背压与客户端只解码最新帧让慢链路不会无界占用内存。所有可见工作区统一使用最高 `2560×1600` 的源流上限和 `JPEG_QUALITY` 配置的 JPEG 质量；实际源帧不超过访问页面的当前 viewport，不会再因其它工作区可见而降低清晰度。

当前默认配置为 `FRAME_ACTIVE_FPS=60`、`JPEG_QUALITY=72`。`FRAME_ACTIVE_FPS=60` 只是上限；多个高分辨率动态窗口仍共享一只 headful Chromium 的渲染、JPEG 编码、CPU、内存和带宽。固定画质不保证配置帧率一定能实际交付，十二个真实已登录 ChatGPT 对话的长时容量仍需在部署主机重新验收。

## 验证与开发

```bash
npm ci
npm test
npm audit --omit=dev
docker compose --env-file .env.example config --quiet
docker compose up -d --build --wait
curl -fsS http://127.0.0.1:36090/healthz
```

自动化测试覆盖十二用户动态配置、Projects 预览与原子批量导入、权限隔离、路径会话、单活跃窗口接管、已认证管理状态实时更新、工作区在线优先排序、本机文本、输入法、选区隔离与原生复制并发归属、原生网页通知的工作区定向转发、系统通知严格白名单、连接状态与五秒页面反馈分离、普通 HTTP 页面回退展示、按完整名称匹配的编辑器功能白名单、敏感操作守卫、已授权会话菜单操作继续保留分享与跨项目拒绝、返回项目首页、十二个独立窗口连续流与慢客户端背压、CDP Target/session 路由、XDG Portal 请求归属与上传/下载授权、管理员浏览器直接下载、网关重启后的 Target 认领、全局时区/语言应用、出口探测失败处理、CSRF/Origin 拒绝与 Compose 结构。运行时验收还需要真实 Docker/Chromium 主机。完整 ChatGPT Pro 端到端验收必须由操作者执行那一次获授权的 ChatGPT 登录；仓库不会内置或自动填写凭据。

部署、数据、健康检查与恢复细节见 [Deploy.md](Deploy.md)。

## License

MIT，见 [LICENSE](LICENSE)。基于 [KasmVNC](https://kasmweb.com/kasmvnc) 与 [LinuxServer.io](https://www.linuxserver.io/) 基础镜像构建。ChatGPT 是 OpenAI 的商标。

## 友情链接

[![认可linux.do](https://ld.xh.do/ld-badge.svg)](https://linux.do)
