import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashPassword, passwordMatches, validPasswordHash } from "./auth.mjs";
import { DEFAULT_COMPOSER_TOOL_ALLOWLIST, normalizeComposerToolAllowlist } from "./focus.mjs";
import { defaultSensitivePolicy, normalizeSensitivePolicy } from "./policy.mjs";
import { emptyBrowserProfile, normalizeBrowserProfile } from "./profile.mjs";

export const DEFAULT_START_URL = "https://chatgpt.com/";
export const WORKSPACE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const CHATGPT_PROJECT_ID_RE = /^g-p-[A-Za-z0-9_-]+$/;

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeUsername(raw) {
  const username = String(raw || "").trim();
  if (!username || username.length > 32) throw fail("用户名须为 1–32 个字符");
  return username;
}

function usernameKey(raw) {
  return String(raw || "").trim().toLocaleLowerCase("en-US");
}

function normalizePassword(raw) {
  const password = String(raw || "");
  if (!password.trim()) throw fail("密码不能为空");
  if (password.length > 256) throw fail("密码过长");
  return password;
}

function normalizeWorkspaceId(raw) {
  const id = String(raw || "").trim().toLocaleLowerCase("en-US");
  if (!WORKSPACE_ID_RE.test(id)) {
    throw fail("工作区 ID 只能使用小写字母、数字和连字符，长度不超过 32 位");
  }
  return id;
}

function normalizeWorkspaceName(raw) {
  const name = String(raw || "").trim();
  if (!name || name.length > 48) throw fail("工作区名称须为 1–48 个字符");
  return name;
}

export function normalizeChatGptUrl(raw) {
  const value = String(raw || "").trim() || DEFAULT_START_URL;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail("起始地址不是有效 URL");
  }
  const host = url.hostname.toLocaleLowerCase("en-US");
  if (url.protocol !== "https:" || host !== "chatgpt.com" || url.port || url.username || url.password) {
    throw fail("工作区地址必须是 https://chatgpt.com/ 下的页面");
  }
  url.hash = "";
  return url.toString();
}

function normalizeStateTimestamp(raw, label) {
  const parsed = new Date(String(raw || ""));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`状态文件${label}时间无效`);
  return parsed.toISOString();
}

function normalizeWorkspaceIds(raw, knownIds) {
  if (!Array.isArray(raw)) throw fail("工作区权限必须是数组");
  const result = [];
  const seen = new Set();
  for (const value of raw) {
    const id = normalizeWorkspaceId(value);
    if (!knownIds.has(id)) throw fail(`工作区不存在：${id}`);
    if (!seen.has(id)) result.push(id);
    seen.add(id);
  }
  return result;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    workspaceIds: [...user.workspaceIds],
    disabled: !!user.disabled,
  };
}

function publicWorkspace(workspace) {
  return { ...workspace };
}

function normalizeChatGptProject(raw) {
  const projectId = String(raw?.id || "").trim();
  if (!CHATGPT_PROJECT_ID_RE.test(projectId)) throw fail("ChatGPT Project 标识无效");
  const name = String(raw?.name || "").trim();
  const startUrl = normalizeChatGptUrl(raw?.startUrl);
  const expectedUrl = new URL(`/g/${projectId}/project`, DEFAULT_START_URL).toString();
  if (startUrl !== expectedUrl) throw fail("ChatGPT Project 地址与标识不一致");
  return { projectId, name, startUrl };
}

