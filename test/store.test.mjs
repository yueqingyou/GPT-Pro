import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_COMPOSER_TOOL_ALLOWLIST } from "../lib/focus.mjs";
import { manualBrowserProfile } from "../lib/profile.mjs";
import { createStateStore, normalizeChatGptUrl } from "../lib/store.mjs";

function withStore(run) {
  const directory = mkdtempSync(join(tmpdir(), "gpc-store-"));
  const file = join(directory, "state.json");
  try {
    return run(createStateStore({ file }), file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("十二个工作区和用户均由数据动态管理", () =>
  withStore((store, file) => {
    store.createAdmin({ username: "owner", password: "owner-password" });
    const ids = Array.from({ length: 12 }, (_, index) => `project-${index + 1}`);
    for (const id of ids) {
      store.createWorkspace({ id, name: `项目 ${id}`, startUrl: `https://chatgpt.com/g/${id}` });
    }
    const members = ids.map((id, index) =>
      store.createUser({
        username: `researcher-${index + 1}`,
        password: `member-password-${index + 1}`,
        workspaceIds: [id],
      }),
    );
    assert.equal(store.workspaces().length, 12);
    assert.equal(store.users().length, 13);
    assert.deepEqual(store.workspacesFor(members[11]).map((workspace) => workspace.id), [ids[11]]);
    assert.equal(store.canOpen(members[11], ids[0]), false);
    assert.equal(store.canOpen(members[11], ids[11]), true);
    assert.equal(store.canOpen(store.login("owner", "owner-password"), ids[1]), true);

    const disk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(disk.workspaces.length, 12);
    assert.equal(disk.users.length, 13);
    assert.equal(disk.users.some((user) => Object.hasOwn(user, "password")), false);
    assert.ok(disk.users.filter((user) => user.role === "member").every((user) => /^s1:/.test(user.passwordHash)));
  }));

test("ChatGPT Projects 可预览、批量导入并识别手动创建项", () =>
  withStore((store, file) => {
    const existing = {
      id: "g-p-manual001",
      name: "Manual Project",
      startUrl: "https://chatgpt.com/g/g-p-manual001/project",
    };
    store.createWorkspace({ id: "manual", name: existing.name, startUrl: existing.startUrl });
    store.createUser({ username: existing.name, password: existing.name, workspaceIds: ["manual"] });
    const projects = [
      existing,
      {
        id: "g-p-alpha001",
        name: "Alpha Project",
        startUrl: "https://chatgpt.com/g/g-p-alpha001/project",
      },
      {
        id: "g-p-unicode001",
        name: "组合项目",
        startUrl: "https://chatgpt.com/g/g-p-unicode001/project",
      },
    ];

    const preview = store.previewChatGptProjects(projects);
    assert.deepEqual(preview.map((project) => project.status), ["imported", "ready", "ready"]);
    assert.equal(preview[0].workspaceId, "manual");
    assert.equal(preview[1].workspaceId, "alpha-project");
    assert.match(preview[2].workspaceId, /^project-[a-f0-9]{8}$/);
    assert.deepEqual(
      store.previewChatGptProjects(projects).map((project) => project.workspaceId),
      preview.map((project) => project.workspaceId),
    );

    assert.throws(
      () => store.importChatGptProjects(projects, [projects[1].id, projects[0].id]),
      /已存在/,
    );
    assert.equal(store.workspaces().length, 1);
    const imported = store.importChatGptProjects(projects, [projects[1].id, projects[2].id]);
    assert.equal(imported.workspaces.length, 2);
    assert.equal(imported.users.length, 2);
    assert.equal(store.login("Alpha Project", "Alpha Project")?.workspaceIds[0], "alpha-project");
    assert.equal(store.login("组合项目", "组合项目")?.workspaceIds[0], preview[2].workspaceId);
    assert.ok(store.previewChatGptProjects(projects).every((project) => project.status === "imported"));

    const disk = readFileSync(file, "utf8");
    assert.doesNotMatch(disk, /"password"\s*:/);
    const duplicateNames = store.previewChatGptProjects([
      { id: "g-p-duplicate001", name: "Duplicate", startUrl: "https://chatgpt.com/g/g-p-duplicate001/project" },
      { id: "g-p-duplicate002", name: "duplicate", startUrl: "https://chatgpt.com/g/g-p-duplicate002/project" },
    ]);
    assert.ok(duplicateNames.every((project) => project.status === "conflict"));
  }));

test("非空密码不设最短长度且仍限制空白和超长输入", () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-store-short-password-"));
  const file = join(directory, "state.json");
  try {
    const store = createStateStore({ file, adminUser: "a", adminPassword: "1" });
    assert.equal(store.login("a", "1")?.role, "admin");
    store.createWorkspace({ id: "alpha", name: "Alpha", startUrl: "https://chatgpt.com/" });
    const member = store.createUser({ username: "m", password: "x", workspaceIds: ["alpha"] });
    assert.equal(store.login("m", "x")?.id, member.id);
    store.updateUser(member.id, { password: "短" });
    assert.equal(store.login("m", "短")?.id, member.id);
    assert.throws(() => store.updateUser(member.id, { password: "" }), /密码不能为空/);
    assert.throws(() => store.createUser({ username: "blank", password: "   ", workspaceIds: [] }), /密码不能为空/);
    assert.throws(
      () => store.createUser({ username: "long", password: "x".repeat(257), workspaceIds: [] }),
      /密码过长/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("删除工作区会同步移除所有用户授权", () =>
  withStore((store) => {
    store.createAdmin({ username: "owner", password: "owner-password" });
    store.createWorkspace({ id: "alpha", name: "Alpha", startUrl: "https://chatgpt.com/" });
    const member = store.createUser({ username: "member", password: "member-password", workspaceIds: ["alpha"] });
    store.removeWorkspace("alpha");
    assert.deepEqual(store.user(member.id).workspaceIds, []);
    assert.equal(store.workspace("alpha"), null);
  }));

test("最后页面可持久化，非 ChatGPT 地址被拒绝", () =>
  withStore((store, file) => {
    store.createWorkspace({ id: "alpha", name: "Alpha", startUrl: "https://chatgpt.com/" });
    assert.equal(store.recordLastUrl("alpha", "https://chatgpt.com/g/g-p-test/project"), true);
    assert.equal(store.recordLastUrl("alpha", "http://127.0.0.1/private"), false);
    assert.match(JSON.parse(readFileSync(file, "utf8")).workspaces[0].lastUrl, /^https:\/\/chatgpt\.com\//);
    assert.throws(() => normalizeChatGptUrl("https://example.com/"), /chatgpt\.com/);
    assert.throws(() => normalizeChatGptUrl("https://user:secret@chatgpt.com/"), /chatgpt\.com/);
    assert.throws(() => normalizeChatGptUrl("https://chatgpt.com:8443/"), /chatgpt\.com/);
  }));

test("全局浏览器环境持久化后可重新读取", () =>
  withStore((store, file) => {
    store.setBrowserProfile(manualBrowserProfile({ timezone: "Asia/Tokyo", locale: "ja-JP" }));
    const reloaded = createStateStore({ file });
    assert.equal(reloaded.browserProfile().timezone, "Asia/Tokyo");
    assert.equal(reloaded.browserProfile().locale, "ja-JP");
    assert.deepEqual(reloaded.browserProfile().languages, ["ja-JP", "ja", "en"]);
    assert.equal(reloaded.browserProfile().source, "manual");
  }));

test("编辑器功能白名单默认放行明确四项并持久化管理员选择", () =>
  withStore((store, file) => {
    assert.deepEqual(store.composerToolAllowlist(), DEFAULT_COMPOSER_TOOL_ALLOWLIST);
    const saved = store.setComposerToolAllowlist([" GitHub ", "github", "Deep research"]);
    assert.deepEqual(saved, ["GitHub", "Deep research"]);
    assert.deepEqual(createStateStore({ file }).composerToolAllowlist(), saved);
    assert.throws(() => store.setComposerToolAllowlist(["x".repeat(81)]), /不能超过/);
    assert.deepEqual(store.composerToolAllowlist(), saved);
  }));

test("敏感操作黑名单持久化且无效复合更新不污染内存", () =>
  withStore((store, file) => {
    const original = store.sensitivePolicy();
    const saved = store.setSensitivePolicy({
      enabled: true,
      actionPatterns: ["退出登录", "Settings"],
      urlPatterns: ["*logout*"],
    });
    assert.deepEqual(saved.actionPatterns, ["退出登录", "Settings"]);
    assert.equal(createStateStore({ file }).sensitivePolicy().urlPatterns[0], "*logout*");
    assert.throws(
      () => store.setSensitivePolicy({ actionPatterns: ["x".repeat(181)], enabled: false }),
      /不能超过/,
    );
    assert.deepEqual(store.sensitivePolicy(), saved);
    assert.notDeepEqual(saved, original);
  }));

test("复合更新中任一字段无效时不保留部分内存变更", () =>
  withStore((store) => {
    store.createWorkspace({ id: "alpha", name: "Alpha", startUrl: "https://chatgpt.com/" });
    store.createWorkspace({ id: "beta", name: "Beta", startUrl: "https://chatgpt.com/" });
    const member = store.createUser({ username: "member", password: "member-password", workspaceIds: ["alpha"] });
    const profile = store.setBrowserProfile(manualBrowserProfile({ timezone: "UTC", locale: "en-US" }));

    assert.throws(
      () => store.createUser({ username: "blank-password", password: "        ", workspaceIds: [] }),
      /密码不能为空/,
    );

    assert.throws(
      () => store.updateWorkspace("alpha", { name: "不应保留", startUrl: "https://example.com/" }),
      /chatgpt\.com/,
    );
    assert.equal(store.workspace("alpha").name, "Alpha");

    assert.throws(
      () => store.updateUser(member.id, { workspaceIds: ["beta"], password: "x".repeat(257) }),
      /密码过长/,
    );
    assert.deepEqual(store.user(member.id).workspaceIds, ["alpha"]);

    assert.throws(() => store.setBrowserProfile({ mode: "manual", configured: false }), /不完整/);
    assert.deepEqual(store.browserProfile(), profile);
  }));

test("损坏或结构冲突的状态文件不会被静默覆盖", () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-store-bad-"));
  const file = join(directory, "state.json");
  try {
    writeFileSync(file, JSON.stringify({ version: 1, users: [], workspaces: [{ id: "bad id" }] }));
    assert.throws(() => createStateStore({ file }), /无法读取状态文件/);
    rmSync(file);
    const store = createStateStore({ file });
    store.createWorkspace({ id: "alpha", name: "Alpha", startUrl: "https://chatgpt.com/" });
    const raw = JSON.parse(readFileSync(file, "utf8"));
    delete raw.composerToolAllowlist;
    writeFileSync(file, JSON.stringify(raw));
    assert.throws(() => createStateStore({ file }), /编辑器功能白名单必须是数组/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("浏览器环境模式与来源冲突时失败关闭", () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-store-profile-bad-"));
  const file = join(directory, "state.json");
  try {
    const store = createStateStore({ file });
    store.setBrowserProfile(manualBrowserProfile({ timezone: "UTC", locale: "en-US" }));
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.browserProfile.source = "ip";
    writeFileSync(file, JSON.stringify(raw));
    assert.throws(() => createStateStore({ file }), /模式与来源不一致/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
