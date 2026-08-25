import { attachNativeTextInput, remoteModifiers, shouldForwardKey } from "./text-input.js";

const app = globalThis.document?.querySelector("#app") || null;
const IN_PAGE_NOTICE_MS = 5000;
const VIEWER_REPLACED_CLOSE_CODE = 4000;

const icon = () => node("span", { class: "brand-mark", "aria-hidden": "true" }, "✦");

function node(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "class") element.className = value;
    else if (key === "checked" || key === "disabled" || key === "required") element[key] = !!value;
    else if (value != null) element.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function toolbarIcon(paths) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "viewer-toolbar-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function replace(...children) {
  app.replaceChildren(...children);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function lines(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function uploadFile(url, file, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.setRequestHeader("x-gpc-file-name", encodeURIComponent(file.name));
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener("load", () => {
      const body = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `上传失败（${xhr.status}）`));
    });
    xhr.addEventListener("error", () => reject(new Error("上传连接中断")));
    xhr.addEventListener("abort", () => reject(new Error("上传已取消")));
    xhr.send(file);
  });
}

function field(label, input) {
  return node("label", { class: "field" }, node("span", {}, label), input);
}

function textInput(name, placeholder, options = {}) {
  return node("input", {
    name,
    placeholder,
    autocomplete: options.autocomplete || "off",
    type: options.type || "text",
    value: options.value || "",
    required: options.required !== false,
  });
}

function button(label, options = {}) {
  return node(
    "button",
    { type: options.type || "button", class: options.class || "button", onClick: options.onClick, disabled: options.disabled },
    label,
  );
}

function message(text, kind = "error") {
  return node("p", { class: `message ${kind}`, role: kind === "error" ? "alert" : "status" }, text);
}

function operationProgress(label) {
  const status = node("span", { class: "operation-progress-status" }, "等待开始");
  const track = node(
    "span",
    {
      class: "operation-progress-track",
      role: "progressbar",
      "aria-label": `${label}进度`,
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": "0",
    },
    node("span", { class: "operation-progress-fill" }),
  );
  const element = node(
    "div",
    { class: "operation-progress", "data-state": "idle", role: "status", "aria-live": "polite", hidden: true },
    node(
      "div",
      { class: "operation-progress-heading" },
      node("span", { class: "operation-progress-name" }, node("span", { class: "operation-progress-icon", "aria-hidden": "true" }), label),
      status,
    ),
    track,
  );
  const labels = { idle: "等待开始", running: "进行中", success: "完成", error: "失败" };
  return {
    element,
    set(state, detail = "") {
      element.hidden = state === "idle";
      element.dataset.state = state;
      status.textContent = detail ? `${labels[state]} · ${detail}` : labels[state];
      if (state === "idle") track.setAttribute("aria-valuenow", "0");
      else if (state === "success") track.setAttribute("aria-valuenow", "100");
      else track.removeAttribute("aria-valuenow");
    },
  };
}

function shell(title, subtitle, content, actions = []) {
  return node(
    "div",
    { class: "page-shell" },
    node(
      "header",
      { class: "topbar" },
      node("a", { class: "brand", href: "/" }, icon(), node("span", {}, "GPT Pro")),
      actions.length ? node("nav", { class: "top-actions" }, actions) : null,
    ),
    node(
      "section",
      { class: "page-heading" },
      node("h1", {}, title),
      subtitle ? node("p", {}, subtitle) : null,
    ),
    content,
  );
}

function renderHome() {
  document.title = "GPT Pro";
  const input = textInput("workspace", "例如 test", { autocomplete: "off" });
  const errorSlot = node("div");
  const form = node(
    "form",
    {
      class: "entry-form",
      onSubmit: (event) => {
        event.preventDefault();
        const id = input.value.trim().toLowerCase();
        if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(id)) {
          errorSlot.replaceChildren(message("请输入有效的工作区 ID。"));
          return;
        }
        location.assign(`/w/${encodeURIComponent(id)}/`);
      },
    },
    field("工作区 ID", input),
    button("进入工作区", { type: "submit" }),
    errorSlot,
  );
  const content = node("section", { class: "card" }, form);
  replace(shell("打开工作区", "", content));
  input.focus();
}

function renderAuth({ admin = false, setup = false, workspace = null }) {
  document.title = admin ? "GPT Pro" : workspace.name;
  const username = textInput("username", "用户名", { autocomplete: "username" });
  const password = textInput("password", setup ? "非空密码" : "密码", {
    type: "password",
    autocomplete: setup ? "new-password" : "current-password",
  });
  const feedback = node("div");
  const submit = button(setup ? "创建管理员" : "登录", { type: "submit" });
  const endpoint = admin ? (setup ? "/admin/setup" : "/admin/login") : `/w/${workspace.id}/login`;
  const form = node(
    "form",
    {
      class: "auth-form",
      onSubmit: async (event) => {
        event.preventDefault();
        feedback.replaceChildren();
        submit.disabled = true;
        try {
          await request(endpoint, {
            method: "POST",
            body: JSON.stringify({ username: username.value, password: password.value }),
          });
          location.reload();
        } catch (error) {
          feedback.replaceChildren(message(error.message));
          submit.disabled = false;
        }
      },
    },
    field("用户名", username),
    field("密码", password),
    submit,
    feedback,
  );
  const title = setup ? "初始化管理员" : admin ? "管理员登录" : workspace.name;
  const subtitle = setup ? "请先在可信内网完成初始化，再开放远程入口。" : "";
  replace(
    shell(
      title,
      subtitle,
      node("section", { class: "card auth-card" }, form),
      admin ? [] : [node("a", { class: "text-link", href: "/" }, "其它工作区")],
    ),
  );
  username.focus();
}

