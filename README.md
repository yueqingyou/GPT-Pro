<div align="center">

<img src="assets/hero.svg" alt="GPT Pro — one signed-in Chromium profile with independent workspace targets" width="100%">

# GPT Pro — one Pro login, independent workspace windows

[![Docker](https://img.shields.io/badge/docker-compose-2496ED?style=flat-square&logo=docker&logoColor=white)](docker-compose.yml)
[![Node.js](https://img.shields.io/badge/node.js-22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](gateway/)
[![Chromium](https://img.shields.io/badge/chromium-CDP-4587F3?style=flat-square&logo=googlechrome&logoColor=white)](docker/)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-178F5F?style=flat-square)](Deploy.md)
[![License](https://img.shields.io/badge/license-MIT-1a1a18?style=flat-square)](LICENSE)

**English** | [简体中文](README.zh-CN.md)

</div>

GPT Pro runs one persistent Chromium profile on a machine you control. You sign in to ChatGPT once, then create any number of logical workspaces. Each workspace is a Page Target in its own top-level Chromium window with a fixed gateway URL, screen stream and input channel, while all windows share the same ChatGPT cookies and Pro entitlement.

This fork is designed for one operator moving between devices or locations—such as an office, lab and home—who wants each project to reopen in a stable, undisturbed window.

> **Account policy:** gateway usernames are local routing credentials, not separate ChatGPT identities. Sharing one ChatGPT account between different people may violate OpenAI's terms or policies. The software does not make account sharing compliant and is not affiliated with OpenAI.

## Architecture

```text
client /w/project-a/ ── path-scoped login ─┐
client /w/project-b/ ── path-scoped login ─┼─▶ gateway ─▶ CDP sessionId ─▶ window A / B / …
client /w/project-n/ ── path-scoped login ─┘                         │
                                                                    ▼
                                                 one Chromium process + one profile
                                                 one ChatGPT login + one network stack

administrator ─▶ /admin/maintenance/ ─▶ full KasmVNC Chromium browser
```

- Workspaces and users are created dynamically from persistent data. Add as many as the host can sustain.
- A workspace Target is tagged inside its top-level window. A gateway restart reclaims existing windows; a Chromium restart recreates them from each saved last URL.
- A client window at `/w/<workspace-id>/` receives a path-scoped HttpOnly cookie. Different workspace paths can therefore remain logged in as different gateway users in the same local browser profile.
- Mouse, keyboard and text insertion are sent with that workspace's CDP `sessionId`; clients never receive a raw Target ID or DevTools credential.
- Each visible workspace starts an independent CDP screencast and Chromium pushes JPEG frames without a per-frame screenshot request or cross-workspace serial queue. A lightweight signal in a named CDP isolated world watches only DOM node/text, scroll, input and resize activity so compositor-only frames are suppressed while the page is otherwise static. Source frames are acknowledged immediately; the gateway uses elapsed-time budgets for the foreground and visible-background delivery ceilings. With no visible viewer, the stream stops and the remote window is minimized. Slow clients drop stale frames and static views reuse the last frame for heartbeats, so buffers stay bounded.
- Ordinary workspace Targets receive an administrator-configurable sensitive-operation guard. Matching controls are hidden, then clicks and keyboard activation are checked again by the gateway before it sends a CDP `Input` event. Explicit URL blacklist entries are blocked by Chromium. The page has no capture-phase event blocker, and ordinary document requests are not paused, continued or rewritten through CDP `Fetch`. DOM changes rescan only added regions. Account, subscription, security, global settings and ChatGPT sign-out belong in the administrator browser.
- An ordinary entry shows only the project canvas, a persistent project-home button and a collapsed control panel. The managed page hides the web sidebar, top-left project name/icon link, project menus, sharing, Chat/Work switch, dictation and voice controls. Project sharing, conversation sharing and per-message sharing are also rejected before input is sent. Its administrator-managed `@` / `+` tool allowlist matches exact function names, never positions or counts; the default names are `Add photos & files`, `Create image`, `Web search` and `Deep research`. **Add sources** in Sources is fixed to `Upload` and `Text input`. Popups opened by an ordinary page are closed immediately, and top-level navigation cannot leave `chatgpt.com`. If the configured start address is a recognized ChatGPT project URL, its project home can open or create a conversation even when ChatGPT gives that conversation route a different `g-p` identifier. Once inside a conversation, navigation stays on that conversation or returns to the configured project home from the persistent local button. This modifies DOM/CSS and is UI/access hardening, not an undetectability or risk-evasion guarantee.
- The administrator entry uses the KasmVNC core page directly without its audio/file wrapper. While its Kasm connection is open, the unmanaged administrator Chromium window is kept in front. Use it for ChatGPT login/sign-out, MFA, global Profile management and Chrome extension installation; it is not the normal multi-workspace transport.
- A local upload is saved only to the current user's private directory and is never attached to ChatGPT automatically. After clicking upload in ChatGPT, the user manually selects and confirms a private file. Chromium downloads also stay in the dedicated transfer directory, and the gateway never mounts the Chromium Profile.
- Timezone, the JavaScript default locale, `navigator.languages` and HTTP `Accept-Language` are global properties of the one profile and stay identical across every Target and the administrator browser.
- An ordinary workspace submits the final text produced by the access device's own browser and operating-system input method—English, Chinese, Japanese, Korean, emoji, paste or other Unicode—to its Target. Candidates and unfinished composition remain local. A remote plain-text selection is mirrored only into that viewer's hidden local input, so native `Cmd/Ctrl+C` and `Cmd/Ctrl+X` copy or cut into the access device's clipboard. ChatGPT's message-copy buttons stay visible and transfer the resulting remote system-clipboard text to the viewer that clicked. The administrator desktop enables KasmVNC's native IME Input Mode instead of layering a project-specific input method on top.

## Install locally

Requirements: Docker with Compose v2. Docker Desktop works on macOS and Windows; a Linux Docker host also works.

```bash
git clone https://github.com/yueqingyou/GPT-Pro-Cloud.git
cd GPT-Pro-Cloud
cp .env.example .env
./scripts/up.sh
```

Open `http://127.0.0.1:36090/admin/`.

1. Create the administrator, unless `AUTH_PASSWORD` pre-created it.
2. Review **Browser environment**. On first start it detects timezone and language through Chromium's actual egress; the administrator can replace an unsuitable result.
3. If ChatGPT already has Projects, select **读取 Projects** (Read Projects) to preview and import them. Each imported workspace, user and initial password uses the project name; conflicts are never overwritten. Workspaces can still be added manually.
4. Add any remaining local users and assign their workspaces. User and workspace counts are not fixed.
5. Review **`@` / `+` tool allowlist**. It stores one exact displayed function name per line; an empty list denies every composer-menu tool.
6. Review **Sensitive-operation blacklist**. Its defaults reserve the account menu, settings, sign-out, subscription, security and destructive global operations for the administrator.
7. After signing in to `/admin/`, select **Open administrator browser** in the system panel and sign in to the single ChatGPT account once. Complete MFA and manage Chrome extensions there.
8. Open or refresh each workspace. Save each `/w/<id>/` URL as a location-specific bookmark.

`./data/browser/` stores the one Chromium profile and ChatGPT login. `./data-panel/state.json`, `sessions.json` and `transfers.json` store gateway state. `./data-transfer/` stores per-user private uploads and Chromium downloads. All three data roots are ignored by Git.

## Your multi-window scenario

Suppose the administrator creates:

| Gateway URL | Local credential | Chromium target |
| --- | --- | --- |
| `/w/office-project/` | `office-login` + its password | one persistent page |
| `/w/lab-project/` | `lab-login` + its password | another persistent page |
| `/w/home-review/` | any assigned user | another persistent page |

All three URLs can be open simultaneously in one local Chromium profile. Signing in to `/w/lab-project/` does not replace the cookie for `/w/office-project/`, and input is sent to the selected Target only. They still share one remote ChatGPT login because all Targets live in the same remote profile.

## Configuration

The commented [`.env.example`](.env.example) is authoritative.

| Variable | Purpose |
| --- | --- |
| `AUTH_USER` / `AUTH_PASSWORD` | Optionally pre-create the administrator. Leave the password empty for the first-visit setup page |
| `BIND_ADDR` / `HTTP_PORT` | Published gateway address and port |
| `MAINTENANCE_BIND_ADDR` / `MAINTENANCE_PORT` | Administrator-only full Chromium browser listener; defaults to loopback `:36091` |
| `MAINTENANCE_PUBLIC_URL` | Optional complete URL for the administrator browser's separate HTTPS port; it must use the same hostname as the normal entry so the host-only administrator cookie remains available |
| `PUID` / `PGID` / `TZ` | Desktop file ownership and bootstrap timezone; `TZ` is also the deployment value used after a detection failure |
| `START_URL` | Initial page shown in the administrator browser |
| `PROXY_URL` | One global Chromium proxy; loopback hostnames are rewritten for Docker |
| `PROFILE_AUTO_DETECT` | Detect the environment through Chromium on the first unconfigured start; default `true` |
| `PROFILE_GEO_ENDPOINT` / `PROFILE_GEO_TIMEOUT_MS` | CORS-enabled HTTPS endpoint returning timezone plus languages or a country code, and its timeout; defaults to `https://ipwho.is/?fields=success,country_code,timezone.id` / `5000` |
| `PROFILE_TIMEZONE` / `PROFILE_LOCALE` | Optional deployment values used when automatic detection fails or is disabled |
| `VNC_PASSWORD` | Internal administrator-browser credential; VNC is not published to the host |
| `MAX_FILE_BYTES` / `TRANSFER_QUOTA_BYTES` | Per-file and total transfer-directory limits in bytes; defaults to 512 MiB / 4 GiB |
| `FRAME_FPS` | Sampling and delivery ceiling for a visible but unfocused workspace; default `8` |
| `FRAME_ACTIVE_FPS` | Sampling and delivery ceiling for a focused or recently interactive workspace; default `60` |
| `FRAME_IDLE_MS` | Interval for reusing the last static frame as a heartbeat; default `2000` ms |
| `JPEG_QUALITY` | Screen-stream JPEG quality, `35–90`; default `72` |

Because all Targets share one Chromium process and network stack, per-workspace proxies are intentionally unsupported.

## Browser-environment consistency

On the first start without persisted settings, the gateway reuses its existing CDP connection and makes a `credentials: omit`, `cache: no-store` request from a temporary `about:blank` Target, then closes that Target. It never navigates a user page to the provider, sends profile cookies, or leaves provider page history. Detection therefore observes Chromium's actual egress, including `PROXY_URL`, rather than accidentally observing the gateway container's direct route. The default URL requests only a country code and IANA timezone through its `fields` parameter; it does not ask the provider to return the public IP, city or coordinates. Language is derived from the country code and the runtime's CLDR likely-subtags. If a custom provider returns extra fields anyway, the gateway neither persists nor logs them. The provider still sees that one request; set `PROFILE_AUTO_DETECT=false` to avoid using an external service.

Automatic detection runs only for an unconfigured profile. Container restarts do not silently change the browser environment. After changing the global proxy or deployment location, an administrator can explicitly re-detect, or manually enter values such as `Asia/Shanghai` and `zh-CN`. Saving applies one identical timezone, JavaScript locale, `navigator.languages` list and HTTP `Accept-Language` header to all workspace pages and the administrator browser, then reloads them. **Verify current pages** reads those values and the Client Hints preservation state from the live pages; any page not claimed by the gateway counts as inconsistent rather than being silently omitted.

An IP region's language list is only a regional default and may not match the operator's preference, so the administrator page always shows the result for review. These controls reduce obvious IP/timezone/language inconsistency; they are not a promise to evade risk controls or prevent account challenges. Stable egress, device environment, usage patterns and account-policy compliance remain the operator's responsibility.

## Current interaction support

Normal workspace windows support:

- independent JPEG screen streams;
- mouse clicks, pointer movement while dragging and scrolling;
- keyboard navigation, shortcuts and text entry;
- Unicode text and native paste produced by the access device's own input method;
- native copy and cut of the current remote plain-text selection into the access device's clipboard;
- ChatGPT message-copy buttons that copy the remote system clipboard into the triggering access window;
- local staging into the user's private directory, followed by explicit selection after ChatGPT opens a file chooser;
- a workspace-scoped file panel for downloading completed remote Chromium files back to the local device;
- return to the project home, refresh and browser fullscreen;
- a control panel that is collapsed by default; the ordinary viewer has no permanent top bar or bottom hint, and its browser title is the workspace name.

Current limitations:

- rich-text, image and file clipboard formats are not mirrored; selections and ChatGPT message-copy buttons transfer plain text only;
- audio, microphone and ChatGPT voice mode are not streamed;
- multiple simultaneous viewers of the same workspace share one viewport;
- continuous Chromium streams still consume shared rendering, JPEG encoding, CPU, RAM and bandwidth; focused or recently interactive viewers use `FRAME_ACTIVE_FPS`, visible background viewers use `FRAME_FPS`, and streams stop when there is no visible viewer;
- configured FPS is a sampling and delivery ceiling rather than a delivered-rate guarantee; shared Chromium rendering and encoding remain the limit when many pages change together;
- administrator-installed extensions run in the shared Profile and can affect every workspace. Their permissions, fingerprint behavior and updates are outside this project's security guarantee.

An ordinary workspace viewport follows the access page's usable area, so a portrait phone is not forced to a desktop minimum width; the gateway normalizes the Chromium window, measures its current browser-chrome inset and resizes the real window together with the emulated page. The frame and pointer coordinates therefore fill the same canvas. The gateway focuses the current page's hidden text control only after an editable remote target or nonempty remote text selection is selected, so tapping ordinary controls such as Chat or Sources does not summon the input method. Printable characters, dead keys and IME composition are handled by the access device's operating system and browser. Intermediate `insertCompositionText` updates remain local; only the final committed text is inserted through the current workspace's CDP `sessionId` and `Input.insertText`. A native local paste is written to the remote Chromium clipboard and applied as one native Paste editing transaction, so large multiline text is not forced through `Input.insertText`. Enter, Backspace, arrow keys and remote shortcuts continue through the keyboard-event channel, preserving ChatGPT's send, newline, deletion and navigation behavior.

The project defines no input-source shortcut and stores no language mode, Pinyin buffer or candidate list. Each local browser page owns its composition state, so choosing a candidate in one window cannot affect another. After a mouse or keyboard selection completes, its remote plain text is mirrored only into that viewer's hidden local text control. `Cmd/Ctrl+C`, `Cmd/Ctrl+X` and `Cmd/Ctrl+V` use the access browser's native clipboard events; the project never reads the access device's clipboard programmatically. Native pastes and ChatGPT copy actions share one cross-workspace queue because the remote Chromium system clipboard is shared. Clipboard access runs in a CDP isolated world, and each copied result is returned only to the viewer that initiated it. On macOS, local `Command` shortcuts are sent with remote `Control` semantics; on other platforms, local `Control` remains remote `Control`. The administrator browser uses KasmVNC's official IME Input Mode to pass the same access device's system input method into the remote desktop. Runtime event-sequence acceptance currently targets Chromium-based browsers.

Use the administrator browser when a flow requires browser chrome, a native desktop dialog or shared Profile management. Do not expose it as a general user endpoint.

## Security boundary

- Only the gateway process publishes host ports. The normal entry is `:36090`; a second gateway listener exposes KasmVNC at its required root path and defaults to loopback `:36091`. The desktop container itself, Chromium DevTools and raw KasmVNC ports remain private.
- The gateway no longer mounts `/var/run/docker.sock`.
- Passwords use per-user salted scrypt hashes. Session and state files are created with private permissions.
- Login attempts are rate-limited. Changing a password, disabling a user or changing workspace assignments revokes that user's sessions and sockets.
- Project import captures only the authorized sidebar response emitted by a ChatGPT page in the shared Profile; it never reads or replays a login token. It refuses import when pagination is required or the response shape changes.
- The exact-name composer-tool allowlist and sensitive-operation policy are persistent and apply only to managed workspace Targets. Sharing is an invariant ordinary-workspace restriction; the administrator browser remains unrestricted. Because website labels, DOM structure and endpoints can change, the administrator should review these controls after major ChatGPT UI changes.
- Hiding and blocking an unlisted ChatGPT app is not account-level revocation of a third-party OAuth grant. To remove an existing GitHub, Notion, Gmail or other connection, the administrator must still use **Settings > Apps > Disconnect** in ChatGPT.
- Private uploads are visible only to their owner. Staging a local file never touches a page file input; the gateway handles only the chooser that the user manually opens in ChatGPT and explicitly confirms. Downloads are visible only to the owning workspace or the administrator. File names, per-file size and total capacity are constrained.
- Mutating HTTP requests and WebSocket upgrades reject cross-origin browser requests.
- Corrupt state, session or transfer-index JSON causes startup to fail closed instead of silently resetting access control.
- Direct HTTP is suitable only for a trusted LAN or VPN. Use HTTPS through a reverse proxy or tunnel for any public route, and bind `BIND_ADDR=127.0.0.1` behind that tunnel.
- Finish administrator setup on a trusted network before exposing the gateway. While no administrator exists, the first visitor can claim setup.

## Resource behavior

There is no application-level two-workspace limit and no arbitrary fixed maximum. Every workspace has its own top-level window and `Page.startScreencast` stream. The gateway retains one last image per workspace; WebSocket backpressure and client-side newest-frame coalescing keep slow links bounded. Stream profiles adapt to the number of visible workspaces: one uses up to `2560×1600`, two to four use `1280×800`, five to eight use `960×600`, and nine or more use `800×500`; JPEG quality caps are 90, 70, 66 and 60 respectively, further limited by `JPEG_QUALITY`.

The maintained regression baseline is twelve local users, each assigned one workspace, with `FRAME_FPS=8`, `FRAME_ACTIVE_FPS=60`, `FRAME_IDLE_MS=2000` and `JPEG_QUALITY=72`. On the reference Docker host, one dynamic ordinary window delivered 38.30 FPS at 0.87 MiB/s. Six active plus six visible-background windows delivered 10.33–11.07 FPS and 7.47–7.73 FPS respectively at 0.83 MiB/s total. Twelve active windows delivered 9.20–11.60 FPS each at 0.95 MiB/s total, with zero gateway backpressure drops; the desktop used about 172–192% CPU and 1.17–1.26 GiB, while the gateway settled near 11–14% CPU and 63–71 MiB after its connection-startup spike. A static window sent four heartbeat frames in seven seconds while eleven compositor frames were suppressed. `FRAME_ACTIVE_FPS=60` remains a ceiling: one headful Chromium process cannot make twelve OS-background windows render like twelve separate foreground browser processes. These synthetic results do not promise the capacity of twelve real signed-in ChatGPT conversations.

## Verification and development

```bash
npm ci
npm test
npm audit --omit=dev
docker compose --env-file .env.example config --quiet
docker compose up -d --build --wait
curl -fsS http://127.0.0.1:36090/healthz
```

The automated suite covers twelve-user dynamic configuration, Project preview and atomic batch import, permission isolation, path-scoped sessions, native text/IME, per-viewer selections and concurrent native copy ownership, the exact-name composer-tool allowlist, sensitive-operation guards, pre-input sharing and project-link rejection, project-home return, twelve independent window screencasts and slow-viewer backpressure, CDP Target/session routing, upload/download authorization, Target reclamation after a gateway restart, global timezone/language application, egress-detection failure handling, CSRF/Origin rejection and Compose structure. Runtime acceptance additionally requires a real Docker/Chromium host. A real ChatGPT Pro end-to-end acceptance still requires the operator to perform the one authorized ChatGPT login; no credentials are bundled or automated.

See [Deploy.md](Deploy.md) for deployment, data, health and recovery details.

## License

MIT. See [LICENSE](LICENSE). Built on [KasmVNC](https://kasmweb.com/kasmvnc) and the [LinuxServer.io](https://www.linuxserver.io/) base image. ChatGPT is a trademark of OpenAI.

## Links

[![认可linux.do](https://ld.xh.do/ld-badge.svg)](https://linux.do)