function workspaceIdBase(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function allocateWorkspaceId(project, reserved) {
  const slug = workspaceIdBase(project.name);
  const base = slug || "project";
  const plain = base.slice(0, 32).replace(/-+$/g, "");
  if (slug && WORKSPACE_ID_RE.test(plain) && !reserved.has(plain)) return plain;
  const hash = createHash("sha256").update(project.projectId).digest("hex");
  for (const length of [8, 12, 16, 20]) {
    const prefix = base.slice(0, 31 - length).replace(/-+$/g, "") || "project";
    const candidate = `${prefix}-${hash.slice(0, length)}`;
    if (WORKSPACE_ID_RE.test(candidate) && !reserved.has(candidate)) return candidate;
  }
  throw fail("无法为 ChatGPT Project 生成工作区 ID", 409);
}

function buildChatGptProjectPreview(rawProjects, state) {
  if (!Array.isArray(rawProjects)) throw fail("ChatGPT Projects 列表无效");
  const projects = rawProjects.map(normalizeChatGptProject);
  const ids = new Set();
  for (const project of projects) {
    if (ids.has(project.projectId)) throw fail("ChatGPT Projects 列表包含重复标识");
    ids.add(project.projectId);
  }

  const nameCounts = new Map();
  for (const project of projects) {
    const key = usernameKey(project.name);
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }

  const previews = projects.map((project, index) => {
    try {
      normalizeWorkspaceName(project.name);
      normalizeUsername(project.name);
      normalizePassword(project.name);
    } catch (error) {
      return { ...project, index, workspaceId: null, status: "invalid", reason: error.message };
    }
    if (nameCounts.get(usernameKey(project.name)) > 1) {
      return { ...project, index, workspaceId: null, status: "conflict", reason: "存在同名 Project" };
    }

    const urlMatches = state.workspaces.filter((workspace) => workspace.startUrl === project.startUrl);
    const workspaceNameMatches = state.workspaces.filter(
      (workspace) => usernameKey(workspace.name) === usernameKey(project.name),
    );
    const user = state.users.find((candidate) => usernameKey(candidate.username) === usernameKey(project.name));
    if (urlMatches.length === 1) {
      const workspace = urlMatches[0];
      const imported =
        workspace.name === project.name &&
        user?.role === "member" &&
        user.workspaceIds.includes(workspace.id) &&
        passwordMatches(project.name, user.passwordHash);
      if (imported) {
        return { ...project, index, workspaceId: workspace.id, status: "imported", reason: "已存在" };
      }
      return {
        ...project,
        index,
        workspaceId: workspace.id,
        status: "conflict",
        reason: "现有设置与该 Project 不一致",
      };
    }
    if (urlMatches.length > 1 || workspaceNameMatches.length || user) {
      return {
        ...project,
        index,
        workspaceId: null,
        status: "conflict",
        reason: "已有同名用户或工作区",
      };
    }
    return { ...project, index, workspaceId: null, status: "ready", reason: "" };
  });

  const reserved = new Set(state.workspaces.map((workspace) => workspace.id));
  const ready = previews
    .filter((project) => project.status === "ready")
    .sort((left, right) => left.projectId.localeCompare(right.projectId, "en-US"));
  for (const project of ready) {
    project.workspaceId = allocateWorkspaceId(project, reserved);
    reserved.add(project.workspaceId);
  }
  return previews
    .sort((left, right) => left.index - right.index)
    .map(({ index: _index, ...project }) => project);
}

function validateLoadedState(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== 1) {
    throw new Error("状态文件版本无效；为避免覆盖数据，网关已拒绝启动");
  }
  if (!Array.isArray(raw.users) || !Array.isArray(raw.workspaces)) {
    throw new Error("状态文件结构无效；为避免覆盖数据，网关已拒绝启动");
  }

  const workspaceIds = new Set();
  const workspaces = raw.workspaces.map((workspace) => {
    const id = normalizeWorkspaceId(workspace?.id);
    if (workspaceIds.has(id)) throw new Error(`状态文件包含重复工作区：${id}`);
    workspaceIds.add(id);
    if (!String(workspace?.startUrl || "").trim() || !String(workspace?.lastUrl || "").trim()) {
      throw new Error(`状态文件中工作区 ${id} 缺少地址`);
    }
    return {
      id,
      name: normalizeWorkspaceName(workspace?.name),
      startUrl: normalizeChatGptUrl(workspace?.startUrl),
      lastUrl: normalizeChatGptUrl(workspace?.lastUrl),
      createdAt: normalizeStateTimestamp(workspace?.createdAt, "创建"),
      updatedAt: normalizeStateTimestamp(workspace?.updatedAt, "更新"),
    };
  });

  const userIds = new Set();
  const usernames = new Set();
  const users = raw.users.map((user) => {
    const id = String(user?.id || "");
    if (!id || userIds.has(id)) throw new Error("状态文件包含无效或重复用户 ID");
    userIds.add(id);
    const username = normalizeUsername(user?.username);
    const key = usernameKey(username);
    if (usernames.has(key)) throw new Error(`状态文件包含重复用户名：${username}`);
    usernames.add(key);
    if (user?.role !== "admin" && user?.role !== "member") throw new Error(`用户角色无效：${username}`);
    if (!validPasswordHash(user?.passwordHash)) {
      throw new Error(`用户密码摘要无效：${username}`);
    }
    if (typeof user.disabled !== "boolean") throw new Error(`用户停用状态无效：${username}`);
    return {
      id,
      username,
      role: user.role,
      passwordHash: user.passwordHash,
      workspaceIds:
        user.role === "admin" ? [] : normalizeWorkspaceIds(user.workspaceIds, workspaceIds),
      disabled: user.role === "admin" ? false : user.disabled,
    };
  });

  if (users.filter((user) => user.role === "admin").length > 1) {
    throw new Error("状态文件包含多个管理员；网关已拒绝启动");
  }
  return {
    version: 1,
    browserProfile: normalizeBrowserProfile(raw.browserProfile),
    composerToolAllowlist: normalizeComposerToolAllowlist(raw.composerToolAllowlist),
    sensitivePolicy: normalizeSensitivePolicy(raw.sensitivePolicy),
    users,
    workspaces,
  };
}

