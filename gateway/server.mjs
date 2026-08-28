import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import httpProxy from "http-proxy";
import { WebSocketServer } from "ws";
import { createLoginLimiter, createSessionStore, createSessionToken, readSession } from "../lib/auth.mjs";
import { WorkspaceBroker } from "../lib/cdp.mjs";
import { createSocketHub, kickLiveSession } from "../lib/kick.mjs";
import { FilePortalBridge } from "../lib/portal.mjs";
import { manualBrowserProfile, resolveAutomaticBrowserProfile } from "../lib/profile.mjs";
import { createStateStore, WORKSPACE_ID_RE } from "../lib/store.mjs";
import { createTransferStore } from "../lib/transfers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB = join(HERE, "web");
const ADMIN_COOKIE = "gpc_admin_session";
const WORKSPACE_COOKIE = "gpc_workspace_session";
const VIEWER_REPLACED_CLOSE_CODE = 4000;
const VIEWER_REPLACED_CLOSE_REASON = "replaced";
const VIEWER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAINTENANCE_HANDOFF_TTL_MS = 30 * 1000;
const BODY_LIMIT = 64 * 1024;
const MAINTENANCE_HANDOFF_PAGE =
  '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/vnc/"><title>GPT Pro</title>';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name || Object.hasOwn(cookies, name)) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      cookies[name] = "";
    }
  }
  return cookies;
}

function isHttps(req) {
  return String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function setCookie(req, res, { name, value, path, maxAge }) {
  const previous = res.getHeader("set-cookie");
  const list = previous ? (Array.isArray(previous) ? previous : [previous]) : [];
  const secure = isHttps(req) ? "; Secure" : "";
  list.push(
    `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAge))}${secure}`,
  );
  res.setHeader("set-cookie", list);
}

function clientIp(req) {
  return String(req.socket?.remoteAddress || "unknown");
}

function limiterUsername(raw) {
  return String(raw || "").trim().toLocaleLowerCase("en-US").slice(0, 64);
}

function originAllowed(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true;
  try {
    return new URL(origin).host === String(req.headers.host || "");
  } catch {
    return false;
  }
}

function enabled(raw, defaultValue = true) {
  const value = String(raw ?? "").trim().toLocaleLowerCase("en-US");
  if (!value) return defaultValue;
  return !["0", "false", "no", "off"].includes(value);
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(body));
}

function uploadName(req) {
  const raw = String(req.headers["x-gpc-file-name"] || "");
  try {
    return decodeURIComponent(raw) || "file";
  } catch {
    throw Object.assign(new Error("上传文件名编码无效"), { status: 400 });
  }
}

