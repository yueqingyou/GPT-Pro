import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  projectFocusScript,
  projectNavigationAllowed,
  projectRestrictedActionMatch,
  projectScopeFromUrl,
} from "./focus.mjs";
import {
  sensitiveActionInspectExpression,
  sensitiveActionMatch,
  sensitiveGuardScript,
  sensitiveUrlMatch,
} from "./policy.mjs";
import { CHATGPT_PROJECT_ID_RE } from "./store.mjs";

const MARKER_KEY = "gpc.workspaceId";
const OPEN = 1;
const CDP_CALL_TIMEOUT_MS = 20000;
const ACTIVITY_BINDING = "__gpcVisualActivity";
const MAX_SOCKET_BUFFER_BYTES = 2 * 1024 * 1024;
const FILE_CHOOSER_TTL_MS = 2 * 60 * 1000;
const FILE_CHOOSER_GESTURE_TTL_MS = 5000;
const REMOTE_CLIPBOARD_TIMEOUT_MS = 500;
const MAX_REMOTE_CLIPBOARD_BYTES = 1024 * 1024;
const CHATGPT_COPY_TEST_ID = "copy-turn-action-button";
const DOWNLOAD_SETTLE_ATTEMPTS = 20;
const DOWNLOAD_SETTLE_DELAY_MS = 100;
const ACTIVE_AFTER_INPUT_MS = 2000;
const VISUAL_ACTIVITY_GRACE_MS = 250;
const SCREENCAST_PROFILE_SYNC_MS = 100;
const CHATGPT_PROJECTS_PATH = "/backend-api/gizmos/snorlax/sidebar";
const CHATGPT_PROJECTS_MAX_BYTES = 1024 * 1024;
const MIN_VIEWPORT_WIDTH = 320;
const MIN_VIEWPORT_HEIGHT = 240;
const EDITABLE_TARGET_SELECTOR = "textarea,[contenteditable='true'],[role='textbox'],input:not([type]),input[type='text'],input[type='search'],input[type='email'],input[type='url'],input[type='tel'],input[type='password']";
const SCREENCAST_TIERS = Object.freeze([
  { maxVisible: 1, name: "full", maxWidth: 2560, maxHeight: 1600, quality: 90 },
  { maxVisible: 4, name: "balanced", maxWidth: 1280, maxHeight: 800, quality: 70 },
  { maxVisible: 8, name: "dense", maxWidth: 960, maxHeight: 600, quality: 66 },
  { maxVisible: Infinity, name: "congested", maxWidth: 800, maxHeight: 500, quality: 60 },
]);
const USER_AGENT_METADATA_FIELDS = [
  "architecture",
  "bitness",
  "brands",
  "formFactors",
  "fullVersionList",
  "mobile",
  "model",
  "platform",
  "platformVersion",
  "wow64",
];

function visualActivityScript() {
  return `(() => {
    const binding = ${JSON.stringify(ACTIVITY_BINDING)};
    const signal = () => globalThis[binding]("");
    let queued = false;
    const notify = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        signal();
      });
    };
    const observe = () => {
      if (!document.documentElement) {
        addEventListener("DOMContentLoaded", observe, { once: true });
        return;
      }
      new MutationObserver(notify).observe(document.documentElement, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      addEventListener("scroll", notify, true);
      addEventListener("input", notify, true);
      addEventListener("change", notify, true);
      addEventListener("resize", notify, true);
      signal();
    };
    observe();
  })()`;
}
const NATIVE_USER_AGENT_EXPRESSION = `(() => {
  const read = async () => {
    const data = navigator.userAgentData;
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      metadata: data ? await data.getHighEntropyValues(${JSON.stringify(USER_AGENT_METADATA_FIELDS)}) : null,
    };
  };
  return read();
})()`;
const REMOTE_SELECTION_EXPRESSION = `(() => {
  const pageSelection = String(globalThis.getSelection()?.toString() || "");
  if (pageSelection) return pageSelection;
  const active = document.activeElement;
  if (
    (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
    Number.isInteger(active.selectionStart) &&
    Number.isInteger(active.selectionEnd)
  ) {
    return active.value.slice(active.selectionStart, active.selectionEnd);
  }
  return "";
})()`;
const REMOTE_CLIPBOARD_PERMISSION_EXPRESSION =
  `navigator.permissions.query({ name: "clipboard-read" }).then((permission) => permission.state)`;
const ARM_REMOTE_CLIPBOARD_EXPRESSION = `(() => {
  if (!("onclipboardchange" in navigator.clipboard)) throw new Error("clipboardchange unavailable");
  globalThis.__gpcClipboardChange = new Promise((resolve, reject) => {
    const changed = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      navigator.clipboard.removeEventListener("clipboardchange", changed);
      reject(new Error("clipboardchange timeout"));
    }, ${REMOTE_CLIPBOARD_TIMEOUT_MS});
    navigator.clipboard.addEventListener("clipboardchange", changed, { once: true });
  });
  return true;
})()`;
const READ_REMOTE_CLIPBOARD_EXPRESSION = `globalThis.__gpcClipboardChange
  .then(() => navigator.clipboard.readText())
  .then((text) => ({ ok: true, text }))
  .catch(() => ({ ok: false, text: "" }))
  .finally(() => { delete globalThis.__gpcClipboardChange; })`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function boundedInteger(value, minimum, maximum, defaultValue) {
  const number = Number(value);
  if (!Number.isFinite(number)) return defaultValue;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function parseChatGptProjects(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Projects 列表不是有效 JSON");
  }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) {
    throw new Error("Projects 列表结构已变化");
  }
  if (payload.cursor !== null) {
    throw new Error("Projects 超过当前一次列表上限，已拒绝部分导入");
  }
  const projects = [];
  const ids = new Set();
  for (const item of payload.items) {
    const project = item?.gizmo?.gizmo;
    const id = String(project?.id || "").trim();
    if (!project || !CHATGPT_PROJECT_ID_RE.test(id) || typeof project.display?.name !== "string") {
      throw new Error("Projects 列表结构已变化");
    }
    if (project.is_archived) continue;
    if (ids.has(id)) throw new Error("Projects 列表包含重复标识");
    ids.add(id);
    projects.push({
      id,
      name: project.display.name.trim(),
      startUrl: new URL(`/g/${id}/project`, "https://chatgpt.com/").toString(),
    });
  }
  return projects;
}

function cdpWebSocketUrl(endpoint, advertised) {
  const destination = new URL(endpoint);
  const source = new URL(advertised);
  source.protocol = destination.protocol === "https:" ? "wss:" : "ws:";
  source.host = destination.host;
  return source.toString();
}

export class CdpConnection extends EventEmitter {
  constructor(socket, { callTimeoutMs = CDP_CALL_TIMEOUT_MS } = {}) {
    super();
    this.socket = socket;
    this.callTimeoutMs = Math.max(100, Number(callTimeoutMs) || CDP_CALL_TIMEOUT_MS);
    this.nextId = 0;
    this.pending = new Map();
    this.open = true;

    socket.on("message", (data) => this.#onMessage(data));
    socket.on("close", () => this.#onClose(new Error("Chromium CDP 连接已关闭")));
    socket.on("error", (error) => this.#onClose(error));
  }

  #onMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result || {});
      return;
    }
    this.emit("event", message);
  }

  #onClose(error) {
    if (!this.open) return;
    this.open = false;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.emit("disconnect", error);
  }

  call(method, params = {}, sessionId) {
    if (!this.open || this.socket.readyState !== OPEN) return Promise.reject(new Error("Chromium CDP 尚未连接"));
    const id = ++this.nextId;
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Chromium CDP 命令超时：${method}`);
        this.#onClose(error);
        this.socket.terminate();
      }, this.callTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify(payload), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(error);
      });
    });
  }

  send(method, params = {}, sessionId) {
    if (!this.open || this.socket.readyState !== OPEN) return false;
    const payload = { id: ++this.nextId, method, params, ...(sessionId ? { sessionId } : {}) };
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  terminate() {
    if (!this.open) return;
    this.#onClose(new Error("Chromium CDP 连接已终止"));
    this.socket.terminate();
  }
}

export async function connectCdp({ endpoint, fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket, timeoutMs = 5000 }) {
  const response = await fetchImpl(`${String(endpoint).replace(/\/$/, "")}/json/version`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Chromium CDP 返回 HTTP ${response.status}`);
  const version = await response.json();
  if (!version.webSocketDebuggerUrl) throw new Error("Chromium 没有提供调试 WebSocket");
  const socket = new WebSocketImpl(cdpWebSocketUrl(endpoint, version.webSocketDebuggerUrl), {
    handshakeTimeout: timeoutMs,
    maxPayload: 8 * 1024 * 1024,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("连接 Chromium CDP 超时"));
    }, timeoutMs);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return new CdpConnection(socket);
}

