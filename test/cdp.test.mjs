import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { CdpConnection, WorkspaceBroker } from "../lib/cdp.mjs";
import { manualBrowserProfile } from "../lib/profile.mjs";
import { createStateStore } from "../lib/store.mjs";

class FakeConnection extends EventEmitter {
  constructor(prefix) {
    super();
    this.prefix = prefix;
    this.open = true;
    this.calls = [];
    this.counter = 0;
    this.contextCounter = 0;
    this.windowCounter = 0;
    this.windowIds = new Map();
  }

  async call(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (method === "Target.getTargets") return { targetInfos: [] };
    if (method === "Target.createTarget") {
      const targetId = `${this.prefix}-target-${++this.counter}`;
      this.windowIds.set(targetId, ++this.windowCounter);
      return { targetId };
    }
    if (method === "Target.attachToTarget") return { sessionId: `${this.prefix}-session-${params.targetId}` };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: `${this.prefix}-frame` } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: ++this.contextCounter };
    if (method === "Browser.getWindowForTarget") {
      if (!this.windowIds.has(params.targetId)) this.windowIds.set(params.targetId, ++this.windowCounter);
      return { windowId: this.windowIds.get(params.targetId) };
    }
    if (method === "Runtime.evaluate") {
      if (params.expression.includes("navigator.userAgentData")) {
        return {
          result: {
            value: {
              userAgent: "Mozilla/5.0 Test Chromium",
              platform: "Linux x86_64",
              metadata: {
                brands: [{ brand: "Chromium", version: "149" }],
                fullVersionList: [{ brand: "Chromium", version: "149.0.0.0" }],
                platform: "Linux",
                platformVersion: "",
                architecture: "x86",
                model: "",
                mobile: false,
                bitness: "64",
                wow64: false,
                formFactors: ["Desktop"],
              },
            },
          },
        };
      }
      if (params.expression.includes("outerWidth")) {
        return {
          result: {
            value: { outerWidth: 1448, outerHeight: 992, innerWidth: 1440, innerHeight: 900 },
          },
        };
      }
      if (params.expression.includes("inspectSensitiveAction")) {
        return {
          result: {
            value: {
              description: "",
              tagName: "",
              ariaLabel: "",
              testId: "",
              href: "",
              editable: this.editableInput === true,
            },
          },
        };
      }
      if (params.expression.includes("globalThis.getSelection")) {
        return { result: { value: "远端选区" } };
      }
      if (params.expression.includes("navigator.clipboard.writeText")) {
        return { result: { value: true } };
      }
      return { result: { value: params.expression.includes("sessionStorage.setItem") ? true : "" } };
    }
    return {};
  }

  send(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId, fireAndForget: true });
    return this.open;
  }

  terminate() {
    if (!this.open) return;
    this.open = false;
    this.emit("disconnect", new Error("terminated"));
  }
}

test("无响应的 CDP 命令会超时而不是永久卡住初始化", async () => {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.send = (_payload, callback) => callback();
  let terminations = 0;
  socket.terminate = () => {
    terminations += 1;
    socket.readyState = 3;
    socket.emit("close");
  };
  const connection = new CdpConnection(socket, { callTimeoutMs: 100 });
  await assert.rejects(() => connection.call("Runtime.evaluate"), /CDP 命令超时：Runtime\.evaluate/);
  assert.equal(connection.pending.size, 0);
  assert.equal(connection.open, false);
  assert.equal(terminations, 1);
});

test("Chromium 持续离线时只记录一次连接告警", async () => {
  let attempts = 0;
  const warnings = [];
  const broker = new WorkspaceBroker({
    store: { workspaces: () => [] },
    connect: async () => {
      attempts += 1;
      throw new Error("offline");
    },
    logger: { warn: (message) => warnings.push(message), error() {} },
  });
  broker.start();
  await new Promise((resolveWait) => setTimeout(resolveWait, 650));
  broker.stop();
  assert.ok(attempts >= 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CDP 尚未就绪/);
});

class DiscoveryConnection extends FakeConnection {
  constructor(markers, localeFailures = 0) {
    super("discovery");
    this.markers = markers;
    this.localeFailures = localeFailures;
    this.nativeProbeListings = 1;
    this.createdTargets = 0;
  }

  async call(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (method === "Target.setDiscoverTargets") {
      for (const targetId of ["maintenance", ...this.markers.keys()]) {
        this.emit("event", { method: "Target.targetCreated", params: { targetInfo: { targetId, type: "page" } } });
      }
      return {};
    }
    if (method === "Target.getTargets") {
      const nativeProbe = this.nativeProbeListings-- > 0
        ? [{ targetId: "native-probe", type: "page", url: "chrome://newtab/" }]
        : [];
      return {
        targetInfos: [
          ...nativeProbe,
          { targetId: "maintenance", type: "page", url: "https://chatgpt.com/" },
          ...[...this.markers.keys()].map((targetId) => ({ targetId, type: "page", url: "https://chatgpt.com/" })),
        ],
      };
    }
    if (method === "Target.createTarget") {
      this.createdTargets += 1;
      return { targetId: this.createdTargets === 1 ? "native-probe" : `recreated-${this.createdTargets - 1}` };
    }
    if (method === "Target.closeTarget") {
      this.markers.delete(params.targetId);
      return { success: true };
    }
    if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
    if (method === "Browser.getWindowForTarget") {
      if (!this.windowIds.has(params.targetId)) this.windowIds.set(params.targetId, ++this.windowCounter);
      return { windowId: this.windowIds.get(params.targetId) };
    }
    if (method === "Emulation.setLocaleOverride" && this.localeFailures > 0) {
      this.localeFailures -= 1;
      throw new Error("-32000: Another locale override is already in effect");
    }
    if (method === "Runtime.evaluate" && params.expression.includes("sessionStorage.getItem")) {
      return {
        result: {
          value: this.markers.get(sessionId.replace("session-", "")) || "",
        },
      };
    }
    if (method === "Runtime.evaluate" && params.expression.includes("navigator.userAgentData")) {
      return {
        result: {
          value: {
            userAgent: "Mozilla/5.0 Test Chromium",
            platform: "Linux x86_64",
            metadata: { brands: [{ brand: "Chromium", version: "149" }], platform: "Linux", mobile: false },
          },
        },
      };
    }
    if (method === "Runtime.evaluate" && params.expression.includes("sessionStorage.setItem")) {
      return { result: { value: true } };
    }
    if (method === "Runtime.evaluate" && params.expression.includes("outerWidth")) {
      return {
        result: {
          value: { outerWidth: 1448, outerHeight: 992, innerWidth: 1440, innerHeight: 900 },
        },
      };
    }
    return {};
  }
}

class PublicJsonConnection extends FakeConnection {
  constructor() {
    super("public-json");
  }

  async call(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (method === "Target.createBrowserContext") return { browserContextId: "temporary-context" };
    if (method === "Target.createTarget") return { targetId: "temporary-target" };
    if (method === "Target.attachToTarget") return { sessionId: "temporary-session" };
    if (method === "Runtime.evaluate") {
      if (params.expression.includes("navigator.userAgentData")) {
        return {
          result: {
            value: {
              userAgent: "Mozilla/5.0 Test Chromium",
              platform: "Linux x86_64",
              metadata: { brands: [{ brand: "Chromium", version: "149" }], platform: "Linux", mobile: false },
            },
          },
        };
      }
      return {
        result: {
          value: {
            ok: true,
            status: 200,
            text: JSON.stringify({ success: true, country_code: "US", timezone: { id: "America/Los_Angeles" } }),
          },
        },
      };
    }
    return {};
  }
}

