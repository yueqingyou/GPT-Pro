import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function requirePasswordConfigured(password) {
  const p = String(password ?? "");
  if (!p.trim()) throw new Error("密码不能为空");
  return p;
}

export function hashPassword(password) {
  const plain = requirePasswordConfigured(password);
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 32);
  return `s1:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function validPasswordHash(stored) {
  return /^s1:[0-9a-f]{32}:[0-9a-f]{64}$/.test(String(stored || ""));
}

export function passwordMatches(plain, stored) {
  if (typeof plain !== "string" || !plain || !validPasswordHash(stored)) return false;
  const [, saltHex, hashHex] = stored.split(":");
  const expected = Buffer.from(hashHex, "hex");
  const got = scryptSync(plain, Buffer.from(saltHex, "hex"), 32);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

export function createSessionToken() {
  return randomBytes(24).toString("hex");
}

export function readSession(sessions, token, now = Date.now(), ttlMs = 14 * 24 * 60 * 60 * 1000) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < now) {
    sessions.delete(token);
    return null;
  }
  if (s.expires - now < ttlMs / 2) s.expires = now + ttlMs;
  return s;
}

export function createLoginLimiter({ maxFails = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const fails = new Map();
  const prune = (now) => {
    if (fails.size < 1024) return;
    for (const [k, v] of fails) if (v.until < now) fails.delete(k);
  };
  return {
    blocked(key, now = Date.now()) {
      const rec = fails.get(key);
      if (!rec) return false;
      if (rec.until < now) {
        fails.delete(key);
        return false;
      }
      return rec.count >= maxFails;
    },
    fail(key, now = Date.now()) {
      prune(now);
      const rec = fails.get(key);
      if (!rec || rec.until < now) {
        fails.set(key, { count: 1, until: now + windowMs });
        return;
      }
      rec.count += 1;
      rec.until = now + windowMs;
    },
    ok(key) {
      fails.delete(key);
    },
  };
}

export function createSessionStore({ file, ttlMs = 14 * 24 * 60 * 60 * 1000, flushEveryMs = 5 * 60 * 1000 } = {}) {
  const map = new Map();
  if (file && existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const now = Date.now();
      for (const [token, rec] of Object.entries(raw.sessions || {})) {
        if (rec && typeof rec.expires === "number" && rec.expires > now && rec.userId) map.set(token, rec);
      }
    } catch (error) {
      throw new Error(`无法读取会话文件 ${file}；为避免绕过登录，网关已拒绝启动`, { cause: error });
    }
  }
  const persist = () => {
    if (!file) return;
    const now = Date.now();
    for (const [token, rec] of map) if (rec.expires <= now) map.delete(token);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions: Object.fromEntries(map) }), { mode: 0o600 });
    renameSync(tmp, file);
  };
  let timer = null;
  const scheduleFlush = () => {
    if (!file || timer) return;
    timer = setTimeout(() => {
      timer = null;
      persist();
    }, flushEveryMs);
    if (typeof timer.unref === "function") timer.unref();
  };
  return {
    get(token) {
      scheduleFlush();
      return map.get(token);
    },
    set(token, rec) {
      map.set(token, rec);
      persist();
    },
    delete(token) {
      const had = map.delete(token);
      if (had) persist();
      return had;
    },
    deleteByUser(userId) {
      let removed = 0;
      for (const [token, rec] of map) {
        if (rec.userId === userId) {
          map.delete(token);
          removed += 1;
        }
      }
      if (removed) persist();
      return removed;
    },
    deleteByWorkspace(workspaceId) {
      let removed = 0;
      for (const [token, rec] of map) {
        if (rec.workspaceId === workspaceId) {
          map.delete(token);
          removed += 1;
        }
      }
      if (removed) persist();
      return removed;
    },
    get size() {
      return map.size;
    },
    ttlMs,
  };
}