export class WorkspaceBroker {
  constructor({
    store,
    endpoint = "http://desktop:9223",
    frameFps = 8,
    activeFrameFps = 60,
    idleFrameMs = 2000,
    jpegQuality = 72,
    viewport = { width: 1440, height: 900 },
    transferStore = null,
    connect = () => connectCdp({ endpoint }),
    logger = console,
  }) {
    if (!store) throw new Error("WorkspaceBroker 需要状态存储");
    this.store = store;
    this.endpoint = endpoint;
    this.frameFps = boundedInteger(frameFps, 1, 30, 8);
    this.activeFrameFps = Math.max(this.frameFps, boundedInteger(activeFrameFps, 1, 60, 60));
    this.idleFrameMs = boundedInteger(idleFrameMs, 500, 10000, 2000);
    this.jpegQuality = boundedInteger(jpegQuality, 35, 90, 72);
    this.defaultViewport = {
      width: boundedInteger(viewport.width, MIN_VIEWPORT_WIDTH, 2560, 1440),
      height: boundedInteger(viewport.height, MIN_VIEWPORT_HEIGHT, 1600, 900),
    };
    this.transferStore = transferStore;
    this.connect = connect;
    this.logger = logger;
    this.connection = null;
    this.connecting = null;
    this.runtimes = new Map();
    this.runtimePromises = new Map();
    this.workspaceBySession = new Map();
    this.auxiliarySessions = new Map();
    this.auxiliaryBySession = new Map();
    this.pendingManagedTargets = new Set();
    this.ignoredTargets = new Set();
    this.nativeUserAgentState = null;
    this.viewers = new Map();
    this.viewerStates = new WeakMap();
    this.downloadWorkspaceByGuid = new Map();
    this.settlingDownloads = new Set();
    this.clipboardQueue = Promise.resolve();
    this.captureMetrics = {
      frames: 0,
      droppedFrames: 0,
      throttledFrames: 0,
      idleFrames: 0,
      heartbeatFrames: 0,
      streamRestarts: 0,
    };
    this.heartbeatTimer = null;
    this.screencastProfileTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelayMs = 500;
    this.connectionWarningShown = false;
    this.discovering = false;
    this.maintenanceActive = false;
    this.stopped = false;
  }