function sendTransferFile(req, res, file) {
  const asciiName = file.entry.name.replace(/[^\x20-\x7e]|["\\]/g, "_").slice(0, 120) || "download";
  const encoded = encodeURIComponent(file.entry.name).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  res.writeHead(200, {
    "content-type": file.entry.mimeType || "application/octet-stream",
    "content-length": file.size,
    "content-disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = file.stream();
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      const error = new Error("请求体太大");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error("请求体必须是 JSON");
    error.status = 400;
    throw error;
  }
}

function publicWorkspace(workspace) {
  return workspace
    ? {
        id: workspace.id,
        name: workspace.name,
        startUrl: workspace.startUrl,
        lastUrl: workspace.lastUrl,
      }
    : null;
}

function workspaceRoute(pathname) {
  const match = pathname.match(/^\/w\/([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)(\/.*|\/$)/);
  return match ? { id: match[1], suffix: match[2] } : null;
}

const WEB_FILES = new Map([
  ["/", "index.html"],
  ["/app.js", "app.js"],
  ["/app.css", "app.css"],
  ["/text-input.js", "text-input.js"],
  ["/admin-browser.js", "admin-browser.js"],
]);

function serveFile(webDir, res, pathname) {
  const filename = WEB_FILES.get(pathname);
  if (!filename) return false;
  const full = join(webDir, filename);
  if (!full.startsWith(webDir) || !existsSync(full)) return false;
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  const headers = {
    "content-type": types[extname(full)] || "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  if (filename === "index.html") headers["content-security-policy"] = CSP;
  res.writeHead(200, headers);
  res.end(readFileSync(full));
  return true;
}

export function createGateway({
  store,
  broker,
  sessions,
  transfers = null,
  portal = null,
  webDir = DEFAULT_WEB,
  maintenanceTarget = "http://desktop:3000",
  maintenanceHostPort = 36091,
  vncUser = "abc",
  vncPassword = "",
  resolveBrowserProfile,
  logger = console,
} = {}) {
  if (!store || !broker || !sessions) throw new Error("createGateway 缺少 store、broker 或 sessions");

  const limiter = createLoginLimiter({ maxFails: 10, windowMs: 15 * 60 * 1000 });
  const liveSockets = createSocketHub();
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const maintenanceProxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true, xfwd: true });
  const maintenanceSockets = new Set();
  const maintenanceHandoffs = new Map();
  const adminStreams = new Map();
  function adminRuntimeState() {
    const status = broker.status();
    return {
      browser: {
        connected: status.connected,
        workspaces: status.workspaces,
        targets: status.targets,
        viewers: status.viewers,
      },
      workspaceViewers: broker.viewerCountsByWorkspace(),
    };
  }

  function sendAdminState(res) {
    res.write(`event: state\ndata: ${JSON.stringify(adminRuntimeState())}\n\n`);
  }

  function broadcastAdminState() {
    for (const [res, stream] of adminStreams) {
      if (stream.kind === "state") sendAdminState(res);
    }
  }

  function broadcastAdminDownload(file) {
    for (const [res, stream] of adminStreams) {
      if (stream.kind === "downloads") res.write(`event: download\ndata: ${JSON.stringify(file)}\n\n`);
    }
  }

  function closeAdminStreams(predicate = () => true) {
    for (const [res, session] of adminStreams) {
      if (!predicate(session)) continue;
      adminStreams.delete(res);
      res.end();
    }
  }

  const unsubscribeBrokerState = broker.subscribeState(broadcastAdminState);
  const unsubscribeAdminDownloads = broker.subscribeAdminDownloads(broadcastAdminDownload);

  maintenanceProxy.on("proxyReq", (proxyRequest) => {
    if (vncPassword) {
      proxyRequest.setHeader("authorization", `Basic ${Buffer.from(`${vncUser}:${vncPassword}`).toString("base64")}`);
    }
  });
  maintenanceProxy.on("proxyRes", (proxyResponse) => {
    proxyResponse.headers["cache-control"] = "no-store";
    delete proxyResponse.headers["x-frame-options"];
    delete proxyResponse.headers["cross-origin-embedder-policy"];
    delete proxyResponse.headers["cross-origin-opener-policy"];
    delete proxyResponse.headers["cross-origin-resource-policy"];
  });
  maintenanceProxy.on("error", (error, _req, res) => {
    logger.error?.(`管理员浏览器代理失败：${error.message}`);
    if (res && !res.headersSent && typeof res.writeHead === "function") {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("管理员浏览器暂时不可用");
    }
  });

  function maintenanceLocation(handoff) {
    return `http://127.0.0.1:${maintenanceHostPort}/?handoff=${handoff}`;
  }

  function sessionRecord(req, cookieName) {
    const token = parseCookies(req.headers.cookie)[cookieName];
    const record = readSession(sessions, token, Date.now(), SESSION_TTL_MS);
    if (!record) return null;
    const user = store.user(record.userId);
    if (!user || user.disabled) return null;
    return { token, record, user };
  }

  function adminSession(req) {
    const session = sessionRecord(req, ADMIN_COOKIE);
    return session?.record.kind === "admin" && session.user.role === "admin" ? session : null;
  }

  function workspaceSession(req, workspaceId) {
    const session = sessionRecord(req, WORKSPACE_COOKIE);
    if (!session || session.record.kind !== "workspace" || session.record.workspaceId !== workspaceId) return null;
    return store.canOpen(session.user, workspaceId) ? session : null;
  }

  function createLogin(req, res, user, { kind, workspaceId = "" }) {
    const token = createSessionToken();
    sessions.set(token, {
      kind,
      userId: user.id,
      ...(workspaceId ? { workspaceId } : {}),
      expires: Date.now() + SESSION_TTL_MS,
    });
    setCookie(req, res, {
      name: kind === "admin" ? ADMIN_COOKIE : WORKSPACE_COOKIE,
      value: token,
      path: kind === "admin" ? "/" : `/w/${workspaceId}`,
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  async function applyManagedRule(label, apply) {
    try {
      const runtime = await apply();
      return { runtime, runtimePending: runtime.failedTargets > 0 };
    } catch (error) {
      logger.warn?.(`${label}已保存，等待 Chromium 应用：${error.message}`);
      return { runtime: { appliedTargets: 0, failedTargets: 0 }, runtimePending: true };
    }
  }

  async function handleAdmin(req, res, url) {
    if (url.pathname === "/admin/api/bootstrap" && req.method === "GET") {
      const session = adminSession(req);
      return json(res, 200, { setupNeeded: !store.hasAdmin(), authenticated: !!session, user: session?.user || null });
    }

    if (url.pathname === "/admin/setup" && req.method === "POST") {
      if (store.hasAdmin()) return json(res, 403, { error: "管理员已存在" });
      const body = await readBody(req);
      try {
        const user = store.createAdmin({ username: body.username, password: body.password });
        createLogin(req, res, user, { kind: "admin" });
        return json(res, 200, { user });
      } catch (error) {
        return json(res, error.status || 400, { error: error.message });
      }
    }

    if (url.pathname === "/admin/login" && req.method === "POST") {
      const body = await readBody(req);
      const key = `admin|${clientIp(req)}|${limiterUsername(body.username)}`;
      if (limiter.blocked(key)) return json(res, 429, { error: "尝试次数过多，请稍后再试" });
      const user = store.login(body.username, body.password);
      if (!user || user.role !== "admin") {
        limiter.fail(key);
        return json(res, 401, { error: "用户名或密码错误" });
      }
      limiter.ok(key);
      createLogin(req, res, user, { kind: "admin" });
      return json(res, 200, { user });
    }

    if (url.pathname === "/admin/logout" && req.method === "POST") {
      const session = adminSession(req);
      if (session) {
        sessions.delete(session.token);
        closeAdminStreams((stream) => stream.token === session.token);
      }
      setCookie(req, res, { name: ADMIN_COOKIE, value: "", path: "/", maxAge: 0 });
      return json(res, 200, { ok: true });
    }

    const session = adminSession(req);
    if (!session) return json(res, 401, { error: "未登录" });

    if (url.pathname === "/admin/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      adminStreams.set(res, { token: session.token, userId: session.user.id, kind: "state" });
      res.once("close", () => adminStreams.delete(res));
      sendAdminState(res);
      return;
    }

    if (url.pathname === "/admin/api/state" && req.method === "GET") {
      return json(res, 200, {
        user: session.user,
        users: store.users(),
        workspaces: store.workspaces().map(publicWorkspace),
        browserProfile: store.browserProfile(),
        composerToolAllowlist: store.composerToolAllowlist(),
        sensitivePolicy: store.sensitivePolicy(),
        transfers: transfers
          ? transfers.listAdmin().map((entry) => ({
              ...entry,
              ...(entry.kind === "upload" ? { remotePath: transfers.remotePath(entry.id) } : {}),
            }))
          : [],
        transferStorage: transfers
          ? { userQuotaBytes: transfers.userQuotaBytes }
          : null,
        browser: broker.status(),
        workspaceViewers: broker.viewerCountsByWorkspace(),
      });
    }

    if (url.pathname === "/admin/api/chatgpt-projects" && req.method === "GET") {
      try {
        const projects = await broker.listChatGptProjects();
        return json(res, 200, { projects: store.previewChatGptProjects(projects) });
      } catch (error) {
        return json(res, error.status || 503, { error: error.message });
      }
    }

    if (url.pathname === "/admin/api/chatgpt-projects/import" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const projects = await broker.listChatGptProjects();
        const imported = store.importChatGptProjects(projects, body.projectIds);
        const runtimes = await Promise.allSettled(
          imported.workspaces.map((workspace) => broker.ensureWorkspace(workspace.id)),
        );
        const readyTargets = runtimes.filter((result) => result.status === "fulfilled").length;
        const failedTargets = runtimes.length - readyTargets;
        if (failedTargets) logger.warn?.(`${failedTargets} 个导入工作区等待 Chromium 恢复`);
        return json(res, 201, {
          imported,
          runtime: { readyTargets, failedTargets },
          runtimePending: failedTargets > 0,
        });
      } catch (error) {
        return json(res, error.status || 503, { error: error.message });
      }
    }

    if (url.pathname === "/admin/api/composer-tools" && req.method === "PATCH") {
      try {
        const body = await readBody(req);
        const names = store.setComposerToolAllowlist(body.names);
        const { runtime, runtimePending } = await applyManagedRule("编辑器功能白名单", () =>
          broker.applyProjectFocus(),
        );
        return json(res, 200, { names, runtime, runtimePending });
      } catch (error) {
        return json(res, error.status || 400, { error: error.message });
      }
    }

    if (url.pathname === "/admin/api/sensitive-policy" && req.method === "PATCH") {
      try {
        const policy = store.setSensitivePolicy(await readBody(req));
        const { runtime, runtimePending } = await applyManagedRule("敏感操作黑名单", () =>
          broker.applySensitivePolicy(),
        );
        return json(res, 200, { policy, runtime, runtimePending });
      } catch (error) {
        return json(res, error.status || 400, { error: error.message });
      }
    }

    if (url.pathname === "/admin/api/uploads" && req.method === "POST") {
      if (!transfers) return json(res, 503, { error: "当前部署没有启用文件传输" });
      try {
        const entry = await transfers.receiveUpload(req, {
          userId: session.user.id,
          name: uploadName(req),
          mimeType: req.headers["content-type"],
          declaredSize: Number(req.headers["content-length"] || 0),
        });
        return json(res, 201, { file: { ...entry, remotePath: transfers.remotePath(entry.id) } });
      } catch (error) {
        return json(res, error.status || 400, { error: error.message });
      }
    }

    const adminTransfer = url.pathname.match(/^\/admin\/api\/transfers\/([a-zA-Z0-9-]{8,80})$/);
    if (adminTransfer && req.method === "DELETE") {
      if (!transfers) return json(res, 503, { error: "当前部署没有启用文件传输" });
      try {
        return json(res, 200, { ok: true, file: transfers.remove(adminTransfer[1], { isAdmin: true }) });
      } catch (error) {
        return json(res, error.status || 400, { error: error.message });
      }
    }

    const adminFile = url.pathname.match(/^\/admin\/files\/([a-zA-Z0-9-]{8,80})$/);
    if (adminFile && (req.method === "GET" || req.method === "HEAD")) {
      if (!transfers) return json(res, 503, { error: "当前部署没有启用文件传输" });
      try {
        return sendTransferFile(req, res, transfers.openDownload(adminFile[1], { isAdmin: true }));
      } catch (error) {
        return json(res, error.status || 404, { error: error.message });
      }
    }

    if (url.pathname === "/admin/api/browser-profile" && req.method === "PATCH") {
      try {
        const body = await readBody(req);
        const profile = store.setBrowserProfile(
          manualBrowserProfile({ timezone: body.timezone, locale: body.locale }),
        );
        const { runtime, runtimePending } = await applyManagedRule("浏览器环境", () =>
          broker.applyBrowserProfile({ reload: true }),
        );
        return json(res, 200, { profile, runtime, runtimePending });
      } catch (error) {
        return json(res, error.status || 400, { error: error.message });
      }
    }

    if (url.pathname === "/admin/api/browser-profile/detect" && req.method === "POST") {
      if (!resolveBrowserProfile) return json(res, 503, { error: "当前部署未配置出口 IP 探测" });
      try {
        const result = await resolveBrowserProfile({ force: true });
        const { runtime, runtimePending } = await applyManagedRule("自动探测结果", () =>
          broker.applyBrowserProfile({ reload: true }),
        );
        return json(res, 200, {
          profile: result.profile,
          detected: result.detected,
          warning: result.warning,
          runtime,
          runtimePending,
        });
      } catch (error) {
        return json(res, error.status || 500, { error: error.status ? error.message : "出口 IP 探测失败" });
      }
    }

    if (url.pathname === "/admin/api/browser-profile/verify" && req.method === "GET") {
      try {
        return json(res, 200, await broker.verifyBrowserProfile());
      } catch (error) {
        return json(res, 503, { error: error.message });
      }
    }

    if (url.pathname === "/admin/api/workspaces" && req.method === "POST") {
      try {
        const workspace = store.createWorkspace(await readBody(req));
        broker.ensureWorkspace(workspace.id).catch((error) => logger.warn?.(`工作区 ${workspace.id} 等待浏览器：${error.message}`));
        return json(res, 201, { workspace: publicWorkspace(workspace) });
      } catch (error) {
        return json(res, error.status || 400, { error: error.message });
      }
    }

    const workspaceAction = url.pathname.match(/^\/admin\/api\/workspaces\/([a-z0-9-]+)$/);
    if (workspaceAction && req.method === "PATCH") {
      try {
        const body = await readBody(req);
        const workspace = store.updateWorkspace(workspaceAction[1], body);
        let runtimePending = false;
        if (Object.hasOwn(body, "startUrl")) {
          try {
            await broker.navigate(workspace.id, workspace.startUrl);
          } catch (error) {
            runtimePending = true;
            logger.warn?.(`工作区 ${workspace.id} 地址已保存，等待浏览器应用：${error.message}`);
          }
        }
        return json(res, 200, { workspace: publicWorkspace(workspace), runtimePending });
      } catch (error) {
        return json(res, error.status || 400, { error: error.message });
      }
    }
    if (workspaceAction && req.method === "DELETE") {
      try {
        const workspace = store.removeWorkspace(workspaceAction[1]);
        sessions.deleteByWorkspace(workspace.id);
        transfers?.removeWorkspace(workspace.id);
        await broker.removeWorkspace(workspace.id);
        return json(res, 200, { ok: true, workspace: publicWorkspace(workspace) });
      } catch (error) {
        return json(res, error.status || 400, { error: error.message });
      }
    }

    if (url.pathname === "/admin/api/users" && req.method === "POST") {
      try {
        const user = store.createUser(await readBody(req));
        return json(res, 201, { user });
      } catch (error) {
        return json(res, error.status || 400, { error: error.message });
      }
    }

    const userAction = url.pathname.match(/^\/admin\/api\/users\/([^/]+)$/);
    if (userAction && req.method === "PATCH") {
      try {
        const body = await readBody(req);
        const user = store.updateUser(userAction[1], body);
        const shouldRevoke =
          Object.hasOwn(body, "password") || Object.hasOwn(body, "disabled") || Object.hasOwn(body, "workspaceIds");
        if (shouldRevoke) {
          sessions.deleteByUser(user.id);
          liveSockets.drop(user.id);
          closeAdminStreams((stream) => stream.userId === user.id);
        }
        return json(res, 200, { user });
      } catch (error) {
        return json(res, error.status || 400, { error: error.message });
      }
    }
    if (userAction && req.method === "DELETE") {
      try {
        const user = store.removeUser(userAction[1]);
        sessions.deleteByUser(user.id);
        liveSockets.drop(user.id);
        transfers?.removeUserUploads(user.id);
        return json(res, 200, { ok: true, user });
      } catch (error) {
        return json(res, error.status || 400, { error: error.message });
      }
    }

    const kickAction = url.pathname.match(/^\/admin\/api\/users\/([^/]+)\/kick$/);
    if (kickAction && req.method === "POST") {
      const user = store.user(kickAction[1]);
      if (!user) return json(res, 404, { error: "用户不存在" });
      const dropped = kickLiveSession({ sessions, sockets: liveSockets }, user.id);
      return json(res, 200, { ok: true, ...dropped });
    }

    return json(res, 404, { error: "not found" });
  }

  async function handleWorkspace(req, res, route) {
    const workspace = store.workspace(route.id);
    if (!workspace) return json(res, 404, { error: "工作区不存在" });

    if (route.suffix === "/api/bootstrap" && req.method === "GET") {
      const session = workspaceSession(req, route.id);
      return json(res, 200, {
        authenticated: !!session,
        user: session?.user || null,
        workspace: session ? publicWorkspace(workspace) : { id: workspace.id, name: workspace.name },
        browser: session ? broker.status() : undefined,
        fileTransfer: session && transfers
          ? { enabled: true, ...transfers.userUsage(session.user.id) }
          : { enabled: false },
        sensitivePolicyEnabled: session ? store.sensitivePolicy().enabled : undefined,
      });
    }

    if (route.suffix === "/login" && req.method === "POST") {
      const body = await readBody(req);
      const key = `workspace|${clientIp(req)}|${limiterUsername(body.username)}`;
      if (limiter.blocked(key)) return json(res, 429, { error: "尝试次数过多，请稍后再试" });
      const user = store.login(body.username, body.password);
      if (!user || !store.canOpen(user, route.id)) {
        limiter.fail(key);
        return json(res, 401, { error: "用户名、密码或工作区权限错误" });
      }
      limiter.ok(key);
      createLogin(req, res, user, { kind: "workspace", workspaceId: route.id });
      return json(res, 200, { user, workspace: publicWorkspace(workspace) });
    }

    if (route.suffix === "/logout" && req.method === "POST") {
      const session = workspaceSession(req, route.id);
      if (session) sessions.delete(session.token);
      setCookie(req, res, {
        name: WORKSPACE_COOKIE,
        value: "",
        path: `/w/${route.id}`,
        maxAge: 0,
      });
      return json(res, 200, { ok: true });
    }

    const session = workspaceSession(req, route.id);
    if (!session) return json(res, 401, { error: "未登录" });

    if (route.suffix === "/api/uploads" && req.method === "POST") {
      if (!transfers) return json(res, 503, { error: "当前部署没有启用文件传输" });
      try {
        const entry = await transfers.receiveUpload(req, {
          userId: session.user.id,
          name: uploadName(req),
          mimeType: req.headers["content-type"],
          declaredSize: Number(req.headers["content-length"] || 0),
        });
        return json(res, 201, { file: entry });
      } catch (error) {
        return json(res, error.status || 400, { error: error.message });
      }
    }

    if (route.suffix === "/api/transfers" && req.method === "GET") {
      if (!transfers) return json(res, 200, { files: [] });
      return json(res, 200, {
        files: transfers.listUserFiles({ workspaceId: route.id, userId: session.user.id }),
        storage: transfers.userUsage(session.user.id),
      });
    }

    const transferAction = route.suffix.match(/^\/api\/transfers\/([a-zA-Z0-9-]{8,80})$/);
    if (transferAction && req.method === "DELETE") {
      if (!transfers) return json(res, 503, { error: "当前部署没有启用文件传输" });
      try {
        return json(res, 200, {
          ok: true,
          file: transfers.remove(transferAction[1], {
            workspaceId: route.id,
            userId: session.user.id,
          }),
        });
      } catch (error) {
        return json(res, error.status || 400, { error: error.message });
      }
    }

    const download = route.suffix.match(/^\/files\/([a-zA-Z0-9-]{8,80})$/);
    if (download && (req.method === "GET" || req.method === "HEAD")) {
      if (!transfers) return json(res, 503, { error: "当前部署没有启用文件传输" });
      try {
        return sendTransferFile(req, res, transfers.openDownload(download[1], { workspaceId: route.id }));
      } catch (error) {
        return json(res, error.status || 404, { error: error.message });
      }
    }

    return json(res, 404, { error: "not found" });
  }

  function redirectMaintenance(req, res) {
    const session = adminSession(req);
    if (!session) return json(res, 401, { error: "管理员未登录" });
    const now = Date.now();
    for (const [handoff, record] of maintenanceHandoffs) {
      if (record.expires <= now) maintenanceHandoffs.delete(handoff);
    }
    const handoff = createSessionToken();
    maintenanceHandoffs.set(handoff, { sessionToken: session.token, expires: now + MAINTENANCE_HANDOFF_TTL_MS });
    res.writeHead(302, {
      location: maintenanceLocation(handoff),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    res.end();
  }

  async function handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method || "GET") && !originAllowed(req)) {
      return json(res, 403, { error: "请求来源不受信任" });
    }
    if (url.pathname === "/healthz") {
      return json(res, 200, { ok: true, browser: broker.status() });
    }
    if (/^\/admin\/maintenance\/?$/.test(url.pathname)) return redirectMaintenance(req, res);
    if (
      url.pathname.startsWith("/admin/") &&
      (url.pathname.includes("/api/") || url.pathname.startsWith("/admin/files/") || /\/(login|logout|setup)$/.test(url.pathname))
    ) {
      return handleAdmin(req, res, url);
    }
    const route = workspaceRoute(url.pathname);
    if (
      route &&
      (route.suffix.includes("/api/") || route.suffix.startsWith("/files/") || ["/login", "/logout"].includes(route.suffix))
    ) {
      return handleWorkspace(req, res, route);
    }
    if (["/app.js", "/app.css", "/text-input.js"].includes(url.pathname)) {
      serveFile(webDir, res, url.pathname);
      return;
    }
    if (url.pathname === "/" || url.pathname === "/admin" || url.pathname === "/admin/" || route?.suffix === "/") {
      serveFile(webDir, res, "/");
      return;
    }
    res.writeHead(302, { location: "/", "cache-control": "no-store" });
    res.end();
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger.error?.(error);
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : "internal error" });
    });
  });

  async function handleMaintenance(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const handoff = url.searchParams.get("handoff");
    if (req.method === "GET" && url.pathname === "/" && handoff) {
      const record = maintenanceHandoffs.get(handoff);
      maintenanceHandoffs.delete(handoff);
      const session = record?.expires > Date.now()
        ? readSession(sessions, record.sessionToken, Date.now(), SESSION_TTL_MS)
        : null;
      const user = session?.kind === "admin" ? store.user(session.userId) : null;
      if (!user || user.disabled || user.role !== "admin") {
        res.writeHead(401, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        res.end("管理员浏览器入口已失效，请从管理页重新打开");
        return;
      }
      setCookie(req, res, {
        name: ADMIN_COOKIE,
        value: record.sessionToken,
        path: "/",
        maxAge: SESSION_TTL_MS / 1000,
      });
      await broker.focusMaintenance();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(MAINTENANCE_HANDOFF_PAGE);
      return;
    }
    if (!adminSession(req)) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("请从管理页点击“打开管理员浏览器”");
      return;
    }
    if (req.method === "GET" && url.pathname === "/__gpc/admin-browser.js") {
      serveFile(webDir, res, "/admin-browser.js");
      return;
    }
    if (req.method === "GET" && url.pathname === "/__gpc/download-events") {
      const session = adminSession(req);
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      adminStreams.set(res, { token: session.token, userId: session.user.id, kind: "downloads" });
      res.once("close", () => adminStreams.delete(res));
      res.flushHeaders();
      return;
    }
    const adminDownload = url.pathname.match(/^\/__gpc\/files\/([a-zA-Z0-9-]{8,80})$/);
    if (adminDownload && (req.method === "GET" || req.method === "HEAD")) {
      if (!transfers) return json(res, 503, { error: "当前部署没有启用文件传输" });
      try {
        return sendTransferFile(req, res, transfers.openDownload(adminDownload[1], { isAdmin: true }));
      } catch (error) {
        return json(res, error.status || 404, { error: error.message });
      }
    }
    if (req.method === "GET" && url.pathname === "/") {
      await broker.focusMaintenance();
      res.writeHead(302, { location: "/vnc/", "cache-control": "no-store" });
      res.end();
      return;
    }
    maintenanceProxy.web(req, res, { target: maintenanceTarget });
  }

  const maintenanceServer = http.createServer((req, res) => {
    handleMaintenance(req, res).catch((error) => {
      logger.error?.(`管理员浏览器置前失败：${error.message}`);
      if (!res.headersSent) {
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end("管理员浏览器窗口不可用");
      }
    });
  });

  webSockets.on("connection", (socket, _request, context) => {
    const { workspaceId, user, viewerId, takeover } = context;
    const ownership = liveSockets.add(user.id, viewerId, workspaceId, socket, takeover);
    if (!ownership.accepted) {
      socket.close(VIEWER_REPLACED_CLOSE_CODE, VIEWER_REPLACED_CLOSE_REASON);
      return;
    }
    if (ownership.previous) {
      broker.removeViewer(ownership.previous.workspaceId, ownership.previous.socket);
      ownership.previous.socket.close(VIEWER_REPLACED_CLOSE_CODE, VIEWER_REPLACED_CLOSE_REASON);
    }
    let queue = Promise.resolve();
    let queuedCommands = 0;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "只接受 JSON 输入");
        return;
      }
      let command;
      try {
        command = JSON.parse(data.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "输入消息不是 JSON" }));
        return;
      }
      queuedCommands += 1;
      if (queuedCommands > 128) {
        socket.close(1008, "输入过快");
        return;
      }
      queue = queue
        .then(() => broker.handleCommand(workspaceId, command, user, socket))
        .catch((error) => {
          if (socket.readyState === 1) socket.send(JSON.stringify({ type: "error", message: error.message }));
        })
        .finally(() => {
          queuedCommands -= 1;
        });
    });
    socket.on("close", () => broker.removeViewer(workspaceId, socket));
    socket.on("error", () => broker.removeViewer(workspaceId, socket));
    broker.addViewer(workspaceId, socket).catch((error) => {
      if (socket.readyState === 1) socket.close(1011, error.message.slice(0, 120));
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (!originAllowed(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const route = workspaceRoute(url.pathname);
    const viewerId = String(url.searchParams.get("viewer") || "");
    if (!route || route.suffix !== "/socket" || !WORKSPACE_ID_RE.test(route.id) || !VIEWER_ID_RE.test(viewerId)) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const session = workspaceSession(req, route.id);
    if (!session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(req, socket, head, (webSocket) => {
      webSockets.emit("connection", webSocket, req, {
        workspaceId: route.id,
        user: session.user,
        viewerId,
        takeover: url.searchParams.get("takeover") === "1",
      });
    });
  });

  maintenanceServer.on("upgrade", async (req, socket, head) => {
    if (!originAllowed(req) || !adminSession(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    maintenanceSockets.add(socket);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      maintenanceSockets.delete(socket);
      if (!maintenanceSockets.size) broker.setMaintenanceActive(false);
    };
    socket.once("close", release);
    socket.once("error", release);
    try {
      await broker.setMaintenanceActive(true);
    } catch (error) {
      release();
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      logger.error?.(`管理员浏览器置前失败：${error.message}`);
      return;
    }
    if (socket.destroyed) return;
    if (vncPassword) {
      req.headers.authorization = `Basic ${Buffer.from(`${vncUser}:${vncPassword}`).toString("base64")}`;
    }
    maintenanceProxy.ws(req, socket, head, { target: maintenanceTarget });
  });

  const heartbeat = setInterval(() => {
    for (const socket of webSockets.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30000);
  heartbeat.unref?.();
  webSockets.on("connection", (socket) => {
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
  });

  return {
    server,
    maintenanceServer,
    broker,
    async start(port = 8080, host = "0.0.0.0", maintenancePort = 0) {
      await portal?.start();
      try {
        await new Promise((resolveStart, reject) => {
          server.once("error", reject);
          server.listen(port, host, resolveStart);
        });
        await new Promise((resolveStart, reject) => {
          maintenanceServer.once("error", reject);
          maintenanceServer.listen(maintenancePort, host, resolveStart);
        });
      } catch (error) {
        if (server.listening) await new Promise((resolveStop) => server.close(resolveStop));
        await portal?.stop();
        throw error;
      }
      broker.start();
      if (!store.browserProfile().configured && resolveBrowserProfile) {
        try {
          const result = await resolveBrowserProfile({ force: false });
          if (result.warning) logger.warn?.(`${result.warning}${result.error ? ` ${result.error.message}` : ""}`);
          const runtime = await broker.applyBrowserProfile({ reload: true });
          if (runtime.failedTargets) {
            logger.warn?.(`有 ${runtime.failedTargets} 个页面等待重连后应用浏览器环境`);
          }
        } catch (error) {
          logger.warn?.(`初始化浏览器环境失败，可在管理页重试：${error.message}`);
        }
      }
      return server.address();
    },
    async stop() {
      clearInterval(heartbeat);
      unsubscribeBrokerState();
      unsubscribeAdminDownloads();
      closeAdminStreams();
      for (const socket of maintenanceSockets) socket.destroy();
      maintenanceSockets.clear();
      broker.setMaintenanceActive(false);
      broker.stop();
      await portal?.stop();
      for (const socket of webSockets.clients) socket.terminate();
      webSockets.close();
      maintenanceProxy.close();
      if (server.listening) await new Promise((resolveStop) => server.close(resolveStop));
      if (maintenanceServer.listening) await new Promise((resolveStop) => maintenanceServer.close(resolveStop));
    },
  };
}

export function createDefaultGateway(env = process.env) {
  const stateFile = env.STATE_FILE || "/data/state.json";
  const store = createStateStore({
    file: stateFile,
    adminUser: env.AUTH_USER || "admin",
    adminPassword: String(env.AUTH_PASSWORD || ""),
  });
  const sessions = createSessionStore({
    file: env.SESSIONS_FILE || join(dirname(stateFile), "sessions.json"),
    ttlMs: SESSION_TTL_MS,
  });
  const transfers = createTransferStore({
    root: env.TRANSFER_ROOT || "/transfer",
    stateFile: env.TRANSFER_STATE_FILE || join(dirname(stateFile), "transfers.json"),
    ownerUid: Number(env.PUID || 1000),
    ownerGid: Number(env.PGID || 1000),
  });
  const portal = new FilePortalBridge({
    gatewaySocket: env.PORTAL_GATEWAY_SOCKET || "/run/gpc/gateway.sock",
    desktopSocket: env.PORTAL_DESKTOP_SOCKET || "/run/gpc/desktop.sock",
    ownerUid: Number(env.PUID || 1000),
    ownerGid: Number(env.PGID || 1000),
  });
  const broker = new WorkspaceBroker({
    store,
    transferStore: transfers,
    portal,
    endpoint: env.DESKTOP_CDP || "http://desktop:9223",
    activeFrameFps: Number(env.FRAME_ACTIVE_FPS || 60),
    jpegQuality: Number(env.JPEG_QUALITY || 72),
  });
  const resolveBrowserProfile = async ({ force = false } = {}) => {
    const current = store.browserProfile();
    if (current.configured && !force) {
      return { profile: current, detected: current.source === "ip", warning: current.lastDetectionError };
    }
    const result = await resolveAutomaticBrowserProfile({
      autoDetect: force || enabled(env.PROFILE_AUTO_DETECT, true),
      endpoint: env.PROFILE_GEO_ENDPOINT || "https://ipwho.is/?fields=success,country_code,timezone.id",
      timeoutMs: Number(env.PROFILE_GEO_TIMEOUT_MS || 5000),
      env,
      fetchJson: (endpoint, options) => broker.loadPublicJson(endpoint, options),
    });
    return { ...result, profile: store.setBrowserProfile(result.profile) };
  };
  return createGateway({
    store,
    sessions,
    broker,
    transfers,
    portal,
    maintenanceTarget: env.DESKTOP_VNC || "http://desktop:3000",
    maintenanceHostPort: Number(env.MAINTENANCE_HOST_PORT || 36091),
    vncUser: env.VNC_USER || "abc",
    vncPassword: env.VNC_PASSWORD || "",
    resolveBrowserProfile,
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const app = createDefaultGateway();
  const port = Number(process.env.PORT || 8080);
  const maintenancePort = Number(process.env.MAINTENANCE_LISTEN_PORT || 8081);
  app
    .start(port, "0.0.0.0", maintenancePort)
    .then(() => console.log(`GPT Pro 网关已监听 :${port}，管理员浏览器入口监听 :${maintenancePort}`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  const shutdown = () => app.stop().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