class ProjectsConnection extends FakeConnection {
  constructor(cursor = null) {
    super("projects");
    this.cursor = cursor;
    this.closedTargets = [];
  }

  async call(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (method === "Target.getTargets") return { targetInfos: [] };
    if (method === "Target.createTarget") return { targetId: `projects-target-${++this.counter}` };
    if (method === "Target.attachToTarget") return { sessionId: `projects-session-${params.targetId}` };
    if (method === "Target.closeTarget") {
      this.closedTargets.push(params.targetId);
      return { success: true };
    }
    if (method === "Runtime.evaluate" && params.expression.includes("navigator.userAgentData")) {
      return {
        result: {
          value: {
            userAgent: "Mozilla/5.0 Test Chromium",
            platform: "Linux x86_64",
            metadata: { brands: [{ brand: "Chromium", version: "149" }], platform: "Linux", mobile: false },
          },
        },
      };
    }
    if (method === "Page.navigate" && params.url === "https://chatgpt.com/") {
      queueMicrotask(() => {
        const requestId = "projects-request";
        const url = "https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?owned_only=true&limit=20";
        this.emit("event", {
          method: "Network.requestWillBeSent",
          sessionId,
          params: { requestId, request: { url } },
        });
        this.emit("event", {
          method: "Network.responseReceived",
          sessionId,
          params: { requestId, response: { status: 200 } },
        });
        this.emit("event", { method: "Network.loadingFinished", sessionId, params: { requestId } });
      });
      return {};
    }
    if (method === "Network.getResponseBody") {
      return {
        body: JSON.stringify({
          cursor: this.cursor,
          items: [
            {
              gizmo: {
                gizmo: {
                  id: "g-p-alpha001",
                  display: { name: "Alpha Project" },
                  is_archived: false,
                },
              },
            },
            {
              gizmo: {
                gizmo: {
                  id: "g-p-archived001",
                  display: { name: "Archived Project" },
                  is_archived: true,
                },
              },
            },
          ],
        }),
        base64Encoded: false,
      };
    }
    return {};
  }
}

