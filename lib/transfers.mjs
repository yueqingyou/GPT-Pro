import { randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const ID_RE = /^[a-zA-Z0-9-]{8,80}$/;
const INDEX_VERSION = 2;
const USER_UPLOAD_QUOTA_BYTES = 1024 * 1024 * 1024;

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function bytesLimit(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1024 * 1024) {
    throw new Error(`${label}必须是不小于 1048576 的整数`);
  }
  return number;
}

function safeFilename(raw) {
  const original = basename(String(raw || "file").normalize("NFKC")).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_");
  const trimmed = original.replace(/^[. ]+|[. ]+$/g, "").slice(0, 180);
  return trimmed || "file";
}

function safeMimeType(raw) {
  const value = String(raw || "application/octet-stream").trim().slice(0, 120);
  return /^[\w.+-]+\/[\w.+-]+(?:;[\x20-\x7e]*)?$/.test(value) ? value : "application/octet-stream";
}

function privatePath(root, relativePath) {
  const full = resolve(root, relativePath);
  const prefix = resolve(root) + sep;
  if (!full.startsWith(prefix)) throw new Error("传输索引包含越界路径");
  return full;
}

function publicEntry(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    workspaceId: entry.workspaceId,
    name: entry.name,
    mimeType: entry.mimeType,
    size: entry.size,
    receivedBytes: entry.receivedBytes,
    totalBytes: entry.totalBytes,
    state: entry.state,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

function validateEntry(root, raw) {
  if (!raw || typeof raw !== "object" || !ID_RE.test(String(raw.id || ""))) throw new Error("传输索引包含无效 ID");
  if (raw.kind !== "upload" && raw.kind !== "download") throw new Error("传输索引包含无效类型");
  const userId = raw.userId == null ? null : String(raw.userId);
  if (raw.kind === "upload" && (!ID_RE.test(userId || "") || raw.workspaceId != null)) {
    throw new Error("传输索引包含无效用户私人文件");
  }
  if (raw.kind === "download" && userId != null) throw new Error("传输索引包含无效下载归属");
  const name = safeFilename(raw.name);
  const relativePath = String(raw.relativePath || "");
  const expectedPath = raw.kind === "upload"
    ? `uploads/${userId}/${raw.id}/${name}`
    : `downloads/${raw.id}`;
  if (relativePath !== expectedPath) {
    throw new Error("传输索引包含无效文件路径");
  }
  privatePath(root, relativePath);
  const state = ["receiving", "ready", "in_progress", "failed"].includes(raw.state) ? raw.state : null;
  if (!state) throw new Error("传输索引包含无效状态");
  return {
    id: String(raw.id),
    kind: raw.kind,
    workspaceId: raw.workspaceId == null ? null : String(raw.workspaceId),
    userId,
    name,
    mimeType: safeMimeType(raw.mimeType),
    relativePath,
    size: Math.max(0, Number(raw.size) || 0),
    receivedBytes: Math.max(0, Number(raw.receivedBytes) || 0),
    totalBytes: Math.max(0, Number(raw.totalBytes) || 0),
    state,
    createdAt: String(raw.createdAt || new Date(0).toISOString()),
    updatedAt: String(raw.updatedAt || raw.createdAt || new Date(0).toISOString()),
    error: raw.error ? String(raw.error).slice(0, 240) : "",
  };
}

export function createTransferStore({
  root,
  stateFile,
  userQuotaBytes = USER_UPLOAD_QUOTA_BYTES,
  ownerUid,
  ownerGid,
  now = () => Date.now(),
} = {}) {
  if (!root || !stateFile) throw new Error("传输存储缺少 root 或 stateFile");
  const transferRoot = resolve(root);
  const uploadRoot = join(transferRoot, "uploads");
  const downloadRoot = join(transferRoot, "downloads");
  const userLimit = bytesLimit(userQuotaBytes, "用户私人空间上限");
  const uid = Number.isInteger(Number(ownerUid)) ? Number(ownerUid) : null;
  const gid = Number.isInteger(Number(ownerGid)) ? Number(ownerGid) : null;
  mkdirSync(uploadRoot, { recursive: true, mode: 0o700 });
  mkdirSync(downloadRoot, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(stateFile), { recursive: true });

  let entries = [];
  if (existsSync(stateFile)) {
    try {
      const raw = JSON.parse(readFileSync(stateFile, "utf8"));
      if (!raw || raw.version !== INDEX_VERSION || !Array.isArray(raw.entries)) throw new Error("索引结构无效");
      entries = raw.entries.map((entry) => validateEntry(transferRoot, entry));
    } catch (error) {
      throw new Error(`无法读取传输索引 ${stateFile}：${error.message}；为避免越权，网关已拒绝启动`, { cause: error });
    }
  }

  const persist = () => {
    const temp = `${stateFile}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: INDEX_VERSION, entries }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, stateFile);
  };

  const find = (id) => entries.find((entry) => entry.id === String(id || ""));
  const entryPath = (entry) => privatePath(transferRoot, entry.relativePath);
  const reportedDownloadPath = (raw) => {
    const full = resolve(String(raw || ""));
    if (!full.startsWith(resolve(downloadRoot) + sep)) return "";
    try {
      return lstatSync(full).isFile() ? full : "";
    } catch {
      return "";
    }
  };
  const entryBytes = (entry) => {
    if (entry.state === "receiving" || entry.state === "in_progress") {
      return Math.max(entry.size, entry.receivedBytes, entry.totalBytes);
    }
    if (!existsSync(entryPath(entry))) return 0;
    try {
      return statSync(entryPath(entry)).size;
    } catch {
      return 0;
    }
  };
  const userUsedBytes = (userId, exceptId = "") => entries.reduce(
    (sum, entry) =>
      sum + (entry.kind === "upload" && entry.userId === userId && entry.id !== exceptId ? entryBytes(entry) : 0),
    0,
  );
  const setDirectoryOwner = (directory) => {
    chmodSync(directory, 0o700);
    if (uid != null && gid != null) chownSync(directory, uid, gid);
  };
  const setOwner = (path) => {
    const directory = dirname(path);
    setDirectoryOwner(directory);
    chmodSync(path, 0o600);
    if (uid != null && gid != null) chownSync(path, uid, gid);
  };
  const removeEntryFiles = (entry) => {
    const path = entryPath(entry);
    rmSync(entry.kind === "upload" ? dirname(path) : path, { recursive: true, force: true });
    rmSync(`${path}.crdownload`, { force: true });
  };

  const api = {
    root: transferRoot,
    uploadRoot,
    downloadRoot,
    userQuotaBytes: userLimit,
    cleanup() {
      const kept = [];
      let changed = false;
      for (const entry of entries) {
        const missingReadyFile = entry.state === "ready" && !existsSync(entryPath(entry));
        if (missingReadyFile || entry.state === "receiving") {
          removeEntryFiles(entry);
          changed = true;
        } else {
          kept.push(entry);
        }
      }
      entries = kept;
      if (changed) persist();
      return changed;
    },
    async receiveUpload(stream, { userId, name, mimeType, declaredSize = 0 } = {}) {
      const privateUserId = String(userId || "");
      if (!ID_RE.test(privateUserId)) throw fail("上传缺少有效用户身份", 403);
      const size = Math.max(0, Number(declaredSize) || 0);
      if (userUsedBytes(privateUserId) + size > userLimit) throw fail("用户私人空间已达到容量上限", 507);
      const id = randomUUID();
      const filename = safeFilename(name);
      const userDirectory = join(uploadRoot, privateUserId);
      const directory = join(userDirectory, id);
      const finalPath = join(directory, filename);
      const partialPath = join(directory, ".uploading");
      mkdirSync(userDirectory, { recursive: true, mode: 0o700 });
      setDirectoryOwner(userDirectory);
      mkdirSync(directory, { recursive: false, mode: 0o700 });
      const timestamp = new Date(now()).toISOString();
      const entry = {
        id,
        kind: "upload",
        workspaceId: null,
        userId: privateUserId,
        name: filename,
        mimeType: safeMimeType(mimeType),
        relativePath: relative(transferRoot, finalPath).split(sep).join("/"),
        size,
        receivedBytes: 0,
        totalBytes: size,
        state: "receiving",
        createdAt: timestamp,
        updatedAt: timestamp,
        error: "",
      };
      entries.push(entry);
      persist();
      let received = 0;
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          entry.receivedBytes = received;
          if (userUsedBytes(privateUserId, id) + received > userLimit) {
            callback(fail("用户私人空间已达到容量上限", 507));
            return;
          }
          callback(null, chunk);
        },
      });
      try {
        await pipeline(stream, limit, createWriteStream(partialPath, { flags: "wx", mode: 0o600 }));
        if (size && received !== size) throw fail("上传文件长度与声明不一致", 400);
        renameSync(partialPath, finalPath);
        setOwner(finalPath);
        entry.size = received;
        entry.receivedBytes = received;
        entry.totalBytes = received;
        entry.state = "ready";
        entry.updatedAt = new Date(now()).toISOString();
        persist();
        return publicEntry(entry);
      } catch (error) {
        removeEntryFiles(entry);
        entries = entries.filter((candidate) => candidate.id !== id);
        persist();
        throw error;
      }
    },
    beginDownload({ id, workspaceId = null, name, mimeType = "application/octet-stream" }) {
      const downloadId = String(id || "");
      if (!ID_RE.test(downloadId)) throw new Error("Chromium 下载 ID 无效");
      const timestamp = new Date(now()).toISOString();
      const relativePath = `downloads/${downloadId}`;
      const existing = find(downloadId);
      if (existing) {
        removeEntryFiles(existing);
        entries = entries.filter((entry) => entry.id !== downloadId);
      }
      const entry = {
        id: downloadId,
        kind: "download",
        workspaceId: workspaceId == null ? null : String(workspaceId),
        userId: null,
        name: safeFilename(name),
        mimeType: safeMimeType(mimeType),
        relativePath,
        size: 0,
        receivedBytes: 0,
        totalBytes: 0,
        state: "in_progress",
        createdAt: timestamp,
        updatedAt: timestamp,
        error: "",
      };
      entries.push(entry);
      persist();
      return publicEntry(entry);
    },
    updateDownload({ id, state, receivedBytes = 0, totalBytes = 0, filePath = "", finalAttempt = false }) {
      const entry = find(id);
      if (!entry || entry.kind !== "download") return { entry: null, cancel: false };
      if (entry.state !== "in_progress") {
        return { entry: publicEntry(entry), cancel: false, retry: false, terminal: false };
      }
      entry.receivedBytes = Math.max(0, Number(receivedBytes) || 0);
      entry.totalBytes = Math.max(0, Number(totalBytes) || 0);
      entry.updatedAt = new Date(now()).toISOString();
      const reportedPath = reportedDownloadPath(filePath);
      if (state === "completed") {
        const path = entryPath(entry);
        if (!existsSync(path) && reportedPath && reportedPath !== path) renameSync(reportedPath, path);
        if (existsSync(path)) {
          const actualSize = statSync(path).size;
          setOwner(path);
          entry.size = actualSize;
          entry.receivedBytes = entry.size;
          entry.totalBytes = Math.max(entry.totalBytes, entry.size);
          entry.state = "ready";
          entry.error = "";
          persist();
        } else if (finalAttempt) {
          entry.state = "failed";
          entry.error = "Chromium 报告下载完成，但文件不存在";
          persist();
        }
      } else if (state === "canceled" || state === "interrupted") {
        entry.state = "failed";
        entry.error = state === "canceled" ? "下载已取消" : "下载中断";
        removeEntryFiles(entry);
        persist();
      }
      return {
        entry: publicEntry(entry),
        cancel: false,
        retry: state === "completed" && entry.state === "in_progress" && !finalAttempt,
        terminal: entry.state === "ready" || entry.state === "failed",
      };
    },
    resolveUserUploads({ userId, ids }) {
      if (!Array.isArray(ids) || !ids.length) throw fail("请选择待上传文件");
      const privateUserId = String(userId || "");
      const result = [];
      const unique = new Set();
      for (const rawId of ids) {
        const id = String(rawId || "");
        if (unique.has(id)) continue;
        unique.add(id);
        const entry = find(id);
        const authorized =
          entry?.kind === "upload" &&
          entry.state === "ready" &&
          entry.userId === privateUserId;
        if (!authorized || !existsSync(entryPath(entry))) throw fail("上传文件不存在或无权使用", 404);
        result.push({ ...publicEntry(entry), path: entryPath(entry) });
      }
      return result;
    },
    listUserFiles({ workspaceId, userId }) {
      const id = String(workspaceId || "");
      const privateUserId = String(userId || "");
      return entries
        .filter((entry) =>
          entry.kind === "upload" ? entry.userId === privateUserId : entry.workspaceId === id,
        )
        .map(publicEntry);
    },
    userUsage(userId) {
      const id = String(userId || "");
      if (!ID_RE.test(id)) throw fail("缺少有效用户身份", 403);
      const usedBytes = userUsedBytes(id);
      return {
        usedBytes,
        quotaBytes: userLimit,
        availableBytes: Math.max(0, userLimit - usedBytes),
      };
    },
    listAdmin() {
      return entries.map(publicEntry);
    },
    remotePath(id) {
      const entry = find(id);
      return entry ? entryPath(entry) : "";
    },
    openDownload(id, { workspaceId, isAdmin = false } = {}) {
      const entry = find(id);
      if (
        !entry ||
        entry.kind !== "download" ||
        entry.state !== "ready" ||
        (!isAdmin && entry.workspaceId !== String(workspaceId || "")) ||
        !existsSync(entryPath(entry))
      ) {
        throw fail("下载文件不存在或无权访问", 404);
      }
      const path = entryPath(entry);
      return { entry: publicEntry(entry), path, size: statSync(path).size, stream: () => createReadStream(path) };
    },
    remove(id, { workspaceId, userId, isAdmin = false } = {}) {
      const entry = find(id);
      const authorized =
        entry &&
        (isAdmin ||
          (entry.kind === "upload"
            ? entry.userId === String(userId || "")
            : entry.workspaceId === String(workspaceId || "")));
      if (!authorized) throw fail("传输文件不存在或无权删除", 404);
      removeEntryFiles(entry);
      entries = entries.filter((candidate) => candidate.id !== entry.id);
      persist();
      return publicEntry(entry);
    },
    removeWorkspace(workspaceId) {
      const id = String(workspaceId || "");
      const removed = entries.filter((entry) => entry.kind === "download" && entry.workspaceId === id);
      for (const entry of removed) removeEntryFiles(entry);
      if (removed.length) {
        entries = entries.filter((entry) => entry.kind === "upload" || entry.workspaceId !== id);
        persist();
      }
      return removed.length;
    },
    removeUserUploads(userId) {
      const id = String(userId || "");
      const removed = entries.filter((entry) => entry.kind === "upload" && entry.userId === id);
      for (const entry of removed) removeEntryFiles(entry);
      if (removed.length) {
        const ids = new Set(removed.map((entry) => entry.id));
        entries = entries.filter((entry) => !ids.has(entry.id));
        persist();
      }
      if (ID_RE.test(id)) rmSync(join(uploadRoot, id), { recursive: true, force: true });
      return removed.length;
    },
  };

  api.cleanup();
  return api;
}