  status() {
    const visibleWorkspaces = this.#visibleWorkspaceCount();
    const streamTier = this.#streamTier(visibleWorkspaces);
    return {
      connected: !!this.connection?.open,
      workspaces: this.store.workspaces().length,
      targets: [...this.runtimes.values()].filter((runtime) => runtime.ready).length,
      viewers: [...this.viewers.values()].reduce((sum, viewers) => sum + viewers.size, 0),
      focusedViewers: [...this.viewers.values()].reduce(
        (sum, viewers) => sum + [...viewers].filter((socket) => this.viewerStates.get(socket)?.focused).length,
        0,
      ),
      visibleViewers: [...this.viewers.values()].reduce(
        (sum, viewers) => sum + [...viewers].filter((socket) => this.viewerStates.get(socket)?.visible).length,
        0,
      ),
      activeWorkspaces: [...this.viewers.keys()].filter((workspaceId) => this.#workspaceIsActive(workspaceId)).length,
      maintenanceActive: this.maintenanceActive,
      captureMode: "target-screencast",
      frameFps: this.frameFps,
      activeFrameFps: this.activeFrameFps,
      capturing: [...this.runtimes.values()].filter((runtime) => runtime.screencastRunning).length,
      frames: this.captureMetrics.frames,
      droppedFrames: this.captureMetrics.droppedFrames,
      throttledFrames: this.captureMetrics.throttledFrames,
      idleFrames: this.captureMetrics.idleFrames,
      heartbeatFrames: this.captureMetrics.heartbeatFrames,
      streamRestarts: this.captureMetrics.streamRestarts,
      streamTier: streamTier.name,
      streamMaxWidth: streamTier.maxWidth,
      streamMaxHeight: streamTier.maxHeight,
      streamQuality: Math.min(this.jpegQuality, streamTier.quality),
    };
  }

  start() {
    this.stopped = false;
    this.connectionWarningShown = false;
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.#sendHeartbeatFrames(), this.idleFrameMs);
      this.heartbeatTimer.unref?.();
    }
    this.#ensureConnection().catch(() => {});
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.screencastProfileTimer) clearTimeout(this.screencastProfileTimer);
    this.screencastProfileTimer = null;
    for (const runtime of this.runtimes.values()) {
      if (runtime.activeTimer) clearTimeout(runtime.activeTimer);
    }
    this.connection?.terminate();
    this.connection = null;
    this.runtimes.clear();
    this.runtimePromises.clear();
    this.workspaceBySession.clear();
    this.auxiliarySessions.clear();
    this.auxiliaryBySession.clear();
    this.pendingManagedTargets.clear();
    this.ignoredTargets.clear();
    this.nativeUserAgentState = null;
    this.downloadWorkspaceByGuid.clear();
    this.discovering = false;
    this.maintenanceActive = false;
    for (const viewers of this.viewers.values()) {
      for (const socket of viewers) socket.close(1012, "网关正在停止");
    }
    this.viewers.clear();
  }

  async #ensureConnection() {
    if (this.connection?.open) return this.connection;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let connection;
      try {
        connection = await this.connect();
        if (this.stopped) {
          connection.terminate();
          throw new Error("WorkspaceBroker 已停止");
        }
        this.connection = connection;
        connection.on("event", (message) => this.#handleEvent(connection, message));
        connection.once("disconnect", (error) => this.#handleDisconnect(connection, error));
        this.discovering = true;
        await connection.call("Target.setDiscoverTargets", { discover: true });
        if (this.transferStore) {
          await connection.call("Browser.setDownloadBehavior", {
            behavior: "allowAndName",
            downloadPath: this.transferStore.downloadRoot,
            eventsEnabled: true,
          });
        }
        this.nativeUserAgentState = await this.#captureNativeUserAgentState(connection);
        await this.#discoverExistingTargets(connection);
        this.discovering = false;
        for (const workspace of this.store.workspaces()) {
          await this.#ensureRuntime(workspace, connection);
        }
        this.reconnectDelayMs = 500;
        this.connectionWarningShown = false;
        this.#broadcastAll({ type: "status", state: "connected" });
        return connection;
      } catch (error) {
        this.discovering = false;
        if (connection?.open) connection.terminate();
        if (!this.connectionWarningShown) {
          this.connectionWarningShown = true;
          this.logger.warn?.(`CDP 尚未就绪：${error.message}`);
        }
        this.#scheduleReconnect();
        throw error;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(10000, Math.round(this.reconnectDelayMs * 1.8));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#ensureConnection().catch(() => {});
    }, delay);
    this.reconnectTimer.unref?.();
  }

  #handleDisconnect(connection, error) {
    if (this.connection !== connection) return;
    this.connection = null;
    for (const runtime of this.runtimes.values()) {
      if (runtime.activeTimer) clearTimeout(runtime.activeTimer);
    }
    this.runtimes.clear();
    this.runtimePromises.clear();
    this.workspaceBySession.clear();
    this.auxiliarySessions.clear();
    this.auxiliaryBySession.clear();
    this.pendingManagedTargets.clear();
    this.ignoredTargets.clear();
    this.nativeUserAgentState = null;
    this.downloadWorkspaceByGuid.clear();
    this.discovering = false;
    this.#broadcastAll({ type: "status", state: "reconnecting", message: error?.message || "浏览器连接中断" });
    this.#scheduleReconnect();
  }

  #handleEvent(connection, message) {
    if (connection !== this.connection) return;
    if (message.method === "Browser.downloadWillBegin" && this.transferStore) {
      try {
        const runtime = [...this.runtimes.values()].find((candidate) => candidate.frameIds.has(message.params?.frameId));
        const workspaceId = runtime?.workspaceId || null;
        const entry = this.transferStore.beginDownload({
          id: message.params?.guid,
          workspaceId,
          name: message.params?.suggestedFilename,
        });
        this.downloadWorkspaceByGuid.set(entry.id, workspaceId);
        if (workspaceId) this.#broadcast(workspaceId, { type: "download", file: entry });
      } catch (error) {
        this.logger.warn?.(`记录 Chromium 下载失败：${error.message}`);
      }
      return;
    }
    if (message.method === "Browser.downloadProgress" && this.transferStore) {
      try {
        const result = this.transferStore.updateDownload({ id: message.params?.guid, ...message.params });
        const workspaceId = this.downloadWorkspaceByGuid.get(message.params?.guid) || result.entry?.workspaceId;
        if (workspaceId && result.entry) this.#broadcast(workspaceId, { type: "download", file: result.entry });
        if (result.cancel) {
          connection.call("Browser.cancelDownload", { guid: message.params?.guid }).catch(() => {});
        }
        if (result.retry) {
          this.#settleCompletedDownload(message.params, workspaceId).catch((error) => {
            this.logger.warn?.(`确认 Chromium 下载文件失败：${error.message}`);
          });
          return;
        }
        if (["completed", "canceled", "interrupted"].includes(message.params?.state)) {
          this.downloadWorkspaceByGuid.delete(message.params?.guid);
        }
      } catch (error) {
        this.logger.warn?.(`更新 Chromium 下载状态失败：${error.message}`);
      }
      return;
    }
    if (message.method === "Target.targetCreated" && message.params?.targetInfo?.type === "page") {
      if (this.discovering) return;
      const { targetId, openerId } = message.params.targetInfo;
      const opener = [...this.runtimes.values()].find((runtime) => runtime.targetId === openerId);
      if (opener) {
        this.ignoredTargets.add(targetId);
        connection
          .call("Target.closeTarget", { targetId })
          .catch((error) => this.logger.warn?.(`关闭普通工作区弹窗失败：${error.message}`))
          .finally(() => this.ignoredTargets.delete(targetId));
        this.#broadcastProjectBlock(opener.workspaceId);
        return;
      }
      const timer = setTimeout(() => {
        this.#attachAuxiliaryTarget(connection, targetId).catch((error) => {
          this.logger.warn?.(`应用浏览器环境到新页面失败：${error.message}`);
        });
      }, 150);
      timer.unref?.();
      return;
    }
    if (message.method === "Target.targetDestroyed") {
      const runtime = [...this.runtimes.values()].find((candidate) => candidate.targetId === message.params?.targetId);
      if (runtime) this.#dropRuntime(runtime.workspaceId);
      this.#dropAuxiliaryTarget(message.params?.targetId);
      this.pendingManagedTargets.delete(message.params?.targetId);
      this.ignoredTargets.delete(message.params?.targetId);
      return;
    }
    const workspaceId = message.sessionId ? this.workspaceBySession.get(message.sessionId) : "";
    const runtime = workspaceId ? this.runtimes.get(workspaceId) : null;
    if (message.method === "Page.screencastFrame" && runtime) {
      this.#handleScreencastFrame(connection, runtime, message.params);
      return;
    }
    if (message.method === "Runtime.bindingCalled" && runtime && message.params?.name === ACTIVITY_BINDING) {
      this.#markVisualActivity(runtime);
      return;
    }
    if (message.method === "Page.fileChooserOpened" && runtime) {
      const owner = runtime.fileChooserOwner;
      runtime.fileChooserOwner = null;
      runtime.fileChooser = null;
      if (
        !owner ||
        Date.now() - owner.createdAt > FILE_CHOOSER_GESTURE_TTL_MS ||
        !this.viewers.get(workspaceId)?.has(owner.viewer)
      ) {
        connection
          .call("Page.setInterceptFileChooserDialog", { enabled: true, cancel: true }, runtime.sessionId)
          .catch(() => {});
        return;
      }
      runtime.fileChooser = {
        backendNodeId: message.params?.backendNodeId,
        mode: message.params?.mode || "selectSingle",
        openedAt: Date.now(),
        userId: owner.userId,
        viewer: owner.viewer,
      };
      this.#sendJson(owner.viewer, { type: "file-chooser", mode: runtime.fileChooser.mode });
      return;
    }
    if (message.method === "Network.requestWillBeSent" && runtime) {
      const pattern = sensitiveUrlMatch(this.store.sensitivePolicy(), message.params?.request?.url);
      if (pattern) {
        if (runtime.blockedRequests.size >= 128) runtime.blockedRequests.delete(runtime.blockedRequests.keys().next().value);
        runtime.blockedRequests.set(message.params.requestId, pattern);
      }
      return;
    }
    if (message.method === "Page.frameDetached" && runtime) {
      runtime.frameIds.delete(message.params?.frameId);
      return;
    }
    if ((message.method === "Network.loadingFailed" || message.method === "Network.loadingFinished") && runtime) {
      const pattern = runtime.blockedRequests.get(message.params?.requestId);
      runtime.blockedRequests.delete(message.params?.requestId);
      if (pattern && message.method === "Network.loadingFailed") this.#broadcastPolicyBlock(workspaceId, pattern);
      return;
    }
    if (message.method === "Inspector.detached" && message.sessionId) {
      if (workspaceId) this.#dropRuntime(workspaceId);
      const auxiliaryTarget = this.auxiliaryBySession.get(message.sessionId);
      if (auxiliaryTarget) this.#dropAuxiliaryTarget(auxiliaryTarget);
      return;
    }
    if (message.method === "Page.navigatedWithinDocument" && runtime) {
      if (message.params.frameId === runtime.mainFrameId) {
        this.#handleMainNavigation(connection, runtime, message.params.url);
      }
      return;
    }
    if (message.method !== "Page.frameNavigated" || !runtime) return;
    runtime.frameIds.add(message.params.frame.id);
    if (message.params.frame.parentId) return;
    runtime.frameIds.clear();
    runtime.frameIds.add(message.params.frame.id);
    runtime.mainFrameId = message.params.frame.id;
    if (runtime.ready) this.#writeMarker(connection, runtime).catch(() => {});
    this.#handleMainNavigation(connection, runtime, message.params.frame.url);
  }

  #handleMainNavigation(connection, runtime, url) {
    const workspaceId = runtime.workspaceId;
    this.#markVisualActivity(runtime, ACTIVE_AFTER_INPUT_MS);
    runtime.fileChooser = null;
    runtime.fileChooserOwner = null;
    if (!projectNavigationAllowed(runtime.projectScope, url, runtime.safeUrl)) {
      this.#broadcastProjectBlock(workspaceId);
      connection.call("Page.navigate", { url: runtime.safeUrl }, runtime.sessionId).catch(() => {});
      return;
    }
    const blockedPattern = sensitiveUrlMatch(this.store.sensitivePolicy(), url);
    if (blockedPattern) {
      this.#broadcastPolicyBlock(workspaceId, blockedPattern);
      connection.call("Page.navigate", { url: runtime.safeUrl }, runtime.sessionId).catch(() => {});
      return;
    }
    try {
      if (this.store.recordLastUrl(workspaceId, url)) runtime.safeUrl = url;
    } catch (error) {
      this.logger.error?.(`保存工作区 ${workspaceId} 地址失败：${error.message}`);
    }
  }

  #dropRuntime(workspaceId) {
    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) return;
    if (runtime.activeTimer) clearTimeout(runtime.activeTimer);
    this.workspaceBySession.delete(runtime.sessionId);
    this.runtimes.delete(workspaceId);
  }

  #dropAuxiliaryTarget(targetId) {
    const sessionId = this.auxiliarySessions.get(targetId);
    if (!sessionId) return;
    this.auxiliarySessions.delete(targetId);
    this.auxiliaryBySession.delete(sessionId);
  }

  async #settleCompletedDownload(params, workspaceId) {
    const id = String(params?.guid || "");
    if (!id || this.settlingDownloads.has(id) || !this.transferStore) return;
    this.settlingDownloads.add(id);
    try {
      for (let attempt = 1; attempt <= DOWNLOAD_SETTLE_ATTEMPTS; attempt += 1) {
        await sleep(DOWNLOAD_SETTLE_DELAY_MS);
        const result = this.transferStore.updateDownload({
          id,
          state: "completed",
          receivedBytes: params?.receivedBytes,
          totalBytes: params?.totalBytes,
          filePath: params?.filePath,
          finalAttempt: attempt === DOWNLOAD_SETTLE_ATTEMPTS,
        });
        if (result.retry) continue;
        if (workspaceId && result.entry) this.#broadcast(workspaceId, { type: "download", file: result.entry });
        this.downloadWorkspaceByGuid.delete(id);
        return;
      }
    } finally {
      this.settlingDownloads.delete(id);
    }
  }

  #knownTarget(targetId) {
    return (
      this.pendingManagedTargets.has(targetId) ||
      this.ignoredTargets.has(targetId) ||
      this.auxiliarySessions.has(targetId) ||
      [...this.runtimes.values()].some((runtime) => runtime.targetId === targetId)
    );
  }

  #broadcastPolicyBlock(workspaceId, pattern) {
    this.#broadcast(workspaceId, {
      type: "policy-blocked",
      message: "该操作属于管理员专属范围，普通工作区已拦截。",
      pattern: String(pattern || "敏感操作").slice(0, 180),
    });
  }

  #broadcastProjectBlock(workspaceId) {
    this.#broadcast(workspaceId, {
      type: "policy-blocked",
      message: "当前页面超出该工作区允许的 ChatGPT 范围。",
      pattern: "project navigation allowlist",
    });
  }

  #broadcastShareBlock(workspaceId) {
    this.#broadcast(workspaceId, {
      type: "policy-blocked",
      message: "普通工作区不提供 ChatGPT 分享功能。",
      pattern: "share",
    });
  }

  #broadcastProjectControlsBlock(workspaceId) {
    this.#broadcast(workspaceId, {
      type: "policy-blocked",
      message: "普通工作区不提供项目名称、图标或项目菜单操作。",
      pattern: "project controls",
    });
  }

  #broadcastWorkspaceToolBlock(workspaceId) {
    this.#broadcast(workspaceId, {
      type: "policy-blocked",
      message: "该功能未在普通工作区白名单中。",
      pattern: "workspace tool allowlist",
    });
  }

  async #inputActionAt(connection, runtime, { x, y, active = false }) {
    const target = active ? "document.activeElement" : `document.elementFromPoint(${Number(x)}, ${Number(y)})`;
    const expression = `(() => {
      const target = ${target};
      const action = ${sensitiveActionInspectExpression("target")};
      if (!(target instanceof Element)) return { ...action, editable: false };
      const candidate = target.closest('[role="menuitem"],[role="menuitemradio"],button') || target;
      const composerMenu = (menu) => {
        let current = menu;
        while (current?.id) {
          const trigger = document.querySelector('[aria-controls="' + CSS.escape(current.id) + '"]');
          if (!trigger) return false;
          if (trigger.matches('[data-testid="composer-plus-btn"]')) return true;
          current = trigger.closest('[role="menu"]');
        }
        return false;
      };
      const menu = candidate.closest('[role="menu"]');
      const dialog = candidate.closest('[role="dialog"]');
      const composerTool = composerMenu(menu);
      const addSource = candidate.matches('button:not([data-testid="close-button"])') &&
        String(dialog?.querySelector("h2")?.textContent || "").trim().toLocaleLowerCase("en-US") === "add sources";
      return {
        ...action,
        editable: !!target.closest(${JSON.stringify(EDITABLE_TARGET_SELECTOR)}),
        surface: composerTool ? "composer-tool" : addSource ? "add-source" : "",
        controlName: composerTool
          ? candidate.querySelector(".truncate, .line-clamp-1")?.textContent || candidate.textContent || ""
          : addSource ? candidate.textContent || "" : "",
        submenu: candidate.getAttribute("aria-haspopup") === "menu",
      };
    })()`;
    const result = await connection.call("Runtime.evaluate", { expression, returnByValue: true }, runtime.sessionId);
    const action = result.result?.value;
    if (result.exceptionDetails || !action || typeof action !== "object") throw new Error("输入守卫不可用");
    return action;
  }

  async #selectionText(connection, runtime) {
    const result = await connection.call(
      "Runtime.evaluate",
      { expression: REMOTE_SELECTION_EXPRESSION, returnByValue: true },
      runtime.sessionId,
    );
    if (result.exceptionDetails || typeof result.result?.value !== "string") throw new Error("无法读取远端选区");
    return result.result.value;
  }

  #isChatGptCopyAction(action) {
    return (
      String(action?.tagName || "").toLocaleLowerCase("en-US") === "button" &&
      String(action?.testId || "").toLocaleLowerCase("en-US") === CHATGPT_COPY_TEST_ID
    );
  }

  #queueRemoteClipboardCopy(connection, runtime, viewer, mouseParams) {
    const operation = this.clipboardQueue.then(() =>
      this.#copyRemoteClipboard(connection, runtime, viewer, mouseParams),
    );
    this.clipboardQueue = operation.catch(() => {});
    return operation;
  }

  async #copyRemoteClipboard(connection, runtime, viewer, mouseParams) {
    if (!viewer || !this.viewers.get(runtime.workspaceId)?.has(viewer)) {
      throw new Error("画面连接不属于当前工作区");
    }
    await connection.call("Page.bringToFront", {}, runtime.sessionId);
    const { executionContextId } = await connection.call(
      "Page.createIsolatedWorld",
      { frameId: runtime.mainFrameId, worldName: "gpc-clipboard" },
      runtime.sessionId,
    );
    if (!executionContextId) throw new Error("无法创建远端剪贴板隔离环境");
    const permission = await connection.call(
      "Runtime.evaluate",
      {
        expression: REMOTE_CLIPBOARD_PERMISSION_EXPRESSION,
        contextId: executionContextId,
        awaitPromise: true,
        returnByValue: true,
      },
      runtime.sessionId,
    );
    const previousPermission = permission.result?.value;
    if (!["granted", "denied", "prompt"].includes(previousPermission)) {
      throw new Error("无法读取远端剪贴板权限");
    }
    const origin = new URL(runtime.safeUrl).origin;
    if (previousPermission !== "granted") {
      await connection.call("Browser.setPermission", {
        permission: { name: "clipboard-read" },
        setting: "granted",
        origin,
      });
    }
    let text;
    try {
      const armed = await connection.call(
        "Runtime.evaluate",
        { expression: ARM_REMOTE_CLIPBOARD_EXPRESSION, contextId: executionContextId, returnByValue: true },
        runtime.sessionId,
      );
      if (armed.exceptionDetails || armed.result?.value !== true) throw new Error("无法监听远端剪贴板");
      await connection.call("Input.dispatchMouseEvent", mouseParams, runtime.sessionId);
      const result = await connection.call(
        "Runtime.evaluate",
        {
          expression: READ_REMOTE_CLIPBOARD_EXPRESSION,
          contextId: executionContextId,
          awaitPromise: true,
          userGesture: true,
          returnByValue: true,
        },
        runtime.sessionId,
      );
      const payload = result.result?.value;
      if (result.exceptionDetails || !payload?.ok || typeof payload.text !== "string") {
        throw new Error("远端剪贴板没有更新");
      }
      if (Buffer.byteLength(payload.text, "utf8") > MAX_REMOTE_CLIPBOARD_BYTES) {
        throw new Error("远端剪贴板文本超过 1 MiB");
      }
      text = payload.text;
    } finally {
      if (previousPermission !== "granted") {
        await connection.call("Browser.setPermission", {
          permission: { name: "clipboard-read" },
          setting: previousPermission,
          origin,
        });
      }
      if (this.maintenanceActive) await this.#focusMaintenanceTarget(connection);
    }
    this.#sendJson(viewer, { type: "clipboard", text });
  }

  #blockInputAction(workspaceId, runtime, action) {
    const restricted = projectRestrictedActionMatch(
      runtime.projectScope,
      action,
      this.store.composerToolAllowlist(),
    );
    if (restricted) {
      if (restricted === "share") this.#broadcastShareBlock(workspaceId);
      else if (restricted === "workspace tool") this.#broadcastWorkspaceToolBlock(workspaceId);
      else this.#broadcastProjectControlsBlock(workspaceId);
      return true;
    }
    if (action.href && !projectNavigationAllowed(runtime.projectScope, action.href, runtime.safeUrl)) {
      this.#broadcastProjectBlock(workspaceId);
      return true;
    }
    const pattern = sensitiveActionMatch(this.store.sensitivePolicy(), action.description);
    if (!pattern) return false;
    this.#broadcastPolicyBlock(workspaceId, pattern);
    return true;
  }

  async #applySensitivePolicyToRuntime(connection, runtime) {
    const policy = this.store.sensitivePolicy();
    const source = sensitiveGuardScript(policy);
    if (runtime.policyScriptId) {
      await connection.call(
        "Page.removeScriptToEvaluateOnNewDocument",
        { identifier: runtime.policyScriptId },
        runtime.sessionId,
      );
    }
    const installed = await connection.call(
      "Page.addScriptToEvaluateOnNewDocument",
      { source, worldName: "gpc-sensitive-guard", runImmediately: true },
      runtime.sessionId,
    );
    runtime.policyScriptId = installed.identifier;
    await connection.call(
      "Network.setBlockedURLs",
      {
        urlPatterns: policy.enabled
          ? policy.urlPatterns.map((urlPattern) => ({ urlPattern, block: true }))
          : [],
      },
      runtime.sessionId,
    );
    return true;
  }

  async #applyProjectFocusToRuntime(connection, runtime, startUrl) {
    if (runtime.focusScriptId) {
      await connection.call(
        "Page.removeScriptToEvaluateOnNewDocument",
        { identifier: runtime.focusScriptId },
        runtime.sessionId,
      );
    }
    const installed = await connection.call(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: projectFocusScript(this.store.composerToolAllowlist()),
        worldName: "gpc-project-focus",
        runImmediately: true,
      },
      runtime.sessionId,
    );
    runtime.focusScriptId = installed.identifier;
    runtime.projectScope = projectScopeFromUrl(startUrl);
  }

  async #selectUploadFiles(connection, runtime, uploads, chooser) {
    if (!uploads?.length) throw new Error("没有可上传文件");
    if (!chooser?.backendNodeId) throw new Error("当前文件选择已失效，请在 ChatGPT 页面重新点击上传文件");
    if (chooser?.mode === "selectSingle" && uploads.length > 1) {
      throw new Error("当前上传入口一次只接受一个文件，请分次选择");
    }
    await connection.call(
      "DOM.setFileInputFiles",
      { files: uploads.map((upload) => upload.path), backendNodeId: chooser.backendNodeId },
      runtime.sessionId,
    );
    runtime.fileChooser = null;
    this.#sendJson(chooser.viewer, {
      type: "files-selected",
      files: uploads.map(({ id, name, size }) => ({ id, name, size })),
    });
  }

  async #captureNativeUserAgentState(connection) {
    const { targetId } = await connection.call("Target.createTarget", { url: "chrome://newtab/", background: true });
    this.ignoredTargets.add(targetId);
    try {
      const { sessionId } = await connection.call("Target.attachToTarget", { targetId, flatten: true });
      await connection.call("Runtime.enable", {}, sessionId);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const result = await connection.call(
            "Runtime.evaluate",
            { expression: NATIVE_USER_AGENT_EXPRESSION, awaitPromise: true, returnByValue: true },
            sessionId,
          );
          const value = result.result?.value;
          if (
            !result.exceptionDetails &&
            value?.userAgent &&
            value.metadata?.brands?.length > 0 &&
            value.metadata.platform
          ) {
            return structuredClone(value);
          }
        } catch (error) {
          if (attempt === 19) throw error;
        }
        await sleep(100);
      }
      throw new Error("无法读取 Chromium 原生 User-Agent Client Hints");
    } finally {
      await connection.call("Target.closeTarget", { targetId }).catch(() => {});
      const timer = setTimeout(() => this.ignoredTargets.delete(targetId), 500);
      timer.unref?.();
    }
  }

  async #setLocaleOverride(connection, sessionId, locale) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await connection.call("Emulation.setLocaleOverride", { locale }, sessionId);
        return;
      } catch (error) {
        if (!error.message.includes("Another locale override is already in effect") || attempt === 19) throw error;
        await sleep(100);
      }
    }
  }

  async #applyBrowserProfileToSession(connection, sessionId) {
    const profile = this.store.browserProfile();
    if (!profile?.configured) return false;
    if (!this.nativeUserAgentState) throw new Error("Chromium 原生 User-Agent 状态尚未准备");
    const { userAgent, platform, metadata } = this.nativeUserAgentState;
    const userAgentOverride = {
      userAgent,
      acceptLanguage: profile.languages.join(","),
      platform,
      ...(metadata ? { userAgentMetadata: metadata } : {}),
    };
    await connection.call("Network.enable", {}, sessionId);
    await connection.call("Emulation.setTimezoneOverride", { timezoneId: profile.timezone }, sessionId);
    await this.#setLocaleOverride(connection, sessionId, profile.locale.replaceAll("-", "_"));
    await connection.call("Emulation.setUserAgentOverride", userAgentOverride, sessionId);
    return true;
  }

  async #attachAuxiliaryTarget(connection, targetId) {
    if (connection !== this.connection || !connection.open || this.#knownTarget(targetId)) return null;
    let sessionId;
    try {
      ({ sessionId } = await connection.call("Target.attachToTarget", { targetId, flatten: true }));
      if (this.#knownTarget(targetId)) {
        await connection.call("Target.detachFromTarget", { sessionId }).catch(() => {});
        return null;
      }
      await connection.call("Runtime.enable", {}, sessionId);
      const marker = await connection.call(
        "Runtime.evaluate",
        {
          expression: `location.protocol === "https:" ? sessionStorage.getItem(${JSON.stringify(MARKER_KEY)}) || "" : ""`,
          returnByValue: true,
        },
        sessionId,
      );
      if (this.store.workspace(String(marker.result?.value || ""))) {
        await connection.call("Target.closeTarget", { targetId });
        return null;
      }
      this.auxiliarySessions.set(targetId, sessionId);
      this.auxiliaryBySession.set(sessionId, targetId);
      await this.#applyBrowserProfileToSession(connection, sessionId);
      return sessionId;
    } catch (error) {
      this.#dropAuxiliaryTarget(targetId);
      if (sessionId) await connection.call("Target.detachFromTarget", { sessionId }).catch(() => {});
      throw error;
    }
  }

  async #prepareRuntime(connection, workspace, targetId, sessionId) {
    await connection.call("Page.enable", {}, sessionId);
    await connection.call("Runtime.enable", {}, sessionId);
    await connection.call("DOM.enable", {}, sessionId);
    await connection.call("Network.enable", {}, sessionId);
    await connection.call(
      "Runtime.addBinding",
      { name: ACTIVITY_BINDING, executionContextName: "gpc-visual-activity" },
      sessionId,
    );
    await connection.call("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId);
    const runtime = {
      workspaceId: workspace.id,
      targetId,
      sessionId,
      viewport: { ...this.defaultViewport },
      safeUrl: workspace.lastUrl,
      mainFrameId: "",
      frameIds: new Set(),
      policyScriptId: "",
      focusScriptId: "",
      projectScope: null,
      blockedRequests: new Map(),
      fileChooser: null,
      fileChooserOwner: null,
      activeUntil: 0,
      activeTimer: null,
      windowId: null,
      windowInsets: { width: 0, height: 0 },
      windowVisible: true,
      screencastRunning: false,
      screencastProfileKey: "",
      screencastRestartRequested: false,
      screencastSync: Promise.resolve(),
      frameBudget: 1,
      frameBudgetAt: 0,
      lastFrame: null,
      lastFrameAt: 0,
      lastFrameSentAt: 0,
      visualActiveUntil: Date.now() + VISUAL_ACTIVITY_GRACE_MS,
      ready: false,
    };
    this.runtimes.set(workspace.id, runtime);
    this.workspaceBySession.set(sessionId, workspace.id);
    try {
      const { frameTree } = await connection.call("Page.getFrameTree", {}, sessionId);
      const collectFrames = (node) => {
        if (!node?.frame?.id) return;
        runtime.frameIds.add(node.frame.id);
        for (const child of node.childFrames || []) collectFrames(child);
      };
      collectFrames(frameTree);
      runtime.mainFrameId = frameTree?.frame?.id || "";
      const window = await connection.call("Browser.getWindowForTarget", { targetId });
      if (!Number.isInteger(window.windowId)) throw new Error("无法定位工作区 Chromium 窗口");
      runtime.windowId = window.windowId;
      await connection.call("Browser.setWindowBounds", {
        windowId: runtime.windowId,
        bounds: { windowState: "normal" },
      });
      const windowMetrics = await connection.call(
        "Runtime.evaluate",
        {
          expression: `({ outerWidth, outerHeight, innerWidth, innerHeight })`,
          returnByValue: true,
        },
        sessionId,
      );
      const metrics = windowMetrics.result?.value;
      if (
        windowMetrics.exceptionDetails ||
        !metrics ||
        ![metrics.outerWidth, metrics.outerHeight, metrics.innerWidth, metrics.innerHeight].every(Number.isFinite)
      ) {
        throw new Error("无法读取工作区 Chromium 窗口尺寸");
      }
      runtime.windowInsets = {
        width: Math.max(0, Math.round(metrics.outerWidth - metrics.innerWidth)),
        height: Math.max(0, Math.round(metrics.outerHeight - metrics.innerHeight)),
      };
      await this.#setRuntimeViewport(connection, runtime, runtime.viewport);
      await connection.call(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: visualActivityScript(), worldName: "gpc-visual-activity", runImmediately: true },
        sessionId,
      );
      await this.#applyBrowserProfileToSession(connection, sessionId);
      await this.#applyProjectFocusToRuntime(connection, runtime, workspace.startUrl);
      await this.#applySensitivePolicyToRuntime(connection, runtime);
    } catch (error) {
      this.#dropRuntime(workspace.id);
      throw error;
    }
    return runtime;
  }

  async #writeMarker(connection, runtime) {
    const expression = `(() => {
      if (!/^https?:$/.test(location.protocol) || document.readyState === "loading") return false;
      sessionStorage.setItem(${JSON.stringify(MARKER_KEY)}, ${JSON.stringify(runtime.workspaceId)});
      return true;
    })()`;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await connection.call(
        "Runtime.evaluate",
        { expression, returnByValue: true },
        runtime.sessionId,
      );
      if (response.result?.value === true) return;
      await sleep(250);
    }
    throw new Error(`工作区 ${runtime.workspaceId} 页面标记超时`);
  }

  async #discoverExistingTargets(connection) {
    const { targetInfos = [] } = await connection.call("Target.getTargets");
    for (const target of targetInfos) {
      if (target.type !== "page" || this.#knownTarget(target.targetId)) continue;
      let sessionId;
      let managedWorkspaceId = "";
      try {
        ({ sessionId } = await connection.call("Target.attachToTarget", { targetId: target.targetId, flatten: true }));
        await connection.call("Runtime.enable", {}, sessionId);
        const response = await connection.call(
          "Runtime.evaluate",
          {
            expression: `location.protocol === "https:" ? sessionStorage.getItem(${JSON.stringify(MARKER_KEY)}) || "" : ""`,
            returnByValue: true,
          },
          sessionId,
        );
        const workspaceId = String(response.result?.value || "");
        if (!this.store.workspace(workspaceId)) {
          this.auxiliarySessions.set(target.targetId, sessionId);
          this.auxiliaryBySession.set(sessionId, target.targetId);
          await this.#applyBrowserProfileToSession(connection, sessionId);
          continue;
        }
        const workspace = this.store.workspace(workspaceId);
        if (!workspace || this.runtimes.has(workspaceId)) {
          await connection.call("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
          continue;
        }
        managedWorkspaceId = workspaceId;
        const runtime = await this.#prepareRuntime(connection, workspace, target.targetId, sessionId);
        runtime.ready = true;
        await this.#syncScreencast(runtime);
      } catch (error) {
        if (sessionId) this.#dropAuxiliaryTarget(target.targetId);
        if (managedWorkspaceId) {
          this.#dropRuntime(managedWorkspaceId);
          await connection.call("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
        } else if (sessionId) {
          await connection.call("Target.detachFromTarget", { sessionId }).catch(() => {});
        }
        if (error.message.includes("No target with given id found")) continue;
        this.logger.warn?.(`识别已有 Target 失败：${error.message}`);
      }
    }
  }

  async #ensureRuntime(workspace, connection) {
    const pending = this.runtimePromises.get(workspace.id);
    if (pending) return pending;
    const existing = this.runtimes.get(workspace.id);
    if (existing?.ready) return existing;
    const creation = this.#createRuntime(workspace, connection).finally(() => {
      if (this.runtimePromises.get(workspace.id) === creation) this.runtimePromises.delete(workspace.id);
    });
    this.runtimePromises.set(workspace.id, creation);
    return creation;
  }

  async #createRuntime(workspace, connection) {
    if (connection !== this.connection || !connection.open) throw new Error("Chromium CDP 连接已经切换");
    const { targetId } = await connection.call("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
      background: false,
      focus: false,
      left: 0,
      top: 0,
      width: this.defaultViewport.width,
      height: this.defaultViewport.height,
      windowState: "normal",
    });
    this.pendingManagedTargets.add(targetId);
    let sessionId;
    try {
      ({ sessionId } = await connection.call("Target.attachToTarget", { targetId, flatten: true }));
      const runtime = await this.#prepareRuntime(connection, workspace, targetId, sessionId);
      await connection.call("Page.navigate", { url: workspace.lastUrl }, sessionId);
      await this.#writeMarker(connection, runtime);
      runtime.ready = true;
      await this.#syncScreencast(runtime);
      return runtime;
    } catch (error) {
      this.#dropRuntime(workspace.id);
      await connection.call("Target.closeTarget", { targetId }).catch(() => {});
      throw error;
    } finally {
      this.pendingManagedTargets.delete(targetId);
    }
  }

  async ensureWorkspace(workspaceId) {
    const workspace = this.store.workspace(workspaceId);
    if (!workspace) throw new Error("工作区不存在");
    const connection = await this.#ensureConnection();
    return this.#ensureRuntime(workspace, connection);
  }

  async #focusMaintenanceTarget(connection) {
    const sessionId = this.auxiliarySessions.values().next().value;
    if (!sessionId) throw new Error("管理员浏览器窗口不存在");
    await connection.call("Page.bringToFront", {}, sessionId);
  }

  async focusMaintenance() {
    const connection = await this.#ensureConnection();
    await this.#focusMaintenanceTarget(connection);
  }

  async setMaintenanceActive(active) {
    this.maintenanceActive = !!active;
    if (this.maintenanceActive) await this.focusMaintenance();
  }

  async navigate(workspaceId, url) {
    const connection = await this.#ensureConnection();
    const runtime = await this.ensureWorkspace(workspaceId);
    await this.#applyProjectFocusToRuntime(connection, runtime, url);
    runtime.safeUrl = url;
    this.#markVisualActivity(runtime, ACTIVE_AFTER_INPUT_MS);
    await connection.call("Page.navigate", { url }, runtime.sessionId);
  }

  async removeWorkspace(workspaceId) {
    const runtime = this.runtimes.get(workspaceId);
    this.#dropRuntime(workspaceId);
    const viewers = this.viewers.get(workspaceId);
    if (viewers) {
      for (const socket of viewers) socket.close(1008, "工作区已删除");
      this.viewers.delete(workspaceId);
    }
    if (runtime && this.connection?.open) {
      await this.connection.call("Target.closeTarget", { targetId: runtime.targetId }).catch(() => {});
    }
  }

  async applyBrowserProfile({ reload = true } = {}) {
    const connection = await this.#ensureConnection();
    const { targetInfos = [] } = await connection.call("Target.getTargets");
    for (const target of targetInfos) {
      if (target.type === "page" && !this.#knownTarget(target.targetId)) {
        await this.#attachAuxiliaryTarget(connection, target.targetId).catch((error) => {
          this.logger.warn?.(`识别浏览器页面失败：${error.message}`);
        });
      }
    }

    const sessions = [
      ...[...this.runtimes.values()].map((runtime) => ({ targetId: runtime.targetId, sessionId: runtime.sessionId })),
      ...[...this.auxiliarySessions].map(([targetId, sessionId]) => ({ targetId, sessionId })),
    ];
    let appliedTargets = 0;
    const failedTargets = [];
    for (const target of sessions) {
      try {
        if (await this.#applyBrowserProfileToSession(connection, target.sessionId)) appliedTargets += 1;
        if (reload) await connection.call("Page.reload", { ignoreCache: false }, target.sessionId);
      } catch (error) {
        failedTargets.push(target.targetId);
        this.logger.warn?.(`应用浏览器环境失败：${error.message}`);
      }
    }
    return { appliedTargets, failedTargets: failedTargets.length };
  }

  async #applyManagedRule(label, apply) {
    const connection = await this.#ensureConnection();
    const runtimes = [...this.runtimes.values()];
    const results = await Promise.allSettled(runtimes.map((runtime) => apply(connection, runtime)));
    let appliedTargets = 0;
    let failedTargets = 0;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") appliedTargets += 1;
      else {
        failedTargets += 1;
        const runtime = runtimes[index];
        this.#dropRuntime(runtime.workspaceId);
        await connection.call("Target.closeTarget", { targetId: runtime.targetId }).catch(() => {});
        this.logger.warn?.(`应用${label}失败：${result.reason?.message || result.reason}`);
      }
    }
    return { appliedTargets, failedTargets };
  }

  async applySensitivePolicy() {
    return this.#applyManagedRule("敏感操作黑名单", (connection, runtime) =>
      this.#applySensitivePolicyToRuntime(connection, runtime),
    );
  }

  async applyProjectFocus() {
    return this.#applyManagedRule("编辑器功能白名单", (connection, runtime) => {
      const workspace = this.store.workspace(runtime.workspaceId);
      if (!workspace) throw new Error("工作区不存在");
      return this.#applyProjectFocusToRuntime(connection, runtime, workspace.startUrl);
    });
  }

  async verifyBrowserProfile() {
    const profile = this.store.browserProfile();
    if (!profile?.configured) throw new Error("浏览器环境尚未设置");
    const connection = await this.#ensureConnection();
    const { targetInfos = [] } = await connection.call("Target.getTargets");
    const untrackedPages = targetInfos.filter(
      (target) => target.type === "page" && !this.#knownTarget(target.targetId),
    ).length;
    const sessions = [
      ...[...this.runtimes.values()].map((runtime) => ({ name: runtime.workspaceId, sessionId: runtime.sessionId })),
      ...[...this.auxiliarySessions.values()].map((sessionId, index) => ({
        name: `maintenance-${index + 1}`,
        sessionId,
      })),
    ];
    const checks = Array.from({ length: untrackedPages }, (_, index) => ({
      name: `untracked-${index + 1}`,
      matches: false,
      error: "页面尚未被网关认领",
    }));
    for (const page of sessions) {
      try {
        const result = await connection.call(
          "Runtime.evaluate",
          {
            expression: `(() => ({
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              locale: Intl.DateTimeFormat().resolvedOptions().locale,
              language: navigator.language,
              languages: [...navigator.languages],
              clientHintsPreserved: !!navigator.userAgentData && (
                navigator.userAgentData.brands.length > 0 && !!navigator.userAgentData.platform
              ),
            }))()`,
            returnByValue: true,
          },
          page.sessionId,
        );
        const actual = result.result?.value;
        if (result.exceptionDetails || !actual) throw new Error("页面环境不可读");
        const matches =
          actual.timezone === profile.timezone &&
          actual.locale === profile.locale &&
          actual.language === profile.languages[0] &&
          JSON.stringify(actual.languages) === JSON.stringify(profile.languages) &&
          actual.clientHintsPreserved === true;
        checks.push({ name: page.name, ...actual, matches });
      } catch {
        checks.push({ name: page.name, matches: false, error: "页面环境不可读" });
      }
    }
    const matchingPages = checks.filter((check) => check.matches).length;
    return {
      expected: {
        timezone: profile.timezone,
        locale: profile.locale,
        languages: profile.languages,
        acceptLanguage: profile.acceptLanguage,
      },
      pages: checks.length,
      matchingPages,
      consistent: checks.length > 0 && matchingPages === checks.length,
      checks,
    };
  }

  async listChatGptProjects() {
    const connection = await this.#ensureConnection();
    let targetId;
    let sessionId;
    let requestId = "";
    let responseStatus = 0;
    let timeout;
    let clickTimer;
    let settled = false;
    let resolveResponse;
    let rejectResponse;
    const responseBody = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const onEvent = (message) => {
      if (!sessionId || message.sessionId !== sessionId) return;
      if (message.method === "Network.requestWillBeSent") {
        try {
          const url = new URL(message.params?.request?.url || "");
          if (url.origin === "https://chatgpt.com" && url.pathname === CHATGPT_PROJECTS_PATH) {
            requestId = message.params.requestId;
          }
        } catch {
          return;
        }
        return;
      }
      if (!requestId || message.params?.requestId !== requestId) return;
      if (message.method === "Network.responseReceived") {
        responseStatus = Number(message.params?.response?.status || 0);
        return;
      }
      if (message.method === "Network.loadingFailed") {
        settle(rejectResponse, new Error("Projects 列表请求失败"));
        return;
      }
      if (message.method !== "Network.loadingFinished") return;
      if (responseStatus !== 200) {
        const error = responseStatus === 401
          ? new Error("管理员浏览器尚未登录 ChatGPT")
          : new Error(`Projects 列表返回 HTTP ${responseStatus || "未知状态"}`);
        settle(rejectResponse, error);
        return;
      }
      connection.call("Network.getResponseBody", { requestId }, sessionId).then(
        ({ body = "", base64Encoded = false }) => {
          const text = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
          settle(resolveResponse, text);
        },
        (error) => settle(rejectResponse, error),
      );
    };

    try {
      ({ targetId } = await connection.call("Target.createTarget", { url: "about:blank", background: true }));
      this.ignoredTargets.add(targetId);
      ({ sessionId } = await connection.call("Target.attachToTarget", { targetId, flatten: true }));
      connection.on("event", onEvent);
      await connection.call("Page.enable", {}, sessionId);
      await connection.call("Runtime.enable", {}, sessionId);
      await connection.call("Network.enable", {}, sessionId);
      await connection.call("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
      timeout = setTimeout(
        () => settle(rejectResponse, new Error("未收到 Projects 列表，请确认管理员浏览器已登录 ChatGPT")),
        CDP_CALL_TIMEOUT_MS,
      );
      timeout.unref?.();
      await connection.call("Page.navigate", { url: "https://chatgpt.com/" }, sessionId);

      let clicking = false;
      const clickProjects = async () => {
        if (settled || clicking) return;
        clicking = true;
        try {
          const result = await connection.call(
            "Runtime.evaluate",
            {
              expression: `(() => {
                const names = new Set(["Projects", "项目"]);
                const button = [...document.querySelectorAll("button")].find(
                  (candidate) => !candidate.disabled && names.has((candidate.textContent || "").trim()),
                );
                if (!button) return false;
                button.click();
                return true;
              })()`,
              returnByValue: true,
            },
            sessionId,
          );
          if (result.result?.value === true && clickTimer) {
            clearInterval(clickTimer);
            clickTimer = null;
          }
        } catch {
          return;
        } finally {
          clicking = false;
        }
      };
      clickTimer = setInterval(clickProjects, 300);
      clickTimer.unref?.();
      await clickProjects();

      const text = await responseBody;
      if (Buffer.byteLength(text, "utf8") > CHATGPT_PROJECTS_MAX_BYTES) {
        throw new Error("Projects 列表响应过大");
      }
      return parseChatGptProjects(text);
    } catch (error) {
      throw new Error(`读取 ChatGPT Projects 失败：${error.message}`, { cause: error });
    } finally {
      if (timeout) clearTimeout(timeout);
      if (clickTimer) clearInterval(clickTimer);
      connection.off("event", onEvent);
      if (targetId && connection.open) await connection.call("Target.closeTarget", { targetId }).catch(() => {});
      if (targetId) {
        const timer = setTimeout(() => this.ignoredTargets.delete(targetId), 500);
        timer.unref?.();
      }
    }
  }

  async loadPublicJson(endpoint, { timeoutMs = 5000 } = {}) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") throw new Error("浏览器出口探测只允许 HTTPS");
    const connection = await this.#ensureConnection();
    const boundedTimeout = boundedInteger(timeoutMs, 1000, 15000, 5000);
    let targetId;
    let stage = "创建临时 Target";
    try {
      ({ targetId } = await connection.call("Target.createTarget", {
        url: "about:blank",
        background: true,
      }));
      this.ignoredTargets.add(targetId);
      stage = "附加临时 Target";
      const { sessionId } = await connection.call("Target.attachToTarget", { targetId, flatten: true });
      stage = "准备临时 Target";
      await connection.call("Runtime.enable", {}, sessionId);
      stage = "通过 Chromium 请求提供商";
      const result = await connection.call(
        "Runtime.evaluate",
        {
          expression: `(async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), ${boundedTimeout});
            try {
              const response = await fetch(${JSON.stringify(url.toString())}, {
                cache: "no-store",
                credentials: "omit",
                redirect: "error",
                signal: controller.signal,
              });
              return { ok: response.ok, status: response.status, text: (await response.text()).slice(0, 65537) };
            } finally {
              clearTimeout(timer);
            }
          })()`,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      );
      stage = "校验提供商响应";
      const value = result.result?.value;
      if (result.exceptionDetails || !value) throw new Error("浏览器无法访问出口 IP 信息服务");
      if (!value.ok) throw new Error(`出口 IP 信息服务返回 HTTP ${value.status}`);
      if (value.text.length > 64 * 1024) throw new Error("出口 IP 信息响应过大");
      try {
        return JSON.parse(value.text);
      } catch {
        throw new Error("出口 IP 信息不是有效 JSON");
      }
    } catch (error) {
      throw new Error(`出口探测在“${stage}”阶段失败：${error.message}`, { cause: error });
    } finally {
      if (targetId && connection.open) await connection.call("Target.closeTarget", { targetId }).catch(() => {});
      if (targetId) {
        const timer = setTimeout(() => this.ignoredTargets.delete(targetId), 500);
        timer.unref?.();
      }
    }
  }

  async addViewer(workspaceId, socket) {
    if (!this.store.workspace(workspaceId)) throw new Error("工作区不存在");
    if (!this.viewers.has(workspaceId)) this.viewers.set(workspaceId, new Set());
    this.viewers.get(workspaceId).add(socket);
    this.viewerStates.set(socket, { visible: true, focused: false });
    this.#sendJson(socket, { type: "status", state: this.connection?.open ? "connected" : "connecting" });
    try {
      const runtime = await this.ensureWorkspace(workspaceId);
      this.#sendJson(socket, { type: "viewport", ...runtime.viewport });
      if (runtime.lastFrame) this.#sendFrame(socket, runtime.lastFrame);
      await this.#syncScreencast(runtime);
      this.#scheduleScreencastProfileSync();
    } catch (error) {
      this.#sendJson(socket, { type: "status", state: "reconnecting", message: error.message });
    }
  }

  removeViewer(workspaceId, socket) {
    const viewers = this.viewers.get(workspaceId);
    if (!viewers) return;
    viewers.delete(socket);
    this.viewerStates.delete(socket);
    if (!viewers.size) this.viewers.delete(workspaceId);
    const runtime = this.runtimes.get(workspaceId);
    if (runtime?.fileChooser?.viewer === socket) {
      runtime.fileChooser = null;
      this.connection
        ?.call("Page.setInterceptFileChooserDialog", { enabled: true, cancel: true }, runtime.sessionId)
        .catch(() => {});
    }
    if (runtime?.fileChooserOwner?.viewer === socket) runtime.fileChooserOwner = null;
    if (runtime) this.#syncScreencast(runtime).catch(() => {});
    this.#scheduleScreencastProfileSync();
  }

  async setViewerState(workspaceId, socket, { visible = true, focused = false } = {}) {
    const viewers = this.viewers.get(workspaceId);
    if (!socket || !viewers?.has(socket)) throw new Error("画面连接不属于当前工作区");
    const state = { visible: !!visible, focused: !!visible && !!focused };
    this.viewerStates.set(socket, state);
    const runtime = this.runtimes.get(workspaceId);
    if (runtime) {
      if (state.visible) this.#markVisualActivity(runtime);
      await this.#syncScreencast(runtime);
    }
    this.#scheduleScreencastProfileSync();
    return state;
  }

  #sendJson(socket, payload) {
    if (socket.readyState !== OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  #broadcast(workspaceId, payload) {
    const viewers = this.viewers.get(workspaceId);
    if (!viewers) return;
    for (const socket of viewers) this.#sendJson(socket, payload);
  }

  #broadcastAll(payload) {
    for (const workspaceId of this.viewers.keys()) this.#broadcast(workspaceId, payload);
  }

  #workspaceIsActive(workspaceId) {
    const viewers = this.viewers.get(workspaceId);
    const focused = viewers && [...viewers].some((socket) => this.viewerStates.get(socket)?.focused);
    return !!focused || Number(this.runtimes.get(workspaceId)?.activeUntil || 0) > Date.now();
  }

  #visibleWorkspaceCount() {
    let count = 0;
    for (const viewers of this.viewers.values()) {
      if ([...viewers].some((socket) => this.viewerStates.get(socket)?.visible)) count += 1;
    }
    return count;
  }

  #streamTier(visibleWorkspaces) {
    const count = Math.max(1, visibleWorkspaces);
    return SCREENCAST_TIERS.find((tier) => count <= tier.maxVisible);
  }

  #markVisualActivity(runtime, duration = VISUAL_ACTIVITY_GRACE_MS) {
    runtime.visualActiveUntil = Math.max(runtime.visualActiveUntil, Date.now() + duration);
  }

  #scheduleScreencastProfileSync() {
    if (this.stopped || this.screencastProfileTimer) return;
    this.screencastProfileTimer = setTimeout(() => {
      this.screencastProfileTimer = null;
      for (const runtime of this.runtimes.values()) this.#syncScreencast(runtime).catch(() => {});
    }, SCREENCAST_PROFILE_SYNC_MS);
    this.screencastProfileTimer.unref?.();
  }

  #screencastRate(runtime) {
    const viewers = this.viewers.get(runtime.workspaceId);
    const visible = viewers && [...viewers].some((socket) => this.viewerStates.get(socket)?.visible);
    if (!visible) return { fps: 0 };
    const fps = this.#workspaceIsActive(runtime.workspaceId) ? this.activeFrameFps : this.frameFps;
    const tier = this.#streamTier(this.#visibleWorkspaceCount());
    return {
      fps,
      maxWidth: Math.min(runtime.viewport.width, tier.maxWidth),
      maxHeight: Math.min(runtime.viewport.height, tier.maxHeight),
      quality: Math.min(this.jpegQuality, tier.quality),
    };
  }

  async #setRuntimeViewport(connection, runtime, viewport) {
    if (!runtime.windowVisible) {
      await connection.call("Browser.setWindowBounds", {
        windowId: runtime.windowId,
        bounds: { windowState: "normal" },
      });
      runtime.windowVisible = true;
    }
    await connection.call(
      "Emulation.setDeviceMetricsOverride",
      { ...viewport, deviceScaleFactor: 1, mobile: false },
      runtime.sessionId,
    );
    await connection.call("Browser.setWindowBounds", {
      windowId: runtime.windowId,
      bounds: {
        width: viewport.width + runtime.windowInsets.width,
        height: viewport.height + runtime.windowInsets.height,
      },
    });
  }

  async #setWindowVisible(connection, runtime, visible) {
    if (runtime.windowId && runtime.windowVisible !== visible) {
      await connection.call("Browser.setWindowBounds", {
        windowId: runtime.windowId,
        bounds: { windowState: visible ? "normal" : "minimized" },
      });
      runtime.windowVisible = visible;
    }
    if (visible && this.maintenanceActive) await this.#focusMaintenanceTarget(connection);
  }

  #syncScreencast(runtime, { restart = false } = {}) {
    if (restart) runtime.screencastRestartRequested = true;
    runtime.screencastSync = runtime.screencastSync
      .catch(() => {})
      .then(async () => {
        const connection = this.connection;
        if (!connection?.open || this.runtimes.get(runtime.workspaceId) !== runtime || !runtime.ready) return;
        const rate = this.#screencastRate(runtime);
        const mustRestart = runtime.screencastRestartRequested;
        runtime.screencastRestartRequested = false;
        if (!rate.fps) {
          if (runtime.screencastRunning) {
            await connection.call("Page.stopScreencast", {}, runtime.sessionId);
            runtime.screencastRunning = false;
            runtime.screencastProfileKey = "";
          }
          await this.#setWindowVisible(connection, runtime, false);
          return;
        }
        await this.#setWindowVisible(connection, runtime, true);
        const profileKey = `${rate.maxWidth}x${rate.maxHeight}:${rate.quality}`;
        if (runtime.screencastRunning && runtime.screencastProfileKey === profileKey && !mustRestart) return;
        if (runtime.screencastRunning) await connection.call("Page.stopScreencast", {}, runtime.sessionId);
        await connection.call(
          "Page.startScreencast",
          {
            format: "jpeg",
            quality: rate.quality,
            maxWidth: rate.maxWidth,
            maxHeight: rate.maxHeight,
          },
          runtime.sessionId,
        );
        runtime.screencastRunning = true;
        this.#markVisualActivity(runtime);
        runtime.screencastProfileKey = profileKey;
        runtime.frameBudget = 1;
        runtime.frameBudgetAt = 0;
        this.captureMetrics.streamRestarts += 1;
      })
      .catch((error) => {
        runtime.screencastRunning = false;
        runtime.screencastProfileKey = "";
        this.#broadcast(runtime.workspaceId, { type: "status", state: "reconnecting", message: error.message });
        throw error;
      });
    return runtime.screencastSync;
  }

  #sendFrame(socket, frame) {
    if (socket.readyState !== OPEN || Number(socket.bufferedAmount || 0) > MAX_SOCKET_BUFFER_BYTES) {
      this.captureMetrics.droppedFrames += 1;
      return false;
    }
    try {
      socket.send(frame, { binary: true });
      return true;
    } catch {
      this.captureMetrics.droppedFrames += 1;
      return false;
    }
  }

  #handleScreencastFrame(connection, runtime, params = {}) {
    connection.send(
      "Page.screencastFrameAck",
      { sessionId: params.sessionId },
      runtime.sessionId,
    );
    if (!params.data) return;
    const now = Date.now();
    const rate = this.#screencastRate(runtime);
    if (!rate.fps) {
      this.captureMetrics.throttledFrames += 1;
      return;
    }
    if (now > runtime.visualActiveUntil && runtime.lastFrame) {
      this.captureMetrics.idleFrames += 1;
      return;
    }
    if (runtime.frameBudgetAt) {
      runtime.frameBudget += ((now - runtime.frameBudgetAt) * rate.fps) / 1000;
    }
    runtime.frameBudgetAt = now;
    if (runtime.frameBudget < 1) {
      this.captureMetrics.throttledFrames += 1;
      return;
    }
    runtime.frameBudget = Math.min(1, runtime.frameBudget - 1);
    const frame = Buffer.from(params.data, "base64");
    runtime.lastFrame = frame;
    runtime.lastFrameAt = now;
    runtime.lastFrameSentAt = now;
    this.captureMetrics.frames += 1;
    for (const socket of this.viewers.get(runtime.workspaceId) || []) this.#sendFrame(socket, frame);
  }

  #sendHeartbeatFrames() {
    const now = Date.now();
    for (const runtime of this.runtimes.values()) {
      if (!runtime.lastFrame || now - runtime.lastFrameSentAt < this.idleFrameMs) continue;
      let sent = 0;
      for (const socket of this.viewers.get(runtime.workspaceId) || []) {
        if (this.#sendFrame(socket, runtime.lastFrame)) sent += 1;
      }
      if (sent) {
        runtime.lastFrameSentAt = now;
        this.captureMetrics.heartbeatFrames += sent;
      }
    }
  }

  #scheduleActiveDowngrade(runtime) {
    if (runtime.activeTimer) clearTimeout(runtime.activeTimer);
    const delay = Math.max(0, runtime.activeUntil - Date.now()) + 20;
    runtime.activeTimer = setTimeout(() => {
      runtime.activeTimer = null;
      this.#syncScreencast(runtime).catch(() => {});
    }, delay);
    runtime.activeTimer.unref?.();
  }

  async handleCommand(workspaceId, command, actor = null, viewer = null) {
    if (!command || typeof command !== "object") throw new Error("无效输入消息");
    if (command.type === "viewerState") {
      return this.setViewerState(workspaceId, viewer, command);
    }
    const connection = await this.#ensureConnection();
    const runtime = await this.ensureWorkspace(workspaceId);
    const sessionId = runtime.sessionId;
    try {
      if (command.type === "selectFiles") {
        if (!this.transferStore || !actor?.id) throw new Error("当前部署没有启用文件上传");
        const chooser = runtime.fileChooser;
        if (!chooser) throw new Error("请先在 ChatGPT 页面点击上传文件");
        if (Date.now() - chooser.openedAt > FILE_CHOOSER_TTL_MS) {
          runtime.fileChooser = null;
          await connection.call("Page.setInterceptFileChooserDialog", { enabled: true, cancel: true }, sessionId);
          throw new Error("文件选择已过期，请在 ChatGPT 页面重新点击上传文件");
        }
        if (chooser.userId !== actor.id || chooser.viewer !== viewer) {
          throw new Error("该文件选择器不属于当前用户");
        }
        const uploads = this.transferStore.resolveUserUploads({
          userId: actor.id,
          ids: command.uploadIds,
        });
        await this.#selectUploadFiles(connection, runtime, uploads, chooser);
        return;
      }

      if (command.type === "cancelFileSelection") {
        if (runtime.fileChooser?.userId === actor?.id && runtime.fileChooser.viewer === viewer) {
          runtime.fileChooser = null;
          await connection.call("Page.setInterceptFileChooserDialog", { enabled: true, cancel: true }, sessionId);
        }
        return;
      }

      if (command.type === "selection") {
        if (!viewer || !this.viewers.get(workspaceId)?.has(viewer)) throw new Error("画面连接不属于当前工作区");
        this.#sendJson(viewer, { type: "selection", text: await this.#selectionText(connection, runtime) });
        return;
      }

      if (command.type === "cut") {
        if (!viewer || !this.viewers.get(workspaceId)?.has(viewer)) throw new Error("画面连接不属于当前工作区");
        await connection.call("Input.dispatchKeyEvent", { type: "rawKeyDown", commands: ["Cut"] }, sessionId);
        this.#sendJson(viewer, { type: "selection", text: await this.#selectionText(connection, runtime) });
        return;
      }

      if (command.type === "projectHome") {
        const workspace = this.store.workspace(workspaceId);
        if (!projectScopeFromUrl(workspace?.startUrl)) throw new Error("当前工作区未配置 ChatGPT 项目地址");
        await connection.call("Page.navigate", { url: workspace.startUrl }, sessionId);
        return;
      }

      if (command.type === "resize") {
        const viewport = {
          width: boundedInteger(command.width, MIN_VIEWPORT_WIDTH, 2560, runtime.viewport.width),
          height: boundedInteger(command.height, MIN_VIEWPORT_HEIGHT, 1600, runtime.viewport.height),
        };
        runtime.viewport = viewport;
        await this.#setRuntimeViewport(connection, runtime, viewport);
        this.#broadcast(workspaceId, { type: "viewport", ...viewport });
        await this.#syncScreencast(runtime, { restart: true });
        return;
      }

      if (command.type === "pointer") {
        const eventType = ["mouseMoved", "mousePressed", "mouseReleased"].includes(command.event)
          ? command.event
          : null;
        if (!eventType) throw new Error("无效指针事件");
        const button = ["none", "left", "middle", "right", "back", "forward"].includes(command.button)
          ? command.button
          : "none";
        const x = boundedInteger(command.x, 0, runtime.viewport.width, 0);
        const y = boundedInteger(command.y, 0, runtime.viewport.height, 0);
        if (eventType === "mousePressed") {
          const action = await this.#inputActionAt(connection, runtime, { x, y });
          if (this.#blockInputAction(workspaceId, runtime, action)) return;
          if (viewer) {
            this.#sendJson(viewer, {
              type: "input-target",
              sequence: boundedInteger(command.sequence, 0, 1_000_000_000, 0),
              editable: action.editable === true,
            });
          }
        }
        if (eventType === "mousePressed" && actor?.id && viewer) {
          runtime.fileChooserOwner = { userId: actor.id, viewer, createdAt: Date.now() };
        }
        const mouseParams = {
          type: eventType,
          x,
          y,
          button,
          buttons: boundedInteger(command.buttons, 0, 31, 0),
          clickCount: boundedInteger(command.clickCount, 0, 3, 0),
          modifiers: boundedInteger(command.modifiers, 0, 15, 0),
        };
        if (eventType === "mouseReleased" && button === "left") {
          const action = await this.#inputActionAt(connection, runtime, { x, y });
          if (this.#isChatGptCopyAction(action)) {
            await this.#queueRemoteClipboardCopy(connection, runtime, viewer, mouseParams);
            return;
          }
        }
        await connection.call("Input.dispatchMouseEvent", mouseParams, sessionId);
        return;
      }

      if (command.type === "wheel") {
        await connection.call(
          "Input.dispatchMouseEvent",
          {
            type: "mouseWheel",
            x: boundedInteger(command.x, 0, runtime.viewport.width, 0),
            y: boundedInteger(command.y, 0, runtime.viewport.height, 0),
            deltaX: boundedInteger(command.deltaX, -2000, 2000, 0),
            deltaY: boundedInteger(command.deltaY, -2000, 2000, 0),
            modifiers: boundedInteger(command.modifiers, 0, 15, 0),
          },
          sessionId,
        );
        return;
      }

      if (command.type === "key") {
        const eventType = ["keyDown", "keyUp", "rawKeyDown"].includes(command.event) ? command.event : null;
        if (!eventType) throw new Error("无效键盘事件");
        const key = String(command.key || "").slice(0, 64);
        const modifiers = boundedInteger(command.modifiers, 0, 15, 0);
        if (eventType !== "keyUp") {
          if (key === "," && (modifiers & 6) !== 0 && this.store.sensitivePolicy().enabled) {
            this.#broadcastPolicyBlock(workspaceId, "settings shortcut");
            return;
          }
          if (["Enter", " ", "Spacebar"].includes(key)) {
            const action = await this.#inputActionAt(connection, runtime, { active: true });
            if (this.#blockInputAction(workspaceId, runtime, action)) return;
          }
        }
        if (eventType !== "keyUp" && actor?.id && viewer) {
          runtime.fileChooserOwner = { userId: actor.id, viewer, createdAt: Date.now() };
        }
        await connection.call(
          "Input.dispatchKeyEvent",
          {
            type: eventType,
            key,
            code: String(command.code || "").slice(0, 64),
            text: String(command.text || "").slice(0, 16),
            unmodifiedText: String(command.text || "").slice(0, 16),
            windowsVirtualKeyCode: boundedInteger(command.keyCode, 0, 255, 0),
            nativeVirtualKeyCode: boundedInteger(command.keyCode, 0, 255, 0),
            modifiers,
            autoRepeat: !!command.autoRepeat,
            isKeypad: !!command.isKeypad,
          },
          sessionId,
        );
        return;
      }

      if (command.type === "text") {
        const text = String(command.text || "");
        if (!text || text.length > 10000) throw new Error("文本为空或过长");
        await connection.call("Input.insertText", { text }, sessionId);
        return;
      }

      if (command.type === "reload") {
        await connection.call("Page.reload", { ignoreCache: false }, sessionId);
        return;
      }

      throw new Error("不支持的输入消息");
    } finally {
      this.#markVisualActivity(runtime, ACTIVE_AFTER_INPUT_MS);
      runtime.activeUntil = Date.now() + ACTIVE_AFTER_INPUT_MS;
      this.#scheduleActiveDowngrade(runtime);
      await this.#syncScreencast(runtime);
    }
  }
}