test("Projects 从已登录临时 Target 的授权响应读取且拒绝部分列表", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-projects-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  const connection = new ProjectsConnection();
  const broker = new WorkspaceBroker({
    store,
    connect: async () => connection,
    logger: { warn() {}, error() {} },
  });
  try {
    assert.deepEqual(await broker.listChatGptProjects(), [
      {
        id: "g-p-alpha001",
        name: "Alpha Project",
        startUrl: "https://chatgpt.com/g/g-p-alpha001/project",
      },
    ]);
    assert.ok(connection.calls.some((call) => call.method === "Network.getResponseBody"));
    assert.equal(
      connection.calls.some(
        (call) => call.method === "Runtime.evaluate" && call.params.expression.includes("fetch("),
      ),
      false,
    );
    assert.ok(connection.closedTargets.includes("projects-target-2"));
  } finally {
    broker.stop();
  }

  const pagedConnection = new ProjectsConnection("next-page");
  const pagedBroker = new WorkspaceBroker({
    store,
    connect: async () => pagedConnection,
    logger: { warn() {}, error() {} },
  });
  try {
    await assert.rejects(() => pagedBroker.listChatGptProjects(), /拒绝部分导入/);
  } finally {
    pagedBroker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("任意数量工作区映射到独立 Target 与 sessionId", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  const workspaces = Array.from({ length: 5 }, (_, index) =>
    store.createWorkspace({
      id: `workspace-${index + 1}`,
      name: `Workspace ${index + 1}`,
      startUrl: `https://chatgpt.com/g/project-${index + 1}`,
    }),
  );
  const connections = [new FakeConnection("first"), new FakeConnection("second")];
  let connectionIndex = 0;
  const broker = new WorkspaceBroker({
    store,
    connect: async () => connections[connectionIndex++],
    logger: { warn() {}, error() {} },
  });
  try {
    await broker.ensureWorkspace(workspaces[0].id);
    assert.equal(broker.status().targets, 5);
    const createCalls = connections[0].calls.filter((call) => call.method === "Target.createTarget");
    assert.equal(createCalls.length, 6);

    await broker.handleCommand(workspaces[0].id, { type: "text", text: "FIRST_ONLY" });
    await broker.handleCommand(workspaces[4].id, { type: "text", text: "FIFTH_ONLY" });
    const inputs = connections[0].calls.filter((call) => call.method === "Input.insertText");
    assert.equal(inputs.length, 2);
    assert.notEqual(inputs[0].sessionId, inputs[1].sessionId);
    assert.equal(inputs[0].params.text, "FIRST_ONLY");
    assert.equal(inputs[1].params.text, "FIFTH_ONLY");

    connections[0].open = false;
    connections[0].emit("disconnect", new Error("browser restarted"));
    await broker.ensureWorkspace(workspaces[0].id);
    assert.equal(broker.status().targets, 5);
    assert.equal(connections[1].calls.filter((call) => call.method === "Target.createTarget").length, 6);
  } finally {
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("输入坐标和文本长度在服务端校验", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-input-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  store.createWorkspace({ id: "only", name: "Only", startUrl: "https://chatgpt.com/" });
  const connection = new FakeConnection("input");
  connection.editableInput = true;
  const broker = new WorkspaceBroker({ store, connect: async () => connection, logger: { warn() {}, error() {} } });
  const viewer = {
    readyState: 1,
    bufferedAmount: 0,
    messages: [],
    send(payload, options = {}) {
      if (!options.binary) this.messages.push(JSON.parse(payload));
    },
    close() {
      this.readyState = 3;
    },
  };
  try {
    await broker.addViewer("only", viewer);
    await broker.handleCommand("only", { type: "resize", width: 390, height: 844 });
    assert.ok(
      connection.calls.some(
        (call) => call.method === "Browser.setWindowBounds" && call.params.bounds.windowState === "normal",
      ),
    );
    const metrics = connection.calls.filter((call) => call.method === "Emulation.setDeviceMetricsOverride").at(-1);
    assert.deepEqual(metrics.params, { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    const bounds = connection.calls.filter(
      (call) => call.method === "Browser.setWindowBounds" && Number.isInteger(call.params.bounds.width),
    ).at(-1);
    assert.deepEqual(bounds.params.bounds, { width: 398, height: 936 });
    await broker.handleCommand(
      "only",
      {
        type: "pointer",
        event: "mousePressed",
        x: 99999,
        y: -5,
        button: "left",
        buttons: 1,
        sequence: 17,
      },
      null,
      viewer,
    );
    const pointer = connection.calls.find((call) => call.method === "Input.dispatchMouseEvent");
    assert.equal(pointer.params.x, 390);
    assert.equal(pointer.params.y, 0);
    assert.deepEqual(viewer.messages.find((message) => message.type === "input-target"), {
      type: "input-target",
      sequence: 17,
      editable: true,
    });
    await assert.rejects(() => broker.handleCommand("only", { type: "text", text: "x".repeat(10001) }), /过长/);
  } finally {
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ChatGPT 原生网页通知只转发到所属工作区", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-notification-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  store.createWorkspace({ id: "office", name: "Office", startUrl: "https://chatgpt.com/g/office" });
  store.createWorkspace({ id: "lab", name: "Lab", startUrl: "https://chatgpt.com/g/lab" });
  const connection = new FakeConnection("notification");
  const broker = new WorkspaceBroker({ store, connect: async () => connection, logger: { warn() {}, error() {} } });
  const createViewer = () => ({
    readyState: 1,
    bufferedAmount: 0,
    messages: [],
    send(payload, options = {}) {
      if (!options.binary) this.messages.push(JSON.parse(payload));
    },
    close() {
      this.readyState = 3;
    },
  });
  const officeViewer = createViewer();
  const labViewer = createViewer();
  try {
    await broker.addViewer("office", officeViewer);
    await broker.addViewer("lab", labViewer);
    const notificationScripts = connection.calls.filter(
      (call) =>
        call.method === "Page.addScriptToEvaluateOnNewDocument" &&
        call.params.source.includes("__gpcNotificationRelayInstalled"),
    );
    assert.equal(notificationScripts.length, 2);
    assert.ok(notificationScripts.every((call) => call.params.runImmediately === true));
    assert.ok(notificationScripts.every((call) => !("worldName" in call.params)));
    assert.equal(
      connection.calls.filter(
        (call) => call.method === "Runtime.addBinding" && call.params.name === "__gpcNotification",
      ).length,
      2,
    );

    const relayed = [];
    class NativeNotification {
      static permission = "granted";
      constructor(title, options) {
        this.title = title;
        this.body = options.body;
      }
    }
    const context = { Notification: NativeNotification, __gpcNotification: (payload) => relayed.push(JSON.parse(payload)) };
    runInNewContext(notificationScripts[0].params.source, context);
    const native = new context.Notification("研究已完成", { body: "结果可以查看" });
    assert.ok(native instanceof NativeNotification);
    assert.deepEqual(relayed, [{ title: "研究已完成", body: "结果可以查看" }]);

    const officeSession = connection.calls.find(
      (call) => call.method === "Page.navigate" && call.params.url === "https://chatgpt.com/g/office",
    ).sessionId;
    connection.emit("event", {
      method: "Runtime.bindingCalled",
      sessionId: officeSession,
      params: {
        name: "__gpcNotification",
        payload: JSON.stringify({ title: "回答已完成", body: "请返回工作区查看" }),
      },
    });
    assert.deepEqual(
      officeViewer.messages.filter((message) => message.type === "notification"),
      [{ type: "notification", title: "回答已完成", body: "请返回工作区查看" }],
    );
    assert.equal(labViewer.messages.some((message) => message.type === "notification"), false);

    connection.emit("event", {
      method: "Runtime.bindingCalled",
      sessionId: officeSession,
      params: { name: "__gpcNotification", payload: "invalid" },
    });
    assert.equal(officeViewer.messages.filter((message) => message.type === "notification").length, 1);
  } finally {
    broker.removeViewer("office", officeViewer);
    broker.removeViewer("lab", labViewer);
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("选区只返回当前窗口并以 Chromium 编辑命令执行剪切", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-clipboard-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  store.createWorkspace({ id: "only", name: "Only", startUrl: "https://chatgpt.com/" });
  const connection = new FakeConnection("clipboard");
  const broker = new WorkspaceBroker({ store, connect: async () => connection, logger: { warn() {}, error() {} } });
  const createViewer = () => ({
    readyState: 1,
    bufferedAmount: 0,
    messages: [],
    send(payload, options = {}) {
      if (!options.binary) this.messages.push(JSON.parse(payload));
    },
    close() {
      this.readyState = 3;
    },
  });
  const viewer = createViewer();
  const otherViewer = createViewer();
  try {
    await broker.addViewer("only", viewer);
    await broker.addViewer("only", otherViewer);
    await broker.handleCommand("only", { type: "selection" }, null, viewer);
    await broker.handleCommand("only", { type: "cut" }, null, viewer);

    assert.equal(viewer.messages.filter((message) => message.type === "selection").length, 2);
    assert.equal(otherViewer.messages.some((message) => message.type === "selection"), false);
    assert.equal(viewer.messages.at(-1).text, "远端选区");
    assert.ok(
      connection.calls.some(
        (call) => call.method === "Input.dispatchKeyEvent" && call.params.type === "rawKeyDown" && call.params.commands[0] === "Cut",
      ),
    );
  } finally {
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

class NativePasteConnection extends FakeConnection {
  constructor() {
    super("native-paste");
    this.activeWrites = 0;
    this.maxActiveWrites = 0;
  }

  async call(method, params = {}, sessionId) {
    if (method === "Runtime.evaluate" && params.expression.includes("navigator.clipboard.writeText")) {
      this.calls.push({ method, params, sessionId });
      this.activeWrites += 1;
      this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.activeWrites -= 1;
      return { result: { value: true } };
    }
    return super.call(method, params, sessionId);
  }
}

test("多窗口本机粘贴经远端原生粘贴事务全局顺序提交", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-native-paste-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  for (const id of ["left", "right"]) {
    store.createWorkspace({ id, name: id, startUrl: "https://chatgpt.com/" });
  }
  const connection = new NativePasteConnection();
  const broker = new WorkspaceBroker({ store, connect: async () => connection, logger: { warn() {}, error() {} } });
  const text = "段落\n".repeat(1000);
  try {
    await Promise.all([
      broker.handleCommand("left", { type: "text", text, paste: true }),
      broker.handleCommand("right", { type: "text", text, paste: true }),
    ]);
    assert.equal(connection.maxActiveWrites, 1);
    assert.equal(connection.calls.filter((call) => call.method === "Input.insertText").length, 0);
    const writes = connection.calls.filter(
      (call) => call.method === "Runtime.evaluate" && call.params.expression.includes("navigator.clipboard.writeText"),
    );
    assert.equal(writes.length, 2);
    assert.ok(writes.every((call) => Number.isInteger(call.params.contextId)));
    const paste = connection.calls.filter(
      (call) => call.method === "Input.dispatchKeyEvent" && call.params.commands?.[0] === "Paste",
    );
    assert.equal(paste.length, 2);
  } finally {
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("同一新工作区的并发连接只创建一个 Target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-concurrent-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  store.createWorkspace({ id: "base", name: "Base", startUrl: "https://chatgpt.com/" });
  const connection = new FakeConnection("concurrent");
  const broker = new WorkspaceBroker({ store, connect: async () => connection, logger: { warn() {}, error() {} } });
  try {
    await broker.ensureWorkspace("base");
    store.createWorkspace({ id: "new-space", name: "New", startUrl: "https://chatgpt.com/" });
    const [first, second] = await Promise.all([
      broker.ensureWorkspace("new-space"),
      broker.ensureWorkspace("new-space"),
    ]);
    assert.equal(first.targetId, second.targetId);
    assert.equal(connection.calls.filter((call) => call.method === "Target.createTarget").length, 3);
  } finally {
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("出口探测复用 CDP 连接并在临时 about:blank Target 中去凭据请求", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-public-json-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  const connection = new PublicJsonConnection();
  const broker = new WorkspaceBroker({ store, connect: async () => connection, logger: { warn() {}, error() {} } });
  try {
    const data = await broker.loadPublicJson("https://geo.example.test/json", { timeoutMs: 2500 });
    assert.equal(data.country_code, "US");
    assert.equal(data.timezone.id, "America/Los_Angeles");
    assert.equal(connection.calls.filter((call) => call.method === "Target.createBrowserContext").length, 0);
    assert.equal(connection.calls.filter((call) => call.method === "Target.createTarget").length, 2);
    assert.equal(connection.calls.filter((call) => call.method === "Target.closeTarget").length, 2);
    assert.match(
      connection.calls.find(
        (call) => call.method === "Runtime.evaluate" && call.params.expression.includes("credentials: \"omit\""),
      ).params.expression,
      /credentials: "omit"/,
    );
    assert.equal(connection.open, true);
    await assert.rejects(() => broker.loadPublicJson("http://geo.example.test/json"), /HTTPS/);
  } finally {
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("所有 Target 共享时区、locale、语言头且保留原生 User-Agent Client Hints", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-profile-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  for (let index = 1; index <= 4; index += 1) {
    store.createWorkspace({ id: `workspace-${index}`, name: `Workspace ${index}`, startUrl: "https://chatgpt.com/" });
  }
  store.setBrowserProfile(manualBrowserProfile({ timezone: "America/Los_Angeles", locale: "zh-CN" }));
  const connection = new FakeConnection("profile");
  const broker = new WorkspaceBroker({ store, connect: async () => connection, logger: { warn() {}, error() {} } });
  try {
    await broker.ensureWorkspace("workspace-1");
    const timezoneCalls = connection.calls.filter((call) => call.method === "Emulation.setTimezoneOverride");
    const localeCalls = connection.calls.filter((call) => call.method === "Emulation.setLocaleOverride");
    const userAgentCalls = connection.calls.filter((call) => call.method === "Emulation.setUserAgentOverride");
    assert.equal(timezoneCalls.length, 4);
    assert.equal(new Set(timezoneCalls.map((call) => call.sessionId)).size, 4);
    assert.ok(timezoneCalls.every((call) => call.params.timezoneId === "America/Los_Angeles"));
    assert.ok(localeCalls.every((call) => call.params.locale === "zh_CN"));
    assert.ok(userAgentCalls.every((call) => call.params.acceptLanguage === "zh-CN,zh,en"));
    assert.ok(userAgentCalls.every((call) => call.params.userAgentMetadata.platform === "Linux"));
    assert.equal(connection.calls.some((call) => call.method === "Network.setExtraHTTPHeaders"), false);
  } finally {
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("网关重启后通过每窗口 sessionStorage 认领 Target 而不重复开窗", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-discovery-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  const markers = new Map();
  for (let index = 1; index <= 4; index += 1) {
    const id = `workspace-${index}`;
    store.createWorkspace({ id, name: id, startUrl: "https://chatgpt.com/" });
    markers.set(`target-${index}`, id);
  }
  markers.set("target-1-duplicate", "workspace-1");
  store.setBrowserProfile(manualBrowserProfile({ timezone: "America/Los_Angeles", locale: "en-US" }));
  const connection = new DiscoveryConnection(markers, 3);
  const broker = new WorkspaceBroker({ store, connect: async () => connection, logger: { warn() {}, error() {} } });
  try {
    await broker.ensureWorkspace("workspace-1");
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    assert.equal(broker.status().targets, 4);
    assert.equal(connection.calls.filter((call) => call.method === "Target.createTarget").length, 1);
    assert.equal(connection.calls.filter((call) => call.method === "Target.attachToTarget").length, 7);
    assert.equal(connection.calls.filter((call) => call.method === "Target.closeTarget").length, 2);
    assert.equal(connection.calls.filter((call) => call.method === "Target.detachFromTarget").length, 0);
    store.setBrowserProfile(manualBrowserProfile({ timezone: "Europe/Paris", locale: "fr-FR" }));
    const applied = await broker.applyBrowserProfile({ reload: false });
    assert.deepEqual(applied, { appliedTargets: 5, failedTargets: 0 });
    assert.equal(connection.calls.filter((call) => call.method === "Emulation.setTimezoneOverride").length, 10);
  } finally {
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("管理员浏览器置前且普通窗口恢复时不再覆盖", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-maintenance-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  store.createWorkspace({ id: "office", name: "Office", startUrl: "https://chatgpt.com/" });
  const markers = new Map([["office-target", "office"]]);
  const connection = new DiscoveryConnection(markers);
  const broker = new WorkspaceBroker({ store, connect: async () => connection, logger: { warn() {}, error() {} } });
  const viewer = { readyState: 1, bufferedAmount: 0, send() {}, close() {} };
  try {
    await broker.ensureWorkspace("office");
    await broker.setMaintenanceActive(true);
    assert.equal(broker.status().maintenanceActive, true);
    await broker.addViewer("office", viewer);
    const focusCalls = connection.calls.filter((call) => call.method === "Page.bringToFront");
    assert.ok(focusCalls.length >= 2);
    assert.ok(focusCalls.every((call) => call.sessionId === "session-maintenance"));
    connection.emit("event", {
      method: "Target.targetCreated",
      params: { targetInfo: { targetId: "ordinary-popup", type: "page", openerId: "office-target" } },
    });
    await new Promise((resolveWait) => setImmediate(resolveWait));
    assert.ok(connection.calls.some((call) => call.method === "Target.closeTarget" && call.params.targetId === "ordinary-popup"));
    markers.set("copied-workspace", "office");
    connection.emit("event", {
      method: "Target.targetCreated",
      params: { targetInfo: { targetId: "copied-workspace", type: "page" } },
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 220));
    assert.ok(
      connection.calls.some(
        (call) => call.method === "Target.closeTarget" && call.params.targetId === "copied-workspace",
      ),
    );
    await broker.setMaintenanceActive(false);
    assert.equal(broker.status().maintenanceActive, false);
  } finally {
    broker.removeViewer("office", viewer);
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

class FailingPolicyDiscoveryConnection extends DiscoveryConnection {
  constructor(markers) {
    super(markers);
    this.failedManagedPolicy = false;
  }

  async call(method, params = {}, sessionId) {
    if (
      !this.failedManagedPolicy &&
      method === "Page.addScriptToEvaluateOnNewDocument" &&
      sessionId === "session-target-old" &&
      params.source.includes("__gpcSensitiveGuard")
    ) {
      this.failedManagedPolicy = true;
      this.calls.push({ method, params, sessionId });
      throw new Error("模拟黑名单安装失败");
    }
    return super.call(method, params, sessionId);
  }
}

test("已认领 Target 黑名单安装失败时关闭并重建而不是标记就绪", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-policy-fail-closed-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  store.createWorkspace({ id: "secure", name: "Secure", startUrl: "https://chatgpt.com/" });
  const connection = new FailingPolicyDiscoveryConnection(new Map([["target-old", "secure"]]));
  const broker = new WorkspaceBroker({ store, connect: async () => connection, logger: { warn() {}, error() {} } });
  try {
    const runtime = await broker.ensureWorkspace("secure");
    assert.equal(runtime.targetId, "recreated-1");
    assert.equal(broker.status().targets, 1);
    assert.ok(
      connection.calls.some(
        (call) => call.method === "Target.closeTarget" && call.params.targetId === "target-old",
      ),
    );
    assert.ok(
      connection.calls.some(
        (call) =>
          call.method === "Page.addScriptToEvaluateOnNewDocument" &&
          call.sessionId === "session-recreated-1" &&
          call.params.source.includes("__gpcSensitiveGuard"),
      ),
    );
  } finally {
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

class PolicyUpdateFailureConnection extends FakeConnection {
  constructor(prefix) {
    super(prefix);
    this.policyInstalls = 0;
  }

  async call(method, params = {}, sessionId) {
    if (method === "Page.addScriptToEvaluateOnNewDocument" && params.source.includes("__gpcSensitiveGuard")) {
      this.policyInstalls += 1;
      if (this.policyInstalls === 2) {
        this.calls.push({ method, params, sessionId });
        throw new Error("模拟策略更新失败");
      }
    }
    return super.call(method, params, sessionId);
  }
}

test("在线 Target 更新黑名单失败时立即关闭而不继续提供旧策略页面", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-policy-update-fail-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  store.createWorkspace({ id: "secure", name: "Secure", startUrl: "https://chatgpt.com/" });
  const connection = new PolicyUpdateFailureConnection("policy-update");
  const broker = new WorkspaceBroker({ store, connect: async () => connection, logger: { warn() {}, error() {} } });
  try {
    await broker.ensureWorkspace("secure");
    assert.equal(broker.status().targets, 1);
    assert.deepEqual(await broker.applySensitivePolicy(), { appliedTargets: 0, failedTargets: 1 });
    assert.equal(broker.status().targets, 0);
    assert.ok(
      connection.calls.some(
        (call) => call.method === "Target.closeTarget" && call.params.targetId === "policy-update-target-2",
      ),
    );
  } finally {
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

class PolicyConnection extends FakeConnection {
  async call(method, params = {}, sessionId) {
    if (method === "Runtime.evaluate" && params.expression.includes("inspectSensitiveAction")) {
      this.calls.push({ method, params, sessionId });
      return {
        result: {
          value: {
            description: "Open profile menu Settings",
            tagName: "button",
            ariaLabel: "Open profile menu",
            testId: "",
            href: "",
          },
        },
      };
    }
    return super.call(method, params, sessionId);
  }
}

test("普通工作区在输入前拦截敏感控件并在禁用策略后恢复输入", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-policy-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  store.createWorkspace({ id: "only", name: "Only", startUrl: "https://chatgpt.com/" });
  const connection = new PolicyConnection("policy");
  const broker = new WorkspaceBroker({ store, connect: async () => connection, logger: { warn() {}, error() {} } });
  try {
    await broker.handleCommand("only", {
      type: "pointer",
      event: "mousePressed",
      x: 20,
      y: 30,
      button: "left",
      buttons: 1,
    });
    assert.equal(connection.calls.filter((call) => call.method === "Input.dispatchMouseEvent").length, 0);
    assert.ok(
      connection.calls.some(
        (call) =>
          call.method === "Network.setBlockedURLs" &&
          call.params.urlPatterns.every((pattern) => pattern.block === true && pattern.urlPattern),
      ),
    );
    assert.ok(
      connection.calls.some(
        (call) =>
          call.method === "Page.addScriptToEvaluateOnNewDocument" &&
          call.params.worldName === "gpc-sensitive-guard" &&
          call.params.runImmediately === true,
      ),
    );

    store.setSensitivePolicy({ enabled: false });
    assert.deepEqual(await broker.applySensitivePolicy(), { appliedTargets: 1, failedTargets: 0 });
    await broker.handleCommand("only", {
      type: "pointer",
      event: "mousePressed",
      x: 20,
      y: 30,
      button: "left",
      buttons: 1,
    });
    assert.equal(connection.calls.filter((call) => call.method === "Input.dispatchMouseEvent").length, 1);
  } finally {
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("管理员修改编辑器功能白名单后立即更新在线普通 Target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-composer-tools-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  store.createWorkspace({ id: "only", name: "Only", startUrl: "https://chatgpt.com/" });
  const connection = new FakeConnection("composer-tools");
  const broker = new WorkspaceBroker({ store, connect: async () => connection, logger: { warn() {}, error() {} } });
  try {
    await broker.ensureWorkspace("only");
    const initial = connection.calls.find(
      (call) => call.method === "Page.addScriptToEvaluateOnNewDocument" && call.params.worldName === "gpc-project-focus",
    );
    assert.match(initial.params.source, /add photos & files/);
    store.setComposerToolAllowlist(["GitHub"]);
    assert.deepEqual(await broker.applyProjectFocus(), { appliedTargets: 1, failedTargets: 0 });
    const installs = connection.calls.filter(
      (call) => call.method === "Page.addScriptToEvaluateOnNewDocument" && call.params.worldName === "gpc-project-focus",
    );
    assert.equal(installs.length, 2);
    assert.match(installs[1].params.source, /github/);
    assert.doesNotMatch(installs[1].params.source, /Add photos & files/);
  } finally {
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

class ProjectInputConnection extends FakeConnection {
  constructor() {
    super("project-focus");
    this.action = { description: "", tagName: "", ariaLabel: "", testId: "", href: "" };
    this.failDownloadConversion = false;
  }

  async call(method, params = {}, sessionId) {
    if (
      this.failDownloadConversion &&
      method === "Runtime.evaluate" &&
      params.expression.includes('document.createElement("a")')
    ) {
      this.calls.push({ method, params, sessionId });
      throw new Error("download conversion failed");
    }
    if (method === "Runtime.evaluate" && params.expression.includes("inspectSensitiveAction")) {
      this.calls.push({ method, params, sessionId });
      return { result: { value: this.action } };
    }
    return super.call(method, params, sessionId);
  }
}

class RemoteClipboardConnection extends ProjectInputConnection {
  constructor() {
    super();
    this.permissionOperations = 0;
    this.maxPermissionOperations = 0;
    this.clipboardText = "";
  }

  async call(method, params = {}, sessionId) {
    if (method === "Browser.setPermission") {
      this.calls.push({ method, params, sessionId });
      this.permissionOperations += params.setting === "granted" ? 1 : -1;
      this.maxPermissionOperations = Math.max(this.maxPermissionOperations, this.permissionOperations);
      return {};
    }
    if (method === "Runtime.evaluate" && params.expression.includes('navigator.permissions.query({ name: "clipboard-read" })')) {
      this.calls.push({ method, params, sessionId });
      return { result: { value: "prompt" } };
    }
    if (method === "Runtime.evaluate" && params.expression.includes("globalThis.__gpcClipboardChange = new Promise")) {
      this.calls.push({ method, params, sessionId });
      return { result: { value: true } };
    }
    if (method === "Runtime.evaluate" && params.expression.includes("globalThis.__gpcClipboardChange")) {
      this.calls.push({ method, params, sessionId });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { result: { value: { ok: true, text: this.clipboardText } } };
    }
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
      this.calls.push({ method, params, sessionId });
      this.clipboardText = `clipboard:${sessionId}`;
      return {};
    }
    return super.call(method, params, sessionId);
  }
}

test("十二窗口短间隔原生复制按远端系统剪贴板全局顺序定向返回", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-remote-clipboard-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  const workspaceIds = Array.from({ length: 12 }, (_, index) => `copy-${index + 1}`);
  for (const id of workspaceIds) {
    store.createWorkspace({ id, name: id, startUrl: "https://chatgpt.com/" });
  }
  const connection = new RemoteClipboardConnection();
  connection.action = {
    description: "Copy response",
    tagName: "button",
    ariaLabel: "Copy response",
    testId: "copy-turn-action-button",
    href: "",
  };
  const broker = new WorkspaceBroker({ store, connect: async () => connection, logger: { warn() {}, error() {} } });
  const viewers = workspaceIds.map(() => ({
    readyState: 1,
    bufferedAmount: 0,
    messages: [],
    send(payload, options = {}) {
      if (!options.binary) this.messages.push(JSON.parse(payload));
    },
    close() {
      this.readyState = 3;
    },
  }));
  try {
    for (let index = 0; index < workspaceIds.length; index += 1) {
      await broker.addViewer(workspaceIds[index], viewers[index]);
    }
    await Promise.all(
      workspaceIds.map((id, index) =>
        broker.handleCommand(
          id,
          { type: "pointer", event: "mouseReleased", x: 20, y: 30, button: "left", buttons: 0, clickCount: 1 },
          null,
          viewers[index],
        ),
      ),
    );

    assert.equal(connection.maxPermissionOperations, 1);
    assert.equal(connection.permissionOperations, 0);
    const isolatedWorlds = connection.calls.filter((call) => call.method === "Page.createIsolatedWorld");
    assert.equal(isolatedWorlds.length, 12);
    assert.ok(
      isolatedWorlds.every(
        (call) => call.params.frameId === "project-focus-frame" && call.params.worldName === "gpc-clipboard",
      ),
    );
    const clipboardEvaluations = connection.calls.filter(
      (call) => call.method === "Runtime.evaluate" && call.params.expression.includes("__gpcClipboardChange"),
    );
    assert.equal(clipboardEvaluations.length, 24);
    assert.ok(clipboardEvaluations.every((call) => Number.isInteger(call.params.contextId)));
    for (let index = 0; index < viewers.length; index += 1) {
      const clipboard = viewers[index].messages.filter((message) => message.type === "clipboard");
      assert.deepEqual(clipboard, [{ type: "clipboard", text: `clipboard:project-focus-session-project-focus-target-${index + 2}` }]);
    }
  } finally {
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("普通工作区把明确下载动作转换为所属工作区的 Chromium 下载", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-download-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  store.createWorkspace({ id: "project", name: "Project", startUrl: "https://chatgpt.com/g/project" });
  const connection = new ProjectInputConnection();
  const broker = new WorkspaceBroker({ store, connect: async () => connection, logger: { warn() {}, error() {} } });
  const viewer = {
    readyState: 1,
    bufferedAmount: 0,
    messages: [],
    send(payload, options = {}) {
      if (!options.binary) this.messages.push(JSON.parse(payload));
    },
    close() {
      this.readyState = 3;
    },
  };
  try {
    await broker.addViewer("project", viewer);
    const runtime = await broker.ensureWorkspace("project");
    connection.action = {
      description: "Download",
      tagName: "button",
      ariaLabel: "Download",
      testId: "",
      href: "",
      download: true,
      downloadName: "实验结果.png",
    };
    await broker.handleCommand("project", {
      type: "pointer",
      event: "mousePressed",
      x: 20,
      y: 30,
      button: "left",
      buttons: 1,
    });
    const downloadUrl = "https://chatgpt.com/backend-api/estuary/content?id=file-test&sig=test";
    connection.emit("event", {
      method: "Page.frameScheduledNavigation",
      sessionId: runtime.sessionId,
      params: { frameId: runtime.mainFrameId, url: downloadUrl },
    });
    await new Promise((resolveWait) => setImmediate(resolveWait));
    assert.ok(
      connection.calls.some(
        (call) => call.method === "Page.stopLoading" && call.sessionId === runtime.sessionId,
      ),
    );
    const conversion = connection.calls.find(
      (call) => call.method === "Runtime.evaluate" && call.params.expression.includes('document.createElement("a")'),
    );
    assert.equal(conversion.sessionId, runtime.sessionId);
    assert.equal(conversion.params.userGesture, true);
    assert.match(conversion.params.expression, /实验结果\.png/);
    assert.match(conversion.params.expression, /backend-api\/estuary\/content/);

    const stopsBeforeExternal = connection.calls.filter((call) => call.method === "Page.stopLoading").length;
    await broker.handleCommand("project", {
      type: "pointer",
      event: "mousePressed",
      x: 20,
      y: 30,
      button: "left",
      buttons: 1,
    });
    connection.emit("event", {
      method: "Page.frameScheduledNavigation",
      sessionId: runtime.sessionId,
      params: { frameId: runtime.mainFrameId, url: "https://example.com/private.bin" },
    });
    await new Promise((resolveWait) => setImmediate(resolveWait));
    assert.equal(
      connection.calls.filter((call) => call.method === "Page.stopLoading").length,
      stopsBeforeExternal,
    );

    connection.failDownloadConversion = true;
    await broker.handleCommand("project", {
      type: "pointer",
      event: "mousePressed",
      x: 20,
      y: 30,
      button: "left",
      buttons: 1,
    });
    connection.emit("event", {
      method: "Page.frameScheduledNavigation",
      sessionId: runtime.sessionId,
      params: { frameId: runtime.mainFrameId, url: downloadUrl },
    });
    await new Promise((resolveWait) => setImmediate(resolveWait));
    assert.deepEqual(
      viewer.messages.filter((message) => message.type === "download").at(-1),
      {
        type: "download",
        file: { name: "实验结果.png", state: "failed", error: "无法启动下载" },
      },
    );
  } finally {
    broker.removeViewer("project", viewer);
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Chromium 下载只在开始和结束时刷新普通页面文件状态", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-download-events-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  store.createWorkspace({ id: "office", name: "Office", startUrl: "https://chatgpt.com/" });
  const transferStore = {
    downloadRoot: "/transfer/downloads",
    beginDownload({ id, workspaceId, name }) {
      return { id, workspaceId, name, kind: "download", state: "in_progress" };
    },
    updateDownload({ id, state }) {
      return {
        entry: {
          id,
          workspaceId: "office",
          name: "report.pdf",
          kind: "download",
          state: state === "completed" ? "ready" : "in_progress",
        },
        cancel: false,
        retry: false,
        terminal: state === "completed",
      };
    },
  };
  const connection = new FakeConnection("download-events");
  const broker = new WorkspaceBroker({
    store,
    transferStore,
    connect: async () => connection,
    logger: { warn() {}, error() {} },
  });
  const viewer = {
    readyState: 1,
    bufferedAmount: 0,
    messages: [],
    send(payload, options = {}) {
      if (!options.binary) this.messages.push(JSON.parse(payload));
    },
    close() {
      this.readyState = 3;
    },
  };
  try {
    await broker.addViewer("office", viewer);
    const runtime = broker.runtimes.get("office");
    runtime.downloadRequest = { name: "report.pdf" };
    connection.emit("event", {
      method: "Browser.downloadWillBegin",
      params: { guid: "download-guid-1", frameId: runtime.mainFrameId, suggestedFilename: "report.pdf" },
    });
    assert.equal(runtime.downloadRequest, null);
    connection.emit("event", {
      method: "Browser.downloadProgress",
      params: { guid: "download-guid-1", state: "inProgress", receivedBytes: 10, totalBytes: 100 },
    });
    assert.equal(viewer.messages.filter((message) => message.type === "download").length, 1);
    connection.emit("event", {
      method: "Browser.downloadProgress",
      params: { guid: "download-guid-1", state: "completed", receivedBytes: 100, totalBytes: 100 },
    });
    assert.equal(viewer.messages.filter((message) => message.type === "download").length, 2);
    assert.equal(viewer.messages.filter((message) => message.type === "download").at(-1).file.state, "ready");
  } finally {
    broker.removeViewer("office", viewer);
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("项目导航和分享在输入发送前由网关拒绝且可返回项目首页", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-project-focus-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  store.createWorkspace({
    id: "project",
    name: "Project",
    startUrl: "https://chatgpt.com/g/g-p-project123/project",
  });
  store.createWorkspace({ id: "general", name: "General", startUrl: "https://chatgpt.com/" });
  const connection = new ProjectInputConnection();
  const broker = new WorkspaceBroker({ store, connect: async () => connection, logger: { warn() {}, error() {} } });
  try {
    const runtime = await broker.ensureWorkspace("project");
    const generalRuntime = broker.runtimes.get("general");
    const conversationUrl = "https://chatgpt.com/g/g-p-chatroute456/c/conversation-1";
    assert.equal(connection.calls.some((call) => call.method.startsWith("Fetch.")), false);
    const inputCountBeforeExternal = connection.calls.filter((call) => call.method === "Input.dispatchMouseEvent").length;
    connection.action = {
      description: "External link",
      tagName: "a",
      ariaLabel: "External link",
      testId: "",
      href: "https://example.com/",
    };
    await broker.handleCommand("general", {
      type: "pointer",
      event: "mousePressed",
      x: 20,
      y: 30,
      button: "left",
      buttons: 1,
    });
    assert.equal(
      connection.calls.filter((call) => call.method === "Input.dispatchMouseEvent").length,
      inputCountBeforeExternal,
    );
    connection.emit("event", {
      method: "Page.navigatedWithinDocument",
      sessionId: generalRuntime.sessionId,
      params: { frameId: generalRuntime.mainFrameId, url: "https://example.com/" },
    });
    await new Promise((resolveWait) => setImmediate(resolveWait));
    assert.ok(
      connection.calls.some(
        (call) =>
          call.method === "Page.navigate" &&
          call.sessionId === generalRuntime.sessionId &&
          call.params.url === "https://chatgpt.com/",
      ),
    );
    connection.action = { description: "Project chat", tagName: "a", ariaLabel: "", testId: "", href: conversationUrl };
    await broker.handleCommand("project", {
      type: "pointer",
      event: "mousePressed",
      x: 20,
      y: 30,
      button: "left",
      buttons: 1,
    });
    assert.equal(connection.calls.filter((call) => call.method === "Input.dispatchMouseEvent").length, 1);

    const navigationsBeforeConversation = connection.calls.filter((call) => call.method === "Page.navigate").length;
    connection.emit("event", {
      method: "Page.navigatedWithinDocument",
      sessionId: runtime.sessionId,
      params: { frameId: runtime.mainFrameId, url: conversationUrl },
    });
    await new Promise((resolveWait) => setImmediate(resolveWait));
    assert.equal(store.workspace("project").lastUrl, conversationUrl);
    assert.equal(
      connection.calls.filter((call) => call.method === "Page.navigate").length,
      navigationsBeforeConversation,
    );

    connection.action = {
      description: "Open project",
      tagName: "a",
      ariaLabel: "Open project",
      testId: "",
      href: "https://chatgpt.com/g/g-p-project123/project",
    };
    await broker.handleCommand("project", {
      type: "pointer",
      event: "mousePressed",
      x: 20,
      y: 30,
      button: "left",
      buttons: 1,
    });
    connection.action = {
      description: "Settings",
      tagName: "a",
      ariaLabel: "Settings",
      testId: "",
      href: "https://chatgpt.com/settings",
    };
    await broker.handleCommand("project", {
      type: "pointer",
      event: "mousePressed",
      x: 20,
      y: 30,
      button: "left",
      buttons: 1,
    });
    connection.action = {
      description: "Share",
      tagName: "button",
      ariaLabel: "Share",
      testId: "share-chat-button",
      href: "",
    };
    await broker.handleCommand("project", {
      type: "pointer",
      event: "mousePressed",
      x: 20,
      y: 30,
      button: "left",
      buttons: 1,
    });
    assert.equal(connection.calls.filter((call) => call.method === "Input.dispatchMouseEvent").length, 1);

    connection.action = {
      description: "Cloudflare",
      tagName: "div",
      role: "menuitemradio",
      surface: "composer-tool",
      controlName: "Cloudflare",
    };
    await broker.handleCommand("project", {
      type: "pointer",
      event: "mousePressed",
      x: 20,
      y: 30,
      button: "left",
      buttons: 1,
    });
    assert.equal(connection.calls.filter((call) => call.method === "Input.dispatchMouseEvent").length, 1);

    connection.action = {
      description: "Web search",
      tagName: "div",
      role: "menuitemradio",
      surface: "composer-tool",
      controlName: "Web search",
    };
    await broker.handleCommand("project", {
      type: "pointer",
      event: "mousePressed",
      x: 20,
      y: 30,
      button: "left",
      buttons: 1,
    });
    assert.equal(connection.calls.filter((call) => call.method === "Input.dispatchMouseEvent").length, 2);

    connection.action = {
      description: "Google Drive",
      tagName: "button",
      role: "",
      surface: "add-source",
      controlName: "Google Drive",
    };
    await broker.handleCommand("project", {
      type: "pointer",
      event: "mousePressed",
      x: 20,
      y: 30,
      button: "left",
      buttons: 1,
    });
    assert.equal(connection.calls.filter((call) => call.method === "Input.dispatchMouseEvent").length, 2);

    connection.emit("event", {
      method: "Page.navigatedWithinDocument",
      sessionId: runtime.sessionId,
      params: {
        frameId: runtime.mainFrameId,
        url: "https://chatgpt.com/g/g-p-chatroute456/c/conversation-2",
      },
    });
    await new Promise((resolveWait) => setImmediate(resolveWait));
    assert.ok(
      connection.calls.some(
        (call) =>
          call.method === "Page.navigate" &&
          call.sessionId === runtime.sessionId &&
          call.params.url === conversationUrl,
      ),
    );
    await broker.handleCommand("project", { type: "projectHome" });
    assert.ok(
      connection.calls.some(
        (call) =>
          call.method === "Page.navigate" &&
          call.sessionId === runtime.sessionId &&
          call.params.url === "https://chatgpt.com/g/g-p-project123/project",
      ),
    );
  } finally {
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("只有页面手动打开文件选择后才能选择用户私人文件", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-upload-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  store.createWorkspace({ id: "office", name: "Office", startUrl: "https://chatgpt.com/" });
  const connection = new FakeConnection("upload");
  const transferStore = {
    resolveUserUploads({ userId, ids }) {
      assert.equal(userId, "user-1");
      assert.deepEqual(ids, ["upload-12345678"]);
      return [{ id: ids[0], name: "data.txt", size: 4, path: "/transfer/uploads/user-1/private/data.txt" }];
    },
  };
  const broker = new WorkspaceBroker({
    store,
    transferStore,
    connect: async () => connection,
    logger: { warn() {}, error() {} },
  });
  try {
    const viewer = {
      readyState: 1,
      bufferedAmount: 0,
      messages: [],
      send(payload, options = {}) {
        if (!options.binary) this.messages.push(JSON.parse(payload));
      },
      close() {
        this.readyState = 3;
      },
    };
    const otherViewer = {
      readyState: 1,
      bufferedAmount: 0,
      messages: [],
      send(payload, options = {}) {
        if (!options.binary) this.messages.push(JSON.parse(payload));
      },
      close() {
        this.readyState = 3;
      },
    };
    await broker.addViewer("office", viewer);
    await broker.addViewer("office", otherViewer);
    const command = { type: "selectFiles", uploadIds: ["upload-12345678"] };
    const actor = { id: "user-1", role: "member" };
    await assert.rejects(
      () => broker.handleCommand("office", command, actor, viewer),
      /请先在 ChatGPT 页面点击上传文件/,
    );
    const runtime = broker.runtimes.get("office");
    runtime.fileChooser = { backendNodeId: 1, openedAt: Date.now(), userId: actor.id, viewer };
    connection.emit("event", {
      method: "Page.fileChooserOpened",
      sessionId: runtime.sessionId,
      params: { backendNodeId: 90209, mode: "selectSingle" },
    });
    assert.equal(runtime.fileChooser, null);
    assert.ok(
      connection.calls.some(
        (call) => call.method === "Page.setInterceptFileChooserDialog" && call.params.cancel === true,
      ),
    );
    await broker.handleCommand(
      "office",
      { type: "pointer", event: "mousePressed", x: 20, y: 30, button: "left" },
      actor,
      viewer,
    );
    connection.emit("event", {
      method: "Page.fileChooserOpened",
      sessionId: runtime.sessionId,
      params: { backendNodeId: 90210, mode: "selectSingle" },
    });
    assert.equal(viewer.messages.some((message) => message.type === "file-chooser"), true);
    assert.equal(otherViewer.messages.some((message) => message.type === "file-chooser"), false);
    await assert.rejects(
      () => broker.handleCommand("office", command, actor, otherViewer),
      /不属于当前用户/,
    );
    await broker.handleCommand("office", command, actor, viewer);
    const injected = connection.calls.find((call) => call.method === "DOM.setFileInputFiles");
    assert.deepEqual(injected.params.files, ["/transfer/uploads/user-1/private/data.txt"]);
    assert.equal(injected.params.backendNodeId, 90210);
    assert.match(injected.sessionId, /^upload-session-upload-target-/);
    assert.equal(connection.calls.some((call) => call.params?.expression?.includes("input[type='file']")), false);

    await broker.handleCommand(
      "office",
      { type: "pointer", event: "mousePressed", x: 20, y: 30, button: "left" },
      actor,
      viewer,
    );
    connection.emit("event", {
      method: "Page.fileChooserOpened",
      sessionId: runtime.sessionId,
      params: { backendNodeId: 90211, mode: "selectMultiple" },
    });
    await broker.handleCommand("office", { type: "cancelFileSelection" }, actor, viewer);
    assert.ok(
      connection.calls.some(
        (call) => call.method === "Page.setInterceptFileChooserDialog" && call.params.cancel === true,
      ),
    );
    await broker.handleCommand(
      "office",
      { type: "pointer", event: "mousePressed", x: 20, y: 30, button: "left" },
      actor,
      viewer,
    );
    connection.emit("event", {
      method: "Page.fileChooserOpened",
      sessionId: runtime.sessionId,
      params: { backendNodeId: 90212, mode: "selectSingle" },
    });
    runtime.fileChooser.openedAt = Date.now() - 3 * 60 * 1000;
    await assert.rejects(
      () => broker.handleCommand("office", command, actor, viewer),
      /文件选择已过期/,
    );
  } finally {
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

class ScreencastConnection extends FakeConnection {
  constructor(prefix) {
    super(prefix);
    this.frameId = 0;
  }

  emitFrame(sessionId, text = `frame-${sessionId}`) {
    this.emit("event", {
      method: "Page.screencastFrame",
      sessionId,
      params: { data: Buffer.from(text).toString("base64"), sessionId: ++this.frameId, metadata: {} },
    });
  }
}

class FakeViewer {
  constructor(bufferedAmount = 0) {
    this.readyState = 1;
    this.bufferedAmount = bufferedAmount;
    this.frames = 0;
  }

  send(_payload, options = {}) {
    if (options.binary) this.frames += 1;
  }

  close() {
    this.readyState = 3;
  }
}

test("十二个独立窗口并行推流且慢客户端不累积帧", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-screencast-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  for (let index = 1; index <= 12; index += 1) {
    store.createWorkspace({ id: `workspace-${index}`, name: `Workspace ${index}`, startUrl: "https://chatgpt.com/" });
  }
  const connection = new ScreencastConnection("screencast");
  const broker = new WorkspaceBroker({
    store,
    activeFrameFps: 10,
    connect: async () => connection,
    logger: { warn() {}, error() {} },
  });
  const viewers = Array.from({ length: 12 }, () => new FakeViewer());
  const slow = new FakeViewer(3 * 1024 * 1024);
  try {
    await Promise.all(viewers.map((viewer, index) => broker.addViewer(`workspace-${index + 1}`, viewer)));
    await broker.addViewer("workspace-1", slow);
    const starts = connection.calls.filter((call) => call.method === "Page.startScreencast");
    assert.equal(starts.length, 12);
    assert.equal(new Set(starts.map((call) => call.sessionId)).size, 12);
    assert.ok(starts.every((call) => !("everyNthFrame" in call.params)));
    assert.ok(starts.every((call) => call.params.maxWidth === 800 && call.params.maxHeight === 500));
    assert.ok(starts.every((call) => call.params.quality === 60));
    starts.forEach((call) => connection.emitFrame(call.sessionId));
    await new Promise((resolveWait) => setImmediate(resolveWait));
    assert.equal(connection.calls.some((call) => call.method === "Target.activateTarget"), false);
    const createdWindows = connection.calls.filter(
      (call) => call.method === "Target.createTarget" && call.params.url === "about:blank",
    );
    assert.ok(createdWindows.every((call) => call.params.newWindow === true && call.params.focus === false));
    assert.ok(viewers.every((viewer) => viewer.frames > 0));
    assert.equal(slow.frames, 0);
    assert.equal(broker.status().captureMode, "target-screencast");
    assert.equal(broker.status().streamTier, "congested");
    assert.equal(broker.status().capturing, 12);
    assert.ok(broker.status().droppedFrames > 0);
    assert.equal(connection.calls.filter((call) => call.method === "Page.screencastFrameAck").length, 12);
  } finally {
    viewers.forEach((viewer, index) => broker.removeViewer(`workspace-${index + 1}`, viewer));
    broker.removeViewer("workspace-1", slow);
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("可见窗口持续使用 60 FPS 连续流且隐藏后停止", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-active-screencast-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  store.createWorkspace({ id: "active", name: "Active", startUrl: "https://chatgpt.com/" });
  const connection = new ScreencastConnection("active-screencast");
  const broker = new WorkspaceBroker({
    store,
    activeFrameFps: 60,
    connect: async () => connection,
    logger: { warn() {}, error() {} },
  });
  const viewer = new FakeViewer();
  try {
    await broker.addViewer("active", viewer);
    const initialStarts = connection.calls.filter((call) => call.method === "Page.startScreencast").length;
    await broker.handleCommand("active", { type: "viewerState", visible: true }, null, viewer);
    const activeStart = connection.calls.filter((call) => call.method === "Page.startScreencast").at(-1);
    assert.equal(connection.calls.filter((call) => call.method === "Page.startScreencast").length, initialStarts);
    assert.equal("everyNthFrame" in activeStart.params, false);
    assert.equal(activeStart.params.maxWidth, 1440);
    assert.equal(activeStart.params.maxHeight, 900);
    assert.equal(activeStart.params.quality, 72);
    connection.emitFrame(activeStart.sessionId);
    assert.equal(viewer.frames, 1);
    await new Promise((resolveWait) => setTimeout(resolveWait, 2200));
    connection.emitFrame(activeStart.sessionId, "compositor-only-change");
    assert.equal(viewer.frames, 2);
    assert.equal("idleFrames" in broker.status(), false);
    assert.equal("heartbeatFrames" in broker.status(), false);
    assert.equal(broker.status().visibleViewers, 1);
    assert.equal(broker.status().activeFrameFps, 60);
    assert.equal(broker.status().streamTier, "full");
    await broker.handleCommand("active", { type: "viewerState", visible: false }, null, viewer);
    assert.equal(broker.status().visibleViewers, 0);
    assert.equal(broker.status().capturing, 0);
    assert.equal(connection.calls.filter((call) => call.method === "Browser.setWindowBounds").at(-1).params.bounds.windowState, "minimized");
    await broker.handleCommand("active", { type: "viewerState", visible: true }, null, viewer);
    assert.equal(broker.status().visibleViewers, 1);
    const resumedStart = connection.calls.filter((call) => call.method === "Page.startScreencast").at(-1);
    assert.equal("everyNthFrame" in resumedStart.params, false);
  } finally {
    broker.removeViewer("active", viewer);
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("可见工作区帧预算按真实经过时间限速", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-cdp-frame-budget-"));
  const store = createStateStore({ file: join(directory, "state.json") });
  store.createWorkspace({ id: "background", name: "Background", startUrl: "https://chatgpt.com/" });
  const connection = new ScreencastConnection("frame-budget");
  const broker = new WorkspaceBroker({
    store,
    activeFrameFps: 8,
    connect: async () => connection,
    logger: { warn() {}, error() {} },
  });
  const viewer = new FakeViewer();
  try {
    await broker.addViewer("background", viewer);
    const sessionId = connection.calls.filter((call) => call.method === "Page.startScreencast").at(-1).sessionId;
    connection.emitFrame(sessionId, "initial");
    for (let index = 0; index < 10; index += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      connection.emitFrame(sessionId, `frame-${index}`);
    }
    assert.ok(viewer.frames >= 8 && viewer.frames <= 10);
    assert.ok(broker.status().throttledFrames >= 1);
  } finally {
    broker.removeViewer("background", viewer);
    broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
