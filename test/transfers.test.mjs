import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createTransferStore } from "../lib/transfers.mjs";

function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gpc-transfer-"));
  const store = createTransferStore({
    root: join(directory, "files"),
    stateFile: join(directory, "index.json"),
    maxFileBytes: 1024 * 1024,
    quotaBytes: 2 * 1024 * 1024,
    ...options,
  });
  return { directory, store };
}

test("私人上传目录按用户隔离并可供该用户的工作区选择", async () => {
  const { directory, store } = fixture();
  try {
    const uploaded = await store.receiveUpload(Readable.from([Buffer.from("LOCAL_FILE")]), {
      userId: "user-office",
      name: "../实验数据?.txt",
      mimeType: "text/plain",
      declaredSize: 10,
    });
    assert.equal(uploaded.state, "ready");
    assert.equal(uploaded.name, "实验数据_.txt");
    assert.equal(uploaded.workspaceId, null);
    const [resolved] = store.resolveUserUploads({
      userId: "user-office",
      ids: [uploaded.id],
    });
    assert.equal(readFileSync(resolved.path, "utf8"), "LOCAL_FILE");
    assert.match(resolved.path, /uploads\/user-office\/[^/]+\/实验数据_\.txt$/);
    assert.equal(statSync(join(directory, "files/uploads/user-office")).mode & 0o777, 0o700);
    assert.equal(statSync(resolved.path).mode & 0o777, 0o600);
    assert.equal(store.listUserFiles({ workspaceId: "office", userId: "user-office" }).length, 1);
    assert.equal(store.listUserFiles({ workspaceId: "laboratory", userId: "user-office" }).length, 1);
    assert.equal(store.listUserFiles({ workspaceId: "office", userId: "another-user" }).length, 0);
    assert.throws(
      () => store.resolveUserUploads({ userId: "another-user", ids: [uploaded.id] }),
      /无权使用/,
    );
    assert.equal(JSON.parse(readFileSync(join(directory, "index.json"), "utf8")).version, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Chromium 下载只允许所属工作区或管理员取回", () => {
  const { directory, store } = fixture();
  try {
    const id = "download-87654321";
    store.beginDownload({ id, workspaceId: "office", name: "结果.csv", mimeType: "text/csv" });
    writeFileSync(store.remotePath(id), "a,b\n1,2\n");
    const completed = store.updateDownload({ id, state: "completed", receivedBytes: 8, totalBytes: 8 });
    assert.equal(completed.entry.state, "ready");
    assert.equal(store.openDownload(id, { workspaceId: "office" }).size, 8);
    assert.throws(() => store.openDownload(id, { workspaceId: "laboratory" }), /无权访问/);
    assert.equal(store.openDownload(id, { isAdmin: true }).entry.name, "结果.csv");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("下载完成事件早于文件可见时会有界重试而非立即误判", () => {
  const { directory, store } = fixture();
  try {
    const id = "download-delayed-123";
    store.beginDownload({ id, workspaceId: "office", name: "delayed.txt" });
    const early = store.updateDownload({ id, state: "completed", receivedBytes: 4, totalBytes: 4 });
    assert.equal(early.retry, true);
    assert.equal(early.entry.state, "in_progress");
    writeFileSync(store.remotePath(id), "LATE");
    const settled = store.updateDownload({ id, state: "completed", receivedBytes: 4, totalBytes: 4 });
    assert.equal(settled.retry, false);
    assert.equal(settled.entry.state, "ready");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CDP 下载行为被重置时可接管传输目录中的报告路径", () => {
  const { directory, store } = fixture();
  try {
    const id = "download-reported-12";
    store.beginDownload({ id, workspaceId: "office", name: "reported.txt" });
    const reported = join(store.downloadRoot, "reported.txt");
    writeFileSync(reported, "REPORTED");
    const completed = store.updateDownload({
      id,
      state: "completed",
      receivedBytes: 8,
      totalBytes: 8,
      filePath: reported,
    });
    assert.equal(completed.entry.state, "ready");
    assert.equal(readFileSync(store.remotePath(id), "utf8"), "REPORTED");
    assert.equal(store.remotePath(id).endsWith(id), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("下载完成后按实际落盘大小执行容量限制", () => {
  const { directory, store } = fixture();
  try {
    const id = "download-too-large-1";
    store.beginDownload({ id, workspaceId: "office", name: "too-large.bin" });
    const reported = join(store.downloadRoot, "too-large.bin");
    writeFileSync(reported, Buffer.alloc(1024 * 1024 + 1));
    const completed = store.updateDownload({
      id,
      state: "completed",
      receivedBytes: 1,
      totalBytes: 1,
      filePath: reported,
    });
    assert.equal(completed.cancel, true);
    assert.equal(completed.entry.state, "failed");
    assert.equal(completed.entry.error, "下载超过文件或目录容量限制");
    assert.throws(() => readFileSync(reported), /ENOENT/);
    const canceled = store.updateDownload({ id, state: "canceled" });
    assert.equal(canceled.terminal, false);
    assert.equal(canceled.entry.error, "下载超过文件或目录容量限制");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("并发 Chromium 下载会把其它进行中任务计入总容量", () => {
  const { directory, store } = fixture({
    maxFileBytes: 2 * 1024 * 1024,
    quotaBytes: 3 * 1024 * 1024,
  });
  try {
    store.beginDownload({ id: "download-first-1234", workspaceId: "office", name: "first.bin" });
    store.beginDownload({ id: "download-second-123", workspaceId: "office", name: "second.bin" });
    const first = store.updateDownload({
      id: "download-first-1234",
      state: "inProgress",
      receivedBytes: 512 * 1024,
      totalBytes: 2 * 1024 * 1024,
    });
    const second = store.updateDownload({
      id: "download-second-123",
      state: "inProgress",
      receivedBytes: 512 * 1024,
      totalBytes: 2 * 1024 * 1024,
    });
    assert.equal(first.cancel, false);
    assert.equal(second.cancel, true);
    assert.equal(second.entry.state, "failed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("单文件、总容量与损坏索引均失败关闭", async () => {
  const { directory, store } = fixture();
  try {
    await assert.rejects(
      () => store.receiveUpload(Readable.from([Buffer.alloc(1024 * 1024 + 1)]), {
        userId: "user-office",
        name: "oversized.bin",
        declaredSize: 1024 * 1024 + 1,
      }),
      /不能超过/,
    );
    assert.throws(
      () => createTransferStore({
        root: join(directory, "invalid-limits"),
        stateFile: join(directory, "invalid-limits.json"),
        maxFileBytes: "invalid",
      }),
      /单文件容量上限/,
    );
    const stateFile = join(directory, "index.json");
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: 2,
        entries: [
          {
            id: "download-12345678",
            kind: "download",
            relativePath: "../profile/Cookies",
            state: "ready",
          },
        ],
      }),
    );
    assert.throws(
      () => createTransferStore({ root: join(directory, "files"), stateFile }),
      /拒绝启动/,
    );
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: 2,
        entries: [
          {
            id: "upload-12345678",
            kind: "upload",
            workspaceId: null,
            userId: "user-office",
            name: "secret.txt",
            relativePath: "uploads/user-office/upload-12345678/../../../downloads/private",
            state: "ready",
          },
        ],
      }),
    );
    assert.throws(
      () => createTransferStore({ root: join(directory, "files"), stateFile }),
      /拒绝启动/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
