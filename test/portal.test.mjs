import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FilePortalBridge } from "../lib/portal.mjs";

function connect(path) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readJson(socket) {
  return new Promise((resolve, reject) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(JSON.parse(text.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

test("Portal IPC 将单次选择结果返回桌面后端", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-portal-"));
  const gatewaySocket = join(directory, "gateway.sock");
  const desktopSocket = join(directory, "desktop.sock");
  const bridge = new FilePortalBridge({
    gatewaySocket,
    desktopSocket,
    ownerUid: process.getuid(),
    ownerGid: process.getgid(),
  });
  await bridge.start();
  try {
    const requestId = "11111111-1111-4111-8111-111111111111";
    const opened = new Promise((resolve) => bridge.once("open", resolve));
    const socket = await connect(gatewaySocket);
    const response = readJson(socket);
    socket.write(`${JSON.stringify({
      type: "open",
      requestId,
      workspaceId: "office",
      multiple: false,
      directory: false,
    })}\n`);
    assert.deepEqual(await opened, {
      requestId,
      workspaceId: "office",
      multiple: false,
      directory: false,
    });
    assert.equal(bridge.select(requestId, ["/transfer/uploads/user/private/data.txt"]), true);
    assert.deepEqual(await response, {
      status: "selected",
      paths: ["/transfer/uploads/user/private/data.txt"],
    });
    socket.destroy();
  } finally {
    await bridge.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Portal IPC 连接关闭会撤销对应工作区请求", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-portal-close-"));
  const gatewaySocket = join(directory, "gateway.sock");
  const bridge = new FilePortalBridge({
    gatewaySocket,
    desktopSocket: join(directory, "desktop.sock"),
    ownerUid: process.getuid(),
    ownerGid: process.getgid(),
  });
  await bridge.start();
  try {
    const requestId = "22222222-2222-4222-8222-222222222222";
    const opened = new Promise((resolve) => bridge.once("open", resolve));
    const closed = new Promise((resolve) => bridge.once("closed", resolve));
    const socket = await connect(gatewaySocket);
    socket.write(`${JSON.stringify({
      type: "open",
      requestId,
      workspaceId: "office",
      multiple: true,
      directory: false,
    })}\n`);
    await opened;
    socket.destroy();
    assert.equal((await closed).requestId, requestId);
  } finally {
    await bridge.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Gateway 通过独立桌面 IPC 请求精确窗口标记", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-portal-tag-"));
  const desktopSocket = join(directory, "desktop.sock");
  const messages = [];
  const desktop = net.createServer((socket) => {
    readJson(socket).then((message) => {
      messages.push(message);
      socket.end('{"ok":true}\n');
    });
  });
  await new Promise((resolve, reject) => {
    desktop.once("error", reject);
    desktop.listen(desktopSocket, resolve);
  });
  const bridge = new FilePortalBridge({
    gatewaySocket: join(directory, "gateway.sock"),
    desktopSocket,
    ownerUid: process.getuid(),
    ownerGid: process.getgid(),
  });
  try {
    await bridge.tagWorkspace({ title: "unique - Chromium", workspaceId: "office" });
    await bridge.tagAdministrator();
    assert.deepEqual(messages, [
      { type: "tag-workspace", title: "unique - Chromium", workspaceId: "office" },
      { type: "tag-administrator" },
    ]);
  } finally {
    await new Promise((resolve) => desktop.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