async function renderAdmin() {
  document.title = "GPT Pro";
  let bootstrap;
  try {
    bootstrap = await request("/admin/api/bootstrap");
  } catch (error) {
    replace(message(error.message));
    return;
  }
  if (!bootstrap.authenticated) {
    renderAuth({ admin: true, setup: bootstrap.setupNeeded });
    return;
  }

  const state = await request("/admin/api/state");
  const feedback = node("div", { class: "global-feedback" });
  const show = (text, kind = "error") => feedback.replaceChildren(message(text, kind));
  const refresh = () => renderAdmin().catch((error) => replace(message(error.message)));

  const profile = state.browserProfile;
  const profileTimezone = textInput("timezone", "例如 Asia/Shanghai", { value: profile.timezone });
  const profileLocale = textInput("locale", "例如 zh-CN", { value: profile.locale });
  const saveProfile = button("保存并应用", { class: "button small" });
  const detectProfile = button("按出口 IP 重新探测", { class: "button small ghost" });
  const verifyProfile = button("核验当前页面", { class: "button small ghost" });
  saveProfile.addEventListener("click", async () => {
    saveProfile.disabled = true;
    try {
      const result = await request("/admin/api/browser-profile", {
        method: "PATCH",
        body: JSON.stringify({ timezone: profileTimezone.value, locale: profileLocale.value }),
      });
      show(
        result.runtimePending
          ? "设置已保存；未连接的页面会在恢复后自动应用。"
          : `已统一应用到 ${result.runtime.appliedTargets} 个浏览器页面并刷新。`,
        "success",
      );
      setTimeout(refresh, 700);
    } catch (error) {
      show(error.message);
      saveProfile.disabled = false;
    }
  });
  detectProfile.addEventListener("click", async () => {
    detectProfile.disabled = true;
    try {
      const result = await request("/admin/api/browser-profile/detect", { method: "POST" });
      show(
        result.detected
          ? `已按 Chromium 实际出口自动设置 ${result.profile.timezone} / ${result.profile.locale}。`
          : result.warning,
        result.detected ? "success" : "error",
      );
      setTimeout(refresh, result.detected ? 700 : 1400);
    } catch (error) {
      show(error.message);
      detectProfile.disabled = false;
    }
  });
  verifyProfile.addEventListener("click", async () => {
    verifyProfile.disabled = true;
    try {
      const result = await request("/admin/api/browser-profile/verify");
      show(
        result.consistent
          ? `已核验 ${result.matchingPages}/${result.pages} 个页面：时区、locale、语言列表和 Client Hints 一致。`
          : `仅 ${result.matchingPages}/${result.pages} 个页面与持久化设置一致，请重新保存或检查 Chromium 连接。`,
        result.consistent ? "success" : "error",
      );
    } catch (error) {
      show(error.message);
    } finally {
      verifyProfile.disabled = false;
    }
  });
  const profileSources = {
    ip: "Chromium 出口 IP 自动探测",
    environment: "部署环境值",
    manual: "管理员手动设置",
    unset: "尚未设置",
  };
  const profileMeta = profile.configured
    ? `来源：${profileSources[profile.source] || profile.source} · 语言列表：${profile.languages.join(", ")} · Accept-Language：${profile.acceptLanguage}`
    : "首次启动会自动探测；失败时使用部署环境值。";
  const profilePanel = node(
    "section",
    { class: "admin-section" },
    node("h2", {}, "浏览器环境"),
    node(
      "p",
      { class: "muted" },
      "应用于所有工作区和管理员浏览器，保存后统一刷新。",
    ),
    node(
      "article",
      { class: "item-card" },
      node("div", { class: "form-grid" }, field("IANA 时区", profileTimezone), field("BCP 47 浏览器语言", profileLocale)),
      node("p", { class: "muted compact" }, profileMeta),
      profile.detectedAt
        ? node("p", { class: "muted compact" }, `上次自动探测：${new Date(profile.detectedAt).toLocaleString()}`)
        : null,
      profile.lastDetectionError ? message(profile.lastDetectionError) : null,
      node("div", { class: "row-actions" }, saveProfile, detectProfile, verifyProfile),
    ),
  );

  const composerTools = node(
    "textarea",
    { rows: "7", spellcheck: "false" },
    state.composerToolAllowlist.join("\n"),
  );
  const saveComposerTools = button("保存并应用白名单", { class: "button small" });
  saveComposerTools.addEventListener("click", async () => {
    saveComposerTools.disabled = true;
    try {
      const result = await request("/admin/api/composer-tools", {
        method: "PATCH",
        body: JSON.stringify({ names: lines(composerTools.value) }),
      });
      show(
        result.runtimePending
          ? "白名单已保存；未连接页面会在恢复后自动应用。"
          : `白名单已应用到 ${result.runtime.appliedTargets} 个普通工作区 Target。`,
        "success",
      );
      setTimeout(refresh, 700);
    } catch (error) {
      show(error.message);
      saveComposerTools.disabled = false;
    }
  });
  const composerToolsPanel = node(
    "section",
    { class: "admin-section" },
    node("h2", {}, "普通工作区 @ / + 功能白名单"),
    node(
      "p",
      { class: "muted" },
      "按完整功能名匹配；未列出的功能不可用。Sources 只保留 Upload 与 Text input。",
    ),
    node(
      "article",
      { class: "item-card" },
      field("允许的完整功能名（每行一项，不区分大小写）", composerTools),
      node("div", { class: "row-actions" }, saveComposerTools),
    ),
  );

  const policy = state.sensitivePolicy;
  const policyEnabled = node("input", { type: "checkbox", checked: policy.enabled });
  const actionPatterns = node("textarea", { rows: "10", spellcheck: "false" }, policy.actionPatterns.join("\n"));
  const urlPatterns = node("textarea", { rows: "7", spellcheck: "false" }, policy.urlPatterns.join("\n"));
  const savePolicy = button("保存并应用黑名单", { class: "button small" });
  savePolicy.addEventListener("click", async () => {
    savePolicy.disabled = true;
    try {
      const result = await request("/admin/api/sensitive-policy", {
        method: "PATCH",
        body: JSON.stringify({
          enabled: policyEnabled.checked,
          actionPatterns: lines(actionPatterns.value),
          urlPatterns: lines(urlPatterns.value),
        }),
      });
      show(
        result.runtimePending
          ? "黑名单已保存；未连接页面会在恢复后自动应用。"
          : `黑名单已应用到 ${result.runtime.appliedTargets} 个普通工作区 Target。`,
        "success",
      );
      setTimeout(refresh, 700);
    } catch (error) {
      show(error.message);
      savePolicy.disabled = false;
    }
  });
  const policyPanel = node(
    "section",
    { class: "admin-section" },
    node("h2", {}, "普通工作区敏感操作黑名单"),
    node(
      "p",
      { class: "muted" },
      "命中项会在普通工作区隐藏并拦截；管理员浏览器不受影响。",
    ),
    node(
      "article",
      { class: "item-card" },
      node("label", { class: "check policy-toggle" }, policyEnabled, node("span", {}, "启用普通工作区黑名单")),
      node(
        "div",
        { class: "form-grid policy-grid" },
        field("页面操作文字或可访问名称（每行一条，不区分大小写）", actionPatterns),
        field("网络 URL 通配规则（每行一条，* 表示任意字符）", urlPatterns),
      ),
      node("div", { class: "row-actions" }, savePolicy),
    ),
  );

  const projectImportList = node("div", { class: "project-import-list" });
  const projectImportSummary = node("span", { class: "item-summary-meta" });
  const projectImportResults = node(
    "details",
    { class: "item-card item-details project-import-results", hidden: true },
    node(
      "summary",
      {},
      node("span", { class: "item-summary-main" }, node("strong", {}, "Projects")),
      projectImportSummary,
    ),
    node("div", { class: "item-details-body" }, projectImportList),
  );
  const importProjects = button("导入所选", { class: "button small", disabled: true });
  const readProjects = button("读取 Projects", { class: "button small ghost" });
  const readProgress = operationProgress("读取 Projects");
  const importProgress = operationProgress("导入所选");
  const updateImportButton = () => {
    importProjects.disabled = !projectImportList.querySelector('input[type="checkbox"]:checked:not(:disabled)');
  };
  const renderProjectImports = (projects) => {
    projectImportList.replaceChildren();
    projectImportResults.hidden = false;
    projectImportResults.open = false;
    projectImportSummary.textContent = `${projects.length} 个 · 可导入 ${projects.filter((project) => project.status === "ready").length} 个`;
    const statusLabels = {
      ready: "可导入",
      imported: "已存在",
      conflict: "冲突",
      invalid: "不可导入",
    };
    for (const project of projects) {
      const checkbox = node("input", {
        type: "checkbox",
        "data-project-id": project.projectId,
        "aria-label": `选择 ${project.name || "未命名 Project"}`,
        checked: project.status === "ready",
        disabled: project.status !== "ready",
      });
      checkbox.addEventListener("change", updateImportButton);
      projectImportList.append(
        node(
          "label",
          { class: "project-import-row" },
          checkbox,
          node(
            "span",
            { class: "project-import-main" },
            node("strong", {}, project.name || "未命名 Project"),
            project.workspaceId ? node("code", {}, `/w/${project.workspaceId}/`) : null,
            ["conflict", "invalid"].includes(project.status)
              ? node("p", { class: "muted compact" }, project.reason)
              : null,
          ),
          node("span", { class: `badge project-import-status ${project.status}` }, statusLabels[project.status]),
        ),
      );
    }
    if (!projects.length) projectImportList.append(node("p", { class: "muted" }, "未找到可导入的 Project。"));
    updateImportButton();
  };
  readProjects.addEventListener("click", async () => {
    readProjects.disabled = true;
    importProjects.disabled = true;
    feedback.replaceChildren();
    readProgress.set("running");
    try {
      const result = await request("/admin/api/chatgpt-projects");
      renderProjectImports(result.projects);
      readProgress.set("success", `${result.projects.length} 个`);
    } catch (error) {
      projectImportList.replaceChildren();
      projectImportResults.hidden = true;
      readProgress.set("error");
      show(error.message);
    } finally {
      readProjects.disabled = false;
    }
  });
  importProjects.addEventListener("click", async () => {
    const projectIds = [...projectImportList.querySelectorAll('input[type="checkbox"]:checked:not(:disabled)')]
      .map((input) => input.dataset.projectId);
    if (!projectIds.length) return;
    importProjects.disabled = true;
    feedback.replaceChildren();
    importProgress.set("running");
    try {
      const result = await request("/admin/api/chatgpt-projects/import", {
        method: "POST",
        body: JSON.stringify({ projectIds }),
      });
      importProgress.set("success", `${result.imported.workspaces.length} 个`);
      show(
        result.runtimePending
          ? `已导入 ${result.imported.workspaces.length} 个工作区，浏览器恢复后会自动打开。`
          : `已导入 ${result.imported.workspaces.length} 个工作区和用户。`,
        "success",
      );
      setTimeout(refresh, 1000);
    } catch (error) {
      importProgress.set("error");
      show(error.message);
      updateImportButton();
    }
  });
  const projectImportPanel = node(
    "section",
    { class: "admin-section" },
    node("h2", {}, "导入 Projects"),
    node("p", { class: "muted" }, "用户名和初始密码均使用项目名。"),
    node("div", { class: "row-actions" }, readProjects, importProjects),
    node("div", { class: "project-operation-progress" }, readProgress.element, importProgress.element),
    projectImportResults,
  );

  const adminUploadInput = node("input", { type: "file", multiple: true, class: "hidden-file-input" });
  const adminUpload = button("上传到远端文件区", { class: "button small" });
  adminUpload.addEventListener("click", () => adminUploadInput.click());
  adminUploadInput.addEventListener("change", async () => {
    const files = [...adminUploadInput.files];
    adminUploadInput.value = "";
    if (!files.length) return;
    if (files.length > 10) {
      show("一次最多选择 10 个文件");
      return;
    }
    adminUpload.disabled = true;
    try {
      let last;
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (state.transferLimits && file.size > state.transferLimits.maxFileBytes) {
          throw new Error(`${file.name} 超过单文件上限 ${formatBytes(state.transferLimits.maxFileBytes)}`);
        }
        last = await uploadFile("/admin/api/uploads", file, (progress) => {
          show(`正在上传 ${index + 1}/${files.length}：${file.name} · ${Math.round(progress * 100)}%`, "success");
        });
      }
      show(
        `已上传 ${files.length} 个文件。最后一个远端路径：${last.file.remotePath}`,
        "success",
      );
      setTimeout(refresh, 900);
    } catch (error) {
      show(error.message);
      adminUpload.disabled = false;
    }
  });
  const transferList = node("div", { class: "stack admin-item-list transfer-list" });
  for (const file of state.transfers) {
    const remove = button("删除", { class: "button small danger" });
    remove.addEventListener("click", async () => {
      if (!confirm(`删除文件“${file.name}”？`)) return;
      remove.disabled = true;
      try {
        await request(`/admin/api/transfers/${file.id}`, { method: "DELETE" });
        refresh();
      } catch (error) {
        show(error.message);
        remove.disabled = false;
      }
    });
    transferList.append(
      node(
        "details",
        { class: "item-card item-details transfer-item" },
        node(
          "summary",
          {},
          node(
            "span",
            { class: "item-summary-main" },
            node("strong", {}, file.name),
            node("span", { class: "badge" }, file.kind === "upload" ? "上传暂存" : "远端下载"),
          ),
          node("span", { class: "item-summary-meta" }, `${formatBytes(file.size || file.receivedBytes)} · ${file.state}`),
        ),
        node(
          "div",
          { class: "item-details-body" },
          file.remotePath ? node("code", { class: "remote-path" }, file.remotePath) : null,
          file.kind === "download" && file.state === "ready"
            ? node("div", { class: "row-actions" }, node("a", { class: "button small", href: `/admin/files/${file.id}` }, "保存到本机"), remove)
            : node("div", { class: "row-actions" }, remove),
        ),
      ),
    );
  }
  if (!state.transfers.length) transferList.append(node("p", { class: "muted" }, "暂无暂存上传或远端下载。"));
  const transferPanel = node(
    "section",
    { class: "admin-section" },
    node("h2", {}, "文件传输"),
    node(
      "p",
      { class: "muted" },
      state.transferLimits
        ? `单文件上限 ${formatBytes(state.transferLimits.maxFileBytes)}，总容量 ${formatBytes(state.transferLimits.quotaBytes)}。`
        : "当前部署没有启用文件传输。",
    ),
    node("div", { class: "row-actions" }, adminUpload, adminUploadInput),
    transferList,
  );

  const workspaceList = node("div", { class: "stack admin-item-list" });
  for (const workspace of state.workspaces) {
    const viewerCount = state.workspaceViewers[workspace.id] || 0;
    const presenceText = viewerCount > 1 ? `在线 · ${viewerCount} 个窗口` : viewerCount === 1 ? "在线" : "离线";
    const name = textInput("name", "名称", { value: workspace.name });
    const startUrl = textInput("startUrl", "https://chatgpt.com/…", { value: workspace.startUrl });
    const save = button("保存", { class: "button small" });
    const remove = button("删除", { class: "button small danger" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const result = await request(`/admin/api/workspaces/${workspace.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: name.value, startUrl: startUrl.value }),
        });
        show(result.runtimePending ? "配置已保存，浏览器恢复后会自动应用。" : "工作区已更新。", "success");
        refresh();
      } catch (error) {
        show(error.message);
        save.disabled = false;
      }
    });
    remove.addEventListener("click", async () => {
      if (!confirm(`删除工作区“${workspace.name}”？对应 Target 会关闭，用户授权也会移除。`)) return;
      remove.disabled = true;
      try {
        await request(`/admin/api/workspaces/${workspace.id}`, { method: "DELETE" });
        refresh();
      } catch (error) {
        show(error.message);
        remove.disabled = false;
      }
    });
    workspaceList.append(
      node(
        "details",
        { class: "item-card item-details workspace-item" },
        node(
          "summary",
          {},
          node(
            "span",
            { class: "item-summary-main" },
            node("strong", {}, workspace.name),
            node("code", {}, workspace.id),
          ),
          node(
            "span",
            {
              class: "workspace-presence",
              "data-state": viewerCount > 0 ? "online" : "offline",
              title: viewerCount > 0 ? `${viewerCount} 个普通用户窗口已连接` : "没有普通用户窗口连接",
            },
            presenceText,
          ),
        ),
        node(
          "div",
          { class: "item-details-body" },
          node("div", { class: "form-grid" }, field("名称", name), field("起始 / 项目地址", startUrl)),
          workspace.lastUrl && workspace.lastUrl !== workspace.startUrl
            ? node("p", { class: "muted compact" }, `最后页面：${workspace.lastUrl}`)
            : null,
          node(
            "div",
            { class: "row-actions" },
            node("a", { class: "button small ghost", href: `/w/${workspace.id}/`, target: "_blank", rel: "noopener" }, "打开"),
            save,
            remove,
          ),
        ),
      ),
    );
  }

  const newWorkspaceId = textInput("id", "例如 test");
  const newWorkspaceName = textInput("name", "例如 测试");
  const newWorkspaceUrl = textInput("startUrl", "https://chatgpt.com/", { value: "https://chatgpt.com/" });
  const createWorkspace = node(
    "form",
    {
      class: "inline-create workspace-create",
      onSubmit: async (event) => {
        event.preventDefault();
        const submit = event.submitter;
        submit.disabled = true;
        try {
          await request("/admin/api/workspaces", {
            method: "POST",
            body: JSON.stringify({
              id: newWorkspaceId.value,
              name: newWorkspaceName.value,
              startUrl: newWorkspaceUrl.value,
            }),
          });
          refresh();
        } catch (error) {
          show(error.message);
          submit.disabled = false;
        }
      },
    },
    field("工作区 ID", newWorkspaceId),
    field("显示名称", newWorkspaceName),
    field("ChatGPT 项目地址", newWorkspaceUrl),
    button("新增工作区", { type: "submit" }),
  );

  const userList = node("div", { class: "stack admin-item-list" });
  for (const user of state.users) {
    const assignments = node("div", { class: "checks" });
    for (const workspace of state.workspaces) {
      const checkbox = node("input", {
        type: "checkbox",
        value: workspace.id,
        checked: user.role === "admin" || user.workspaceIds.includes(workspace.id),
        disabled: user.role === "admin",
      });
      assignments.append(node("label", { class: "check" }, checkbox, node("span", {}, workspace.name)));
    }
    const password = textInput("password", "留空则不修改", { type: "password", required: false, autocomplete: "new-password" });
    const disabled = node("input", { type: "checkbox", checked: user.disabled, disabled: user.role === "admin" });
    const save = button(user.role === "admin" ? "更新密码" : "保存权限", { class: "button small" });
    const kick = button("断开会话", { class: "button small ghost" });
    const remove = button("删除用户", { class: "button small danger", disabled: user.role === "admin" });
    save.addEventListener("click", async () => {
      const workspaceIds = [...assignments.querySelectorAll("input:checked")].map((input) => input.value);
      const body = user.role === "admin" ? {} : { workspaceIds, disabled: disabled.checked };
      if (password.value) body.password = password.value;
      if (user.role === "admin" && !body.password) {
        show("请输入新的管理员密码。");
        return;
      }
      save.disabled = true;
      try {
        await request(`/admin/api/users/${user.id}`, { method: "PATCH", body: JSON.stringify(body) });
        show(user.role === "admin" ? "管理员密码已更新，请重新登录。" : "用户权限已保存，旧会话已撤销。", "success");
        if (user.role === "admin") setTimeout(refresh, 700);
        else refresh();
      } catch (error) {
        show(error.message);
        save.disabled = false;
      }
    });
    kick.addEventListener("click", async () => {
      try {
        const result = await request(`/admin/api/users/${user.id}/kick`, { method: "POST" });
        show(`已撤销 ${result.sessions} 个会话并断开 ${result.sockets} 个窗口。`, "success");
      } catch (error) {
        show(error.message);
      }
    });
    remove.addEventListener("click", async () => {
      if (!confirm(`删除用户“${user.username}”？`)) return;
      try {
        await request(`/admin/api/users/${user.id}`, { method: "DELETE" });
        refresh();
      } catch (error) {
        show(error.message);
      }
    });
    userList.append(
      node(
        "details",
        { class: "item-card item-details" },
        node(
          "summary",
          {},
          node(
            "span",
            { class: "item-summary-main" },
            node("strong", {}, user.username),
            node("span", { class: "badge" }, user.role === "admin" ? "管理员" : user.disabled ? "已停用" : "用户"),
          ),
          node(
            "span",
            { class: "item-summary-meta" },
            `${user.role === "admin" ? state.workspaces.length : user.workspaceIds.length} 个工作区`,
          ),
        ),
        node(
          "div",
          { class: "item-details-body" },
          node("label", { class: "check" }, disabled, node("span", {}, "停用")),
          node("p", { class: "label-line" }, "可访问工作区"),
          assignments,
          field("新密码", password),
          node("div", { class: "row-actions" }, save, kick, remove),
        ),
      ),
    );
  }

  const newUsername = textInput("username", "用户名", { autocomplete: "off" });
  const newPassword = textInput("password", "非空密码", { type: "password", autocomplete: "new-password" });
  const newAssignments = node("div", { class: "checks" });
  for (const workspace of state.workspaces) {
    newAssignments.append(
      node(
        "label",
        { class: "check" },
        node("input", { type: "checkbox", value: workspace.id }),
        node("span", {}, workspace.name),
      ),
    );
  }
  const createUser = node(
    "form",
    {
      class: "inline-create user-create",
      onSubmit: async (event) => {
        event.preventDefault();
        const submit = event.submitter;
        submit.disabled = true;
        const workspaceIds = [...newAssignments.querySelectorAll("input:checked")].map((input) => input.value);
        try {
          await request("/admin/api/users", {
            method: "POST",
            body: JSON.stringify({ username: newUsername.value, password: newPassword.value, workspaceIds }),
          });
          refresh();
        } catch (error) {
          show(error.message);
          submit.disabled = false;
        }
      },
    },
    field("用户名", newUsername),
    field("密码", newPassword),
    node("div", { class: "field wide" }, node("span", {}, "初始权限"), newAssignments),
    button("新增用户", { type: "submit" }),
  );

  const logout = button("登出", {
    class: "button small ghost",
    onClick: async () => {
      try {
        await request("/admin/logout", { method: "POST" });
        location.reload();
      } catch (error) {
        show(error.message);
      }
    },
  });
  const browserState = state.browser.connected
    ? "浏览器已连接"
    : "浏览器正在连接";
  const systemPanel = node(
    "section",
    { class: "admin-system-panel" },
    node(
      "div",
      { class: "admin-system-state" },
      node("span", { class: state.browser.connected ? "dot online" : "dot" }),
      node(
        "div",
        { class: "admin-system-copy" },
        node("strong", {}, browserState),
        node(
          "span",
          { class: "admin-system-metrics" },
          node("span", {}, `工作区 ${state.browser.targets}/${state.browser.workspaces}`),
          node("span", {}, `在线窗口 ${state.browser.viewers}`),
        ),
      ),
    ),
    node(
      "div",
      { class: "admin-system-actions" },
      node(
        "a",
        { class: "button small", href: "/admin/maintenance/", target: "_blank", rel: "noopener noreferrer" },
        "打开管理员浏览器",
      ),
      logout,
    ),
  );
  const content = node(
    "div",
    { class: "admin-layout" },
    feedback,
    systemPanel,
    projectImportPanel,
    profilePanel,
    composerToolsPanel,
    policyPanel,
    node("section", { class: "admin-section" }, node("h2", {}, "工作区"), createWorkspace, workspaceList),
    node("section", { class: "admin-section" }, node("h2", {}, "用户与密码"), createUser, userList),
    transferPanel,
  );
  replace(shell("管理", "", content));
}

function pointerButton(number) {
  return ["left", "middle", "right", "back", "forward"][number] || "none";
}

function pressedPointerButton(buttons) {
  if (buttons & 1) return "left";
  if (buttons & 2) return "right";
  if (buttons & 4) return "middle";
  if (buttons & 8) return "back";
  if (buttons & 16) return "forward";
  return "none";
}

function renderViewer(workspace, fileTransfer = { enabled: false }) {
  document.title = workspace.name;
  const macOS = navigator.platform === "MacIntel";
  const viewerId = globalThis.crypto.randomUUID();
  let socket;
  let intentionalClose = false;
  let reconnects = 0;
  let reconnectTimer = null;
  let takeover = true;
  let viewport = { width: 1440, height: 900 };
  let drawingFrame = false;
  let pendingFrame = null;
  let controlPanel;
  let menuToggle;
  let transferPanel;
  let confirmSelection;
  let fileSelection = { active: false, mode: "selectSingle", requestId: "" };
  const selectedUploadIds = new Set();
  let pointerSequence = 0;
  let pointerDown = false;
  let pointerEditable = null;
  let setPanelOpen = () => {};
  const statusText = node("span", { class: "viewer-status-text" }, "正在连接…");
  const status = node(
    "span",
    { class: "viewer-status", role: "status", "aria-live": "polite", title: "正在连接…" },
    node("span", { class: "viewer-status-icon", "aria-hidden": "true" }),
    statusText,
  );
  const canvas = node("canvas", { class: "screen", width: viewport.width, height: viewport.height, tabindex: "0" });
  const stage = node("div", { class: "screen-stage" }, canvas);
  const notificationTitle = node("strong");
  const notificationBody = node("span");
  let noticeTimer = null;
  const dismissNotice = () => {
    clearTimeout(noticeTimer);
    noticeTimer = null;
    notificationNotice.hidden = true;
    document.title = workspace.name;
  };
  const notificationNotice = node(
    "button",
    {
      type: "button",
      class: "viewer-notification",
      hidden: true,
      "aria-live": "assertive",
      onClick: dismissNotice,
    },
    notificationTitle,
    notificationBody,
    node("span", { class: "viewer-notification-close" }, "关闭"),
  );
  const showInPageNotice = (title, body) => {
    clearTimeout(noticeTimer);
    notificationTitle.textContent = title;
    notificationBody.textContent = body;
    notificationNotice.hidden = false;
    document.title = `● ${workspace.name}`;
    noticeTimer = setTimeout(dismissNotice, IN_PAGE_NOTICE_MS);
  };
  const deliverNotice = (title, body) => {
    const BrowserNotification = globalThis.Notification;
    if (!BrowserNotification || BrowserNotification.permission !== "granted") {
      showInPageNotice(title, body);
      return;
    }
    try {
      const systemNotice = new BrowserNotification(title, { body });
      systemNotice.addEventListener(
        "click",
        () => {
          globalThis.focus();
          systemNotice.close();
        },
        { once: true },
      );
      systemNotice.addEventListener("error", () => showInPageNotice(title, body), { once: true });
    } catch {
      showInPageNotice(title, body);
    }
  };
  const keyCapture = node("textarea", {
    class: "key-capture",
    "aria-label": "键盘输入",
    autocapitalize: "off",
    autocomplete: "off",
    inputmode: "text",
    spellcheck: "false",
  });
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#f7f7f7";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const send = (payload) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  };
  const nativeInput = attachNativeTextInput({
    input: keyCapture,
    commitText: (text, { paste = false } = {}) =>
      send({ type: "text", text, ...(paste ? { paste: true } : {}) }),
  });

  const sendViewerState = () => {
    send({
      type: "viewerState",
      visible: document.visibilityState === "visible",
    });
  };

  const showReplacedPage = () => {
    intentionalClose = true;
    clearTimeout(reconnectTimer);
    clearTimeout(noticeTimer);
    document.removeEventListener("visibilitychange", sendViewerState);
    nativeInput.blur();
    replace(
      shell(
        "当前窗口已停止",
        "此用户已在其他窗口打开工作区，本窗口已停止画面与输入。",
        node(
          "section",
          { class: "card auth-card" },
          node("p", { class: "muted" }, "如需在这里继续，重新载入后会接管另一个窗口。"),
          button("在此窗口继续", { onClick: () => location.reload() }),
        ),
      ),
    );
  };

  const setStatus = (text, state = "") => {
    statusText.textContent = text;
    status.dataset.state = state;
    status.title = text;
    if (menuToggle) {
      menuToggle.dataset.state = state;
      menuToggle.title = text;
    }
    if (state === "error" && controlPanel && (!transferPanel || transferPanel.hidden)) setPanelOpen(true);
  };
  const requestBrowserNotifications = () => {
    const BrowserNotification = globalThis.Notification;
    if (
      !globalThis.isSecureContext ||
      !BrowserNotification ||
      BrowserNotification.permission !== "default"
    ) {
      return;
    }
    BrowserNotification.requestPermission().then((permission) => {
      setStatus(
        permission === "granted" ? "浏览器通知已开启" : "浏览器未允许通知，将使用页面提醒",
        permission === "granted" ? "online" : "",
      );
    });
  };

  const drawNewestFrame = async (blob) => {
    pendingFrame = blob;
    if (drawingFrame) return;
    drawingFrame = true;
    try {
      while (pendingFrame) {
        const current = pendingFrame;
        pendingFrame = null;
        const bitmap = await createImageBitmap(current);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
      }
    } catch {
      setStatus("画面解码失败，等待下一帧…", "error");
    } finally {
      drawingFrame = false;
    }
  };

  const connect = () => {
    clearTimeout(reconnectTimer);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const currentSocket = new WebSocket(
      `${protocol}//${location.host}/w/${workspace.id}/socket?viewer=${viewerId}&takeover=${takeover ? "1" : "0"}`,
    );
    takeover = false;
    socket = currentSocket;
    currentSocket.binaryType = "blob";
    currentSocket.addEventListener("open", () => {
      if (socket !== currentSocket) return;
      reconnects = 0;
      setStatus("已连接", "online");
      const rect = stage.getBoundingClientRect();
      send({ type: "resize", width: Math.round(rect.width), height: Math.round(rect.height) });
      sendViewerState();
    });
    currentSocket.addEventListener("message", async (event) => {
      if (socket !== currentSocket) return;
      if (typeof event.data === "string") {
        const payload = JSON.parse(event.data);
        if (payload.type === "viewport") {
          viewport = { width: payload.width, height: payload.height };
          canvas.width = viewport.width;
          canvas.height = viewport.height;
        } else if (payload.type === "status") {
          const labels = { connected: "已连接", connecting: "正在连接浏览器…", reconnecting: "浏览器重连中…" };
          setStatus(payload.message || labels[payload.state] || payload.state, payload.state === "connected" ? "online" : "");
        } else if (payload.type === "error") {
          if (confirmSelection && fileSelection.active) confirmSelection.disabled = !selectedUploadIds.size;
          setStatus(payload.message || "输入失败", "error");
        } else if (payload.type === "policy-blocked") {
          setStatus(payload.message || "敏感操作已拦截", "error");
        } else if (payload.type === "file-chooser") {
          fileSelection = {
            active: true,
            mode: payload.mode === "selectMultiple" ? "selectMultiple" : "selectSingle",
            requestId: String(payload.requestId || ""),
          };
          selectedUploadIds.clear();
          setStatus("请选择私人文件");
          openTransferPanel(true).catch((error) => setStatus(error.message, "error"));
        } else if (payload.type === "files-selected") {
          if (payload.requestId !== fileSelection.requestId) return;
          fileSelection.active = false;
          fileSelection.requestId = "";
          selectedUploadIds.clear();
          transferPanel.hidden = true;
          setStatus(`已选择：${payload.files.map((file) => file.name).join("、")}`, "online");
          if (pointerEditable === true) nativeInput.focus();
        } else if (payload.type === "file-selection-cancelled") {
          if (payload.requestId !== fileSelection.requestId) return;
          fileSelection.active = false;
          fileSelection.requestId = "";
          selectedUploadIds.clear();
          transferPanel.hidden = true;
          setStatus("文件选择已取消");
        } else if (payload.type === "download") {
          refreshTransfers().catch((error) => setStatus(error.message, "error"));
          if (payload.file.state === "ready") {
            deliverNotice("下载完成", `${payload.file.name} 已保存到私人文件区`);
          } else if (payload.file.state === "failed") {
            deliverNotice("下载失败", `${payload.file.name}：${payload.file.error}`);
          }
        } else if (payload.type === "clipboard") {
          if (!nativeInput.copyClipboardText(payload.text)) setStatus("本机浏览器拒绝写入剪贴板", "error");
        } else if (payload.type === "notification") {
          deliverNotice(payload.title || "ChatGPT 通知", payload.body);
        } else if (payload.type === "selection") {
          nativeInput.setSelectionText(payload.text);
        } else if (payload.type === "input-target" && payload.sequence === pointerSequence) {
          pointerEditable = payload.editable === true;
          if (!pointerDown) {
            if (pointerEditable === true) nativeInput.focus();
            else nativeInput.blur();
          }
        }
        return;
      }
      drawNewestFrame(event.data);
    });
    currentSocket.addEventListener("close", async (event) => {
      if (socket !== currentSocket) return;
      if (event.code === VIEWER_REPLACED_CLOSE_CODE) {
        showReplacedPage();
        return;
      }
      if (intentionalClose) return;
      setStatus("连接中断，正在重试…", "error");
      reconnects += 1;
      if (reconnects >= 3) {
        try {
          const bootstrap = await request(`/w/${workspace.id}/api/bootstrap`);
          if (!bootstrap.authenticated) {
            location.reload();
            return;
          }
        } catch (error) {
          setStatus(`连接中断，状态检查失败：${error.message}`, "error");
        }
      }
      reconnectTimer = setTimeout(connect, Math.min(5000, 700 * reconnects));
    });
    currentSocket.addEventListener("error", () => currentSocket.close());
  };

  document.addEventListener("visibilitychange", sendViewerState);

  const position = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * canvas.width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * canvas.height),
    };
  };
  const sendPointer = (event, type) => {
    const point = position(event);
    send({
      type: "pointer",
      event: type,
      ...point,
      button: pointerButton(event.button),
      buttons: event.buttons,
      clickCount: event.detail || (type === "mousePressed" ? 1 : 0),
      modifiers: remoteModifiers(event, macOS),
      sequence: pointerSequence,
    });
  };
  let pendingPointerMove = null;
  let pointerMoveFrame = 0;
  const sendPendingPointerMove = () => {
    if (pendingPointerMove) send(pendingPointerMove);
    pendingPointerMove = null;
  };
  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    pointerSequence = (pointerSequence + 1) % 1_000_000_000;
    pointerDown = true;
    pointerEditable = null;
    canvas.setPointerCapture(event.pointerId);
    sendPointer(event, "mousePressed");
    keyCapture.style.left = `${Math.max(8, Math.min(window.innerWidth - 8, event.clientX))}px`;
    keyCapture.style.top = `${Math.max(8, Math.min(window.innerHeight - 8, event.clientY))}px`;
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!event.buttons) return;
    pendingPointerMove = {
      ...position(event),
      type: "pointer",
      event: "mouseMoved",
      button: pressedPointerButton(event.buttons),
      buttons: event.buttons,
      clickCount: 0,
      modifiers: remoteModifiers(event, macOS),
    };
    if (pointerMoveFrame) return;
    pointerMoveFrame = requestAnimationFrame(() => {
      pointerMoveFrame = 0;
      sendPendingPointerMove();
    });
  });
  canvas.addEventListener("pointerup", (event) => {
    event.preventDefault();
    pointerDown = false;
    if (pointerMoveFrame) {
      cancelAnimationFrame(pointerMoveFrame);
      pointerMoveFrame = 0;
    }
    sendPendingPointerMove();
    sendPointer(event, "mouseReleased");
    send({ type: "selection" });
    if (pointerEditable === true) nativeInput.focus();
    else if (pointerEditable === false) nativeInput.blur();
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      send({
        type: "wheel",
        ...position(event),
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: remoteModifiers(event, macOS),
      });
    },
    { passive: false },
  );

  const held = new Set();
  const selectedLocalText = () =>
    keyCapture.value.slice(keyCapture.selectionStart || 0, keyCapture.selectionEnd || 0);
  keyCapture.addEventListener("copy", () => {
    if (selectedLocalText()) setStatus("已复制到本机剪贴板", "online");
  });
  keyCapture.addEventListener("cut", () => {
    if (!selectedLocalText()) return;
    const sent = send({ type: "cut" });
    setStatus(sent ? "已剪切到本机剪贴板" : "工作区连接尚未恢复", sent ? "online" : "error");
  });
  keyCapture.addEventListener("keydown", (event) => {
    if (!shouldForwardKey(event)) return;
    event.preventDefault();
    held.add(event.code);
    send({
      type: "key",
      event: "keyDown",
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      text: event.key === "Enter" ? "\r" : "",
      modifiers: remoteModifiers(event, macOS),
      autoRepeat: event.repeat,
    });
  });
  keyCapture.addEventListener("keyup", (event) => {
    if (!held.has(event.code)) return;
    event.preventDefault();
    held.delete(event.code);
    send({
      type: "key",
      event: "keyUp",
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      modifiers: remoteModifiers(event, macOS),
    });
    if (event.shiftKey || ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase("en-US") === "a")) {
      send({ type: "selection" });
    }
  });
  transferPanel = node("aside", { class: "viewer-transfer-panel", hidden: true });
  const transferFiles = node("div", { class: "viewer-transfer-files" });
  const transferHint = node("p", { class: "muted" });
  const updateSelectionButton = () => {
    confirmSelection.disabled = !selectedUploadIds.size;
  };
  confirmSelection = button("选择文件", {
    class: "button small",
    disabled: true,
    onClick: () => {
      if (!selectedUploadIds.size) return;
      confirmSelection.disabled = true;
      if (!send({
        type: "selectFiles",
        requestId: fileSelection.requestId,
        uploadIds: [...selectedUploadIds],
      })) {
        confirmSelection.disabled = false;
        setStatus("工作区连接尚未恢复", "error");
      }
    },
  });
  const closeTransferPanel = () => {
    transferPanel.hidden = true;
    if (fileSelection.active) {
      const requestId = fileSelection.requestId;
      fileSelection.active = false;
      fileSelection.requestId = "";
      selectedUploadIds.clear();
      send({ type: "cancelFileSelection", requestId });
      setStatus("文件选择已取消");
    }
    if (pointerEditable === true) nativeInput.focus();
  };
  const closeTransfers = button("关闭", {
    class: "button small ghost",
    onClick: closeTransferPanel,
  });
  transferPanel.append(
    node(
      "div",
      { class: "item-title" },
      node("h2", {}, "私人文件"),
      node("div", { class: "row-actions" }, confirmSelection, closeTransfers),
    ),
    transferHint,
    transferFiles,
  );

  const renderTransferFiles = (files) => {
    transferFiles.replaceChildren();
    const availableUploads = new Set(
      files.filter((file) => file.kind === "upload" && file.state === "ready").map((file) => file.id),
    );
    for (const id of selectedUploadIds) {
      if (!availableUploads.has(id)) selectedUploadIds.delete(id);
    }
    const stateLabels = { ready: "可用", in_progress: "下载中", failed: "失败" };
    for (const file of files) {
      const selectable = fileSelection.active && file.kind === "upload" && file.state === "ready";
      const selector = selectable
        ? node("input", {
            type: "checkbox",
            class: "private-file-selector",
            "aria-label": `选择 ${file.name}`,
            "data-upload-id": file.id,
            checked: selectedUploadIds.has(file.id),
          })
        : null;
      selector?.addEventListener("change", () => {
        if (selector.checked && fileSelection.mode === "selectSingle") {
          selectedUploadIds.clear();
          for (const input of transferFiles.querySelectorAll(".private-file-selector")) input.checked = false;
          selector.checked = true;
        }
        if (selector.checked) selectedUploadIds.add(file.id);
        else selectedUploadIds.delete(file.id);
        updateSelectionButton();
      });
      const remove = button("删除", {
        class: "button small danger",
        onClick: async () => {
          try {
            await request(`/w/${workspace.id}/api/transfers/${file.id}`, { method: "DELETE" });
            selectedUploadIds.delete(file.id);
            await refreshTransfers();
          } catch (error) {
            setStatus(error.message, "error");
          }
        },
      });
      const actions = [];
      if (file.kind === "download" && file.state === "ready") {
        actions.push(node("a", { class: "button small", href: `/w/${workspace.id}/files/${file.id}` }, "保存到本机"));
      }
      actions.push(remove);
      transferFiles.append(
        node(
          "article",
          { class: selectable ? "transfer-row selectable" : "transfer-row" },
          selector,
          node(
            "div",
            { class: "transfer-file-info" },
            node("strong", {}, file.name),
            node(
              "span",
              { class: "muted" },
              `${file.kind === "upload" ? "私人文件" : "远端下载"} · ${formatBytes(file.size || file.receivedBytes)} · ${stateLabels[file.state] || file.state}`,
            ),
          ),
          node("div", { class: "row-actions" }, actions),
        ),
      );
    }
    if (!files.length) transferFiles.append(node("p", { class: "muted" }, "暂无文件。"));
    updateSelectionButton();
  };

  async function refreshTransfers() {
    if (!fileTransfer.enabled) return;
    const result = await request(`/w/${workspace.id}/api/transfers`);
    renderTransferFiles(result.files);
  }

  async function openTransferPanel(selecting = false) {
    if (!selecting) {
      if (fileSelection.active) {
        send({ type: "cancelFileSelection", requestId: fileSelection.requestId });
      }
      fileSelection.active = false;
      fileSelection.requestId = "";
      selectedUploadIds.clear();
    }
    controlPanel.hidden = true;
    menuToggle.setAttribute("aria-expanded", "false");
    menuToggle.setAttribute("aria-label", "打开工作区菜单");
    confirmSelection.hidden = !fileSelection.active;
    transferHint.textContent = fileSelection.active
      ? "选择要交给当前 ChatGPT 上传入口的文件。"
      : "上传文件仅保存于当前用户的私人目录；远端下载可保存到本机。";
    transferPanel.hidden = false;
    await refreshTransfers();
  }

  const uploadInput = node("input", { type: "file", multiple: true, class: "hidden-file-input" });
  const upload = button("上传文件", {
    class: "button small ghost",
    disabled: !fileTransfer.enabled,
    onClick: () => uploadInput.click(),
  });
  uploadInput.addEventListener("change", async () => {
    const files = [...uploadInput.files];
    uploadInput.value = "";
    if (!files.length) return;
    if (files.length > 10) {
      setStatus("一次最多选择 10 个文件", "error");
      return;
    }
    upload.disabled = true;
    try {
      const uploaded = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (fileTransfer.maxFileBytes && file.size > fileTransfer.maxFileBytes) {
          throw new Error(`${file.name} 超过单文件上限 ${formatBytes(fileTransfer.maxFileBytes)}`);
        }
        const result = await uploadFile(`/w/${workspace.id}/api/uploads`, file, (progress) => {
          setStatus(`上传 ${index + 1}/${files.length}：${Math.round(progress * 100)}%`, "online");
        });
        uploaded.push(result.file);
      }
      setStatus(`已保存到私人文件区：${uploaded.length} 个文件`, "online");
      await openTransferPanel(false);
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      upload.disabled = !fileTransfer.enabled;
    }
  });

  const downloads = button("查看文件", {
    class: "button small ghost",
    disabled: !fileTransfer.enabled,
    onClick: () => openTransferPanel(false).catch((error) => setStatus(error.message, "error")),
  });

  const startParts = new URL(workspace.startUrl).pathname.split("/").filter(Boolean);
  const homeButton = startParts.length === 3 && startParts[0] === "g" && startParts[2] === "project"
    ? node(
        "button",
        {
          type: "button",
          class: "viewer-toolbar-button viewer-home-button",
          title: "项目首页",
          "aria-label": "项目首页",
          onClick: () => {
            if (!send({ type: "projectHome" })) {
              setStatus("工作区连接尚未恢复", "error");
              return;
            }
            if (!transferPanel.hidden) closeTransferPanel();
            setPanelOpen(false);
          },
        },
        toolbarIcon(["M3 11.5 12 4l9 7.5", "M5 10v10h14V10", "M9 20v-6h6v6"]),
      )
    : null;
  const reloadButton = node(
    "button",
    {
      type: "button",
      class: "viewer-toolbar-button viewer-reload-button",
      title: "刷新页面",
      "aria-label": "刷新页面",
      onClick: () => send({ type: "reload" }),
    },
    toolbarIcon(["M21 12a9 9 0 0 0-15-6.7L3 8", "M3 3v5h5", "M3 12a9 9 0 0 0 15 6.7l3-2.7", "M16 16h5v5"]),
  );
  const fullscreen = button("进入全屏", {
    class: "button small ghost",
    onClick: () => app.requestFullscreen().catch((error) => setStatus(error.message, "error")),
  });
  const logout = button("退出登录", {
    class: "button small ghost",
    onClick: async () => {
      try {
        await request(`/w/${workspace.id}/logout`, { method: "POST" });
        intentionalClose = true;
        socket?.close();
        location.reload();
      } catch (error) {
        setStatus(error.message, "error");
      }
    },
  });

  controlPanel = node(
    "aside",
    { class: "viewer-control-panel", hidden: true, "aria-label": "工作区菜单" },
    node(
      "div",
      { class: "viewer-panel-heading" },
      node("div", { class: "viewer-panel-identity" }, node("strong", {}, workspace.name)),
      status,
    ),
    node(
      "div",
      { class: "viewer-panel-actions" },
      upload,
      uploadInput,
      downloads,
      fullscreen,
      logout,
    ),
  );
  let suppressMenuClick = false;
  menuToggle = node(
    "button",
    {
      type: "button",
      class: "viewer-menu-toggle",
      title: "打开工作区菜单",
      "aria-label": "打开工作区菜单",
      "aria-expanded": "false",
      onClick: () => {
        if (suppressMenuClick) {
          suppressMenuClick = false;
          return;
        }
        setPanelOpen(controlPanel.hidden);
      },
    },
    node("span", { class: "viewer-menu-icon", "aria-hidden": "true" }),
  );
  setPanelOpen = (open) => {
    if (open && !transferPanel.hidden) {
      closeTransferPanel();
    }
    controlPanel.hidden = !open;
    menuToggle.setAttribute("aria-expanded", String(open));
    menuToggle.setAttribute("aria-label", open ? "收起工作区菜单" : "打开工作区菜单");
    if (!open && pointerEditable === true) nativeInput.focus();
  };
  const toolbar = node(
    "div",
    { class: "viewer-toolbar" },
    homeButton,
    reloadButton,
    menuToggle,
    controlPanel,
    transferPanel,
  );
  const toolbarPositionKey = `gpc.viewerToolbarPosition.${workspace.id}`;
  const restoreToolbarPosition = () => {
    const [left, top] = String(localStorage.getItem(toolbarPositionKey) || "").split(",").map(Number);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
    const maxLeft = Math.max(8, window.innerWidth - toolbar.offsetWidth - 8);
    const maxTop = Math.max(8, window.innerHeight - toolbar.offsetHeight - 8);
    toolbar.style.right = "auto";
    toolbar.style.left = `${Math.min(maxLeft, Math.max(8, left))}px`;
    toolbar.style.top = `${Math.min(maxTop, Math.max(8, top))}px`;
  };
  let toolbarDrag = null;
  menuToggle.addEventListener("pointerdown", (event) => {
    const rect = toolbar.getBoundingClientRect();
    toolbarDrag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    menuToggle.setPointerCapture(event.pointerId);
  });
  menuToggle.addEventListener("pointermove", (event) => {
    if (!toolbarDrag || event.pointerId !== toolbarDrag.pointerId) return;
    const deltaX = event.clientX - toolbarDrag.x;
    const deltaY = event.clientY - toolbarDrag.y;
    if (!toolbarDrag.moved && Math.hypot(deltaX, deltaY) < 4) return;
    if (!toolbarDrag.moved) {
      toolbarDrag.moved = true;
      toolbar.style.right = "auto";
      toolbar.style.left = `${toolbarDrag.left}px`;
      toolbar.style.top = `${toolbarDrag.top}px`;
    }
    event.preventDefault();
    const maxLeft = Math.max(8, window.innerWidth - toolbar.offsetWidth - 8);
    const maxTop = Math.max(8, window.innerHeight - toolbar.offsetHeight - 8);
    toolbar.style.left = `${Math.min(maxLeft, Math.max(8, toolbarDrag.left + deltaX))}px`;
    toolbar.style.top = `${Math.min(maxTop, Math.max(8, toolbarDrag.top + deltaY))}px`;
  });
  const finishToolbarDrag = (event, canceled = false) => {
    if (!toolbarDrag || event.pointerId !== toolbarDrag.pointerId) return;
    suppressMenuClick = !canceled && toolbarDrag.moved;
    if (suppressMenuClick) {
      localStorage.setItem(toolbarPositionKey, `${toolbar.offsetLeft},${toolbar.offsetTop}`);
    }
    menuToggle.releasePointerCapture(event.pointerId);
    toolbarDrag = null;
  };
  menuToggle.addEventListener("pointerup", finishToolbarDrag);
  menuToggle.addEventListener("pointercancel", (event) => finishToolbarDrag(event, true));
  const viewer = node(
    "div",
    { class: "viewer" },
    stage,
    notificationNotice,
    toolbar,
    keyCapture,
  );
  viewer.addEventListener("click", requestBrowserNotifications, { once: true });
  replace(viewer);
  restoreToolbarPosition();

  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const rect = stage.getBoundingClientRect();
      send({ type: "resize", width: Math.round(rect.width), height: Math.round(rect.height) });
    }, 180);
  }).observe(stage);
  connect();
}

async function renderWorkspace(workspaceId) {
  document.title = workspaceId;
  try {
    const bootstrap = await request(`/w/${workspaceId}/api/bootstrap`);
    if (!bootstrap.authenticated) {
      renderAuth({ workspace: bootstrap.workspace });
      return;
    }
    renderViewer(bootstrap.workspace, bootstrap.fileTransfer);
  } catch (error) {
    replace(
      shell(
        "无法打开工作区",
        error.message,
        node("section", { class: "card auth-card" }, node("a", { class: "button", href: "/" }, "返回入口")),
      ),
    );
  }
}

async function main() {
  if (location.pathname === "/admin" || location.pathname.startsWith("/admin/")) {
    await renderAdmin();
    return;
  }
  const workspace = location.pathname.match(/^\/w\/([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)\/$/);
  if (workspace) {
    await renderWorkspace(workspace[1]);
    return;
  }
  renderHome();
}

if (app) main().catch((error) => replace(message(error.message)));
