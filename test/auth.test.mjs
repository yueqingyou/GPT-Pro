import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createLoginLimiter,
  createSessionStore,
  createSessionToken,
  hashPassword,
  passwordMatches,
  readSession,
  validPasswordHash,
} from "../lib/auth.mjs";

test("密码使用独立随机盐并可验证", () => {
  const first = hashPassword("correct horse battery staple");
  const second = hashPassword("correct horse battery staple");
  assert.notEqual(first, second);
  assert.equal(passwordMatches("correct horse battery staple", first), true);
  assert.equal(passwordMatches("wrong password", first), false);
  const spaced = hashPassword("  保留空格  ");
  assert.equal(passwordMatches("  保留空格  ", spaced), true);
  assert.equal(passwordMatches("保留空格", spaced), false);
  assert.equal(validPasswordHash(first), true);
  assert.equal(passwordMatches("correct horse battery staple", "not-current-format"), false);
  assert.throws(() => hashPassword("        "), /密码不能为空/);
});

test("路径会话记录可持久化、续期和按工作区撤销", () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-auth-"));
  const file = join(directory, "sessions.json");
  try {
    const store = createSessionStore({ file, ttlMs: 1000, flushEveryMs: 10 });
    const first = createSessionToken();
    const second = createSessionToken();
    store.set(first, { kind: "workspace", userId: "u1", workspaceId: "alpha", expires: Date.now() + 1000 });
    store.set(second, { kind: "workspace", userId: "u2", workspaceId: "beta", expires: Date.now() + 1000 });
    assert.equal(readSession(store, first)?.workspaceId, "alpha");
    assert.equal(store.deleteByWorkspace("alpha"), 1);
    assert.equal(store.get(first), undefined);
    assert.equal(store.get(second)?.workspaceId, "beta");

    const restored = createSessionStore({ file, ttlMs: 1000 });
    assert.equal(restored.get(second)?.userId, "u2");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).sessions[second].workspaceId, "beta");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("损坏的会话文件会失败关闭", () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-auth-bad-"));
  const file = join(directory, "sessions.json");
  try {
    writeFileSync(file, "not-json");
    assert.throws(() => createSessionStore({ file }), /拒绝启动/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("登录限流按独立 key 计数", () => {
  const limiter = createLoginLimiter({ maxFails: 2, windowMs: 1000 });
  limiter.fail("ip|alice", 100);
  assert.equal(limiter.blocked("ip|alice", 101), false);
  limiter.fail("ip|alice", 102);
  assert.equal(limiter.blocked("ip|alice", 103), true);
  assert.equal(limiter.blocked("ip|bob", 103), false);
  limiter.ok("ip|alice");
  assert.equal(limiter.blocked("ip|alice", 104), false);
});
