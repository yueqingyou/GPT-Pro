import { EventEmitter } from "node:events";
import { chmod, chown, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { dirname } from "node:path";

const MAX_MESSAGE_BYTES = 64 * 1024;
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKSPACE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function readMessage(socket) {
  return new Promise((resolve, reject) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
      if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) {
        reject(new Error("Portal IPC 消息过大"));
        socket.destroy();
        return;
      }
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      socket.pause();
      try {
        resolve(JSON.parse(text.slice(0, newline)));
      } catch {
        reject(new Error("Portal IPC 消息不是有效 JSON"));
      }
    });
    socket.once("error", reject);
    socket.once("end", () => {
      if (!text.includes("\n")) reject(new Error("Portal IPC 连接提前关闭"));
    });
  });
}

function connect(path) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

export class FilePortalBridge extends EventEmitter {
  constructor({ gatewaySocket, desktopSocket, ownerUid = 1000, ownerGid = 1000 } = {}) {
    super();
    if (!gatewaySocket || !desktopSocket) throw new Error("FilePortalBridge 缺少 IPC 路径");
    this.gatewaySocket = gatewaySocket;
    this.desktopSocket = desktopSocket;
    this.ownerUid = ownerUid;
    this.ownerGid = ownerGid;
    this.server = null;
    this.pending = new Map();
  }

  async start() {
    if (this.server) return;
    const directory = dirname(this.gatewaySocket);
    await mkdir(directory, { recursive: true });
    await chown(directory, this.ownerUid, this.ownerGid);
    await chmod(directory, 0o770);
    await rm(this.gatewaySocket, { force: true });
    const server = net.createServer((socket) => this.#accept(socket));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.gatewaySocket, resolve);
    });
    await chown(this.gatewaySocket, this.ownerUid, this.ownerGid);
    await chmod(this.gatewaySocket, 0o660);
    this.server = server;
  }

  async stop() {
    for (const requestId of [...this.pending.keys()]) this.cancel(requestId);
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(this.gatewaySocket, { force: true });
  }

  #accept(socket) {
    readMessage(socket)
      .then((message) => {
        if (
          message?.type !== "open" ||
          !REQUEST_ID_RE.test(String(message.requestId || "")) ||
          !WORKSPACE_ID_RE.test(String(message.workspaceId || ""))
        ) {
          throw new Error("Portal 打开请求无效");
        }
        const request = {
          requestId: message.requestId,
          workspaceId: message.workspaceId,
          multiple: message.multiple === true,
          directory: message.directory === true,
        };
        if (this.pending.has(request.requestId)) throw new Error("Portal 请求标识重复");
        this.pending.set(request.requestId, socket);
        let completed = false;
        const closed = () => {
          if (completed || this.pending.get(request.requestId) !== socket) return;
          completed = true;
          this.pending.delete(request.requestId);
          this.emit("closed", request);
        };
        socket.once("close", closed);
        socket.resume();
        this.emit("open", request);
      })
      .catch(() => socket.destroy());
  }

  #respond(requestId, payload) {
    const socket = this.pending.get(requestId);
    if (!socket) return false;
    this.pending.delete(requestId);
    socket.end(`${JSON.stringify(payload)}\n`);
    return true;
  }

  select(requestId, paths) {
    if (!Array.isArray(paths) || !paths.length || !paths.every((path) => typeof path === "string" && path)) {
      throw new Error("Portal 选择结果无效");
    }
    return this.#respond(requestId, { status: "selected", paths });
  }

  cancel(requestId) {
    return this.#respond(requestId, { status: "cancelled" });
  }

  async #control(message) {
    const socket = await connect(this.desktopSocket);
    try {
      const responsePromise = readMessage(socket);
      socket.end(`${JSON.stringify(message)}\n`);
      const response = await responsePromise;
      if (response?.ok !== true) throw new Error(String(response?.error || "桌面窗口标记失败"));
      return response;
    } finally {
      socket.destroy();
    }
  }

  tagWorkspace({ title, workspaceId }) {
    if (!title || !WORKSPACE_ID_RE.test(String(workspaceId || ""))) {
      return Promise.reject(new Error("工作区窗口标记参数无效"));
    }
    return this.#control({ type: "tag-workspace", title, workspaceId });
  }

  tagAdministrator() {
    return this.#control({ type: "tag-administrator" });
  }
}