export function createStateStore({ file, adminUser = "admin", adminPassword = "" } = {}) {
  if (!file) throw new Error("状态文件路径不能为空");
  mkdirSync(dirname(file), { recursive: true });

  let state = {
    version: 1,
    browserProfile: emptyBrowserProfile(),
    composerToolAllowlist: [...DEFAULT_COMPOSER_TOOL_ALLOWLIST],
    sensitivePolicy: defaultSensitivePolicy(),
    users: [],
    workspaces: [],
  };
  if (existsSync(file)) {
    try {
      state = validateLoadedState(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      throw new Error(`无法读取状态文件 ${file}：${error.message}`, { cause: error });
    }
  }

  const persist = () => {
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  };

  const findUserById = (id) => state.users.find((user) => user.id === id);
  const findUserByName = (username) => {
    const key = usernameKey(username);
    return state.users.find((user) => usernameKey(user.username) === key);
  };
  const dummyPasswordHash = hashPassword(randomUUID());
  const findWorkspace = (id) => state.workspaces.find((workspace) => workspace.id === id);
  const knownWorkspaceIds = () => new Set(state.workspaces.map((workspace) => workspace.id));

  const createAdmin = ({ username, password }) => {
    if (state.users.some((user) => user.role === "admin")) throw fail("管理员已存在", 409);
    const name = normalizeUsername(username);
    if (findUserByName(name)) throw fail("用户名已存在", 409);
    const user = {
      id: randomUUID(),
      username: name,
      role: "admin",
      passwordHash: hashPassword(normalizePassword(password)),
      workspaceIds: [],
      disabled: false,
    };
    state.users.push(user);
    persist();
    return publicUser(user);
  };

  if (String(adminPassword || "") && !state.users.some((user) => user.role === "admin")) {
    createAdmin({ username: adminUser, password: adminPassword });
  }

  return {
    file,
    hasAdmin() {
      return state.users.some((user) => user.role === "admin");
    },
    createAdmin,
    login(username, password) {
      const user = findUserByName(username);
      const matches = passwordMatches(String(password || ""), user?.passwordHash || dummyPasswordHash);
      if (!user || user.disabled || !matches) return null;
      return publicUser(user);
    },
    user(id) {
      const user = findUserById(String(id || ""));
      return user ? publicUser(user) : null;
    },
    users() {
      return state.users.map(publicUser);
    },
    workspace(id) {
      const workspace = findWorkspace(String(id || ""));
      return workspace ? publicWorkspace(workspace) : null;
    },
    workspaces() {
      return state.workspaces.map(publicWorkspace);
    },
    browserProfile() {
      return structuredClone(state.browserProfile);
    },
    setBrowserProfile(profile) {
      const normalized = normalizeBrowserProfile(profile);
      if (!normalized.configured) throw fail("浏览器环境设置不完整");
      state.browserProfile = normalized;
      persist();
      return structuredClone(state.browserProfile);
    },
    composerToolAllowlist() {
      return [...state.composerToolAllowlist];
    },
    setComposerToolAllowlist(raw) {
      const names = normalizeComposerToolAllowlist(raw);
      state.composerToolAllowlist = names;
      persist();
      return [...state.composerToolAllowlist];
    },
    sensitivePolicy() {
      return structuredClone(state.sensitivePolicy);
    },
    setSensitivePolicy(patch = {}) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw fail("敏感操作黑名单结构无效");
      const next = normalizeSensitivePolicy({
        ...state.sensitivePolicy,
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      state.sensitivePolicy = next;
      persist();
      return structuredClone(state.sensitivePolicy);
    },
    workspacesFor(user) {
      if (!user || user.disabled) return [];
      if (user.role === "admin") return state.workspaces.map(publicWorkspace);
      const allowed = new Set(user.workspaceIds || []);
      return state.workspaces.filter((workspace) => allowed.has(workspace.id)).map(publicWorkspace);
    },
    canOpen(user, workspaceId) {
      if (!user || user.disabled || !findWorkspace(workspaceId)) return false;
      return user.role === "admin" || (user.workspaceIds || []).includes(workspaceId);
    },
    previewChatGptProjects(projects) {
      return buildChatGptProjectPreview(projects, state);
    },
    importChatGptProjects(projects, rawProjectIds) {
      if (!Array.isArray(rawProjectIds) || !rawProjectIds.length) throw fail("请选择要导入的 Project");
      const projectIds = rawProjectIds.map((value) => String(value || "").trim());
      if (projectIds.some((id) => !CHATGPT_PROJECT_ID_RE.test(id))) throw fail("待导入 Project 标识无效");
      if (new Set(projectIds).size !== projectIds.length) throw fail("待导入 Project 不能重复");

      const preview = buildChatGptProjectPreview(projects, state);
      const byId = new Map(preview.map((project) => [project.projectId, project]));
      const selected = projectIds.map((id) => byId.get(id));
      if (selected.some((project) => !project)) throw fail("待导入 Project 已不在当前列表中", 409);
      const blocked = selected.find((project) => project.status !== "ready");
      if (blocked) throw fail(`${blocked.name || blocked.projectId}：${blocked.reason || "当前不可导入"}`, 409);

      const now = new Date().toISOString();
      const workspaces = selected.map((project) => ({
        id: project.workspaceId,
        name: project.name,
        startUrl: project.startUrl,
        lastUrl: project.startUrl,
        createdAt: now,
        updatedAt: now,
      }));
      const users = selected.map((project) => ({
        id: randomUUID(),
        username: project.name,
        role: "member",
        passwordHash: hashPassword(project.name),
        workspaceIds: [project.workspaceId],
        disabled: false,
      }));
      const previous = state;
      state = {
        ...state,
        workspaces: [...state.workspaces, ...workspaces],
        users: [...state.users, ...users],
      };
      try {
        persist();
      } catch (error) {
        state = previous;
        throw error;
      }
      return {
        workspaces: workspaces.map(publicWorkspace),
        users: users.map(publicUser),
      };
    },
    createWorkspace({ id, name, startUrl }) {
      const workspaceId = normalizeWorkspaceId(id);
      if (findWorkspace(workspaceId)) throw fail("工作区 ID 已存在", 409);
      const now = new Date().toISOString();
      const url = normalizeChatGptUrl(startUrl);
      const workspace = {
        id: workspaceId,
        name: normalizeWorkspaceName(name),
        startUrl: url,
        lastUrl: url,
        createdAt: now,
        updatedAt: now,
      };
      state.workspaces.push(workspace);
      persist();
      return publicWorkspace(workspace);
    },
    updateWorkspace(id, patch = {}) {
      const workspace = findWorkspace(String(id || ""));
      if (!workspace) throw fail("工作区不存在", 404);
      const next = { ...workspace };
      if (Object.hasOwn(patch, "name")) next.name = normalizeWorkspaceName(patch.name);
      if (Object.hasOwn(patch, "startUrl")) {
        next.startUrl = normalizeChatGptUrl(patch.startUrl);
        next.lastUrl = next.startUrl;
      }
      next.updatedAt = new Date().toISOString();
      Object.assign(workspace, next);
      persist();
      return publicWorkspace(workspace);
    },
    recordLastUrl(id, rawUrl) {
      const workspace = findWorkspace(String(id || ""));
      if (!workspace) return false;
      let url;
      try {
        url = normalizeChatGptUrl(rawUrl);
      } catch {
        return false;
      }
      if (workspace.lastUrl === url) return false;
      workspace.lastUrl = url;
      workspace.updatedAt = new Date().toISOString();
      persist();
      return true;
    },
    removeWorkspace(id) {
      const workspaceId = String(id || "");
      const index = state.workspaces.findIndex((workspace) => workspace.id === workspaceId);
      if (index < 0) throw fail("工作区不存在", 404);
      const [workspace] = state.workspaces.splice(index, 1);
      for (const user of state.users) {
        user.workspaceIds = user.workspaceIds.filter((value) => value !== workspaceId);
      }
      persist();
      return publicWorkspace(workspace);
    },
    createUser({ username, password, workspaceIds = [] }) {
      const name = normalizeUsername(username);
      if (findUserByName(name)) throw fail("用户名已存在", 409);
      const user = {
        id: randomUUID(),
        username: name,
        role: "member",
        passwordHash: hashPassword(normalizePassword(password)),
        workspaceIds: normalizeWorkspaceIds(workspaceIds, knownWorkspaceIds()),
        disabled: false,
      };
      state.users.push(user);
      persist();
      return publicUser(user);
    },
    updateUser(id, patch = {}) {
      const user = findUserById(String(id || ""));
      if (!user) throw fail("用户不存在", 404);
      const next = { ...user, workspaceIds: [...user.workspaceIds] };
      if (Object.hasOwn(patch, "workspaceIds")) {
        if (user.role === "admin") throw fail("管理员自动拥有所有工作区，无需分配");
        next.workspaceIds = normalizeWorkspaceIds(patch.workspaceIds, knownWorkspaceIds());
      }
      if (Object.hasOwn(patch, "password")) {
        next.passwordHash = hashPassword(normalizePassword(patch.password));
      }
      if (Object.hasOwn(patch, "disabled")) {
        if (user.role === "admin") throw fail("不能停用管理员");
        next.disabled = !!patch.disabled;
      }
      Object.assign(user, next);
      persist();
      return publicUser(user);
    },
    removeUser(id) {
      const userId = String(id || "");
      const user = findUserById(userId);
      if (!user) throw fail("用户不存在", 404);
      if (user.role === "admin") throw fail("不能删除管理员");
      state.users = state.users.filter((candidate) => candidate.id !== userId);
      persist();
      return publicUser(user);
    },
  };
}
