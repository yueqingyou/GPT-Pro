import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createSessionStore } from "../lib/auth.mjs";
import { createGateway } from "../gateway/server.mjs";
import { manualBrowserProfile, normalizeBrowserProfile } from "../lib/profile.mjs";
import { createStateStore } from "../lib/store.mjs";
import { createTransferStore } from "../lib/transfers.mjs";

class FakeBroker {
  constructor() {
    this.viewers = [];
    this.commands = [];
    this.started = false;
    this.profileApplications = 0;
    this.policyApplications = 0;
    this.focusApplications = 0;
    this.maintenanceFocuses = 0;
    this.maintenanceActive = false;
    this.actors = [];
    this.ensuredWorkspaces = [];
    this.projects = [
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
  }
  status() {
    return { connected: true, workspaces: 2, targets: 2, viewers: this.viewers.length };
  }
  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
  }
  async ensureWorkspace(workspaceId) {
    this.ensuredWorkspaces.push(workspaceId);
  }
  async listChatGptProjects() {
    return structuredClone(this.projects);
  }
  async navigate() {}
  async removeWorkspace() {}
  async applyBrowserProfile() {
    this.profileApplications += 1;
    return { appliedTargets: 3, failedTargets: 0 };
  }
  async verifyBrowserProfile() {
    return { pages: 3, matchingPages: 3, consistent: true, checks: [] };
  }
  async applySensitivePolicy() {
    this.policyApplications += 1;
    return { appliedTargets: 2, failedTargets: 0 };
  }
  async applyProjectFocus() {
    this.focusApplications += 1;
    return { appliedTargets: 2, failedTargets: 0 };
  }
  async focusMaintenance() {
    this.maintenanceFocuses += 1;
  }
  async setMaintenanceActive(active) {
    this.maintenanceActive = !!active;
    if (this.maintenanceActive) await this.focusMaintenance();
  }
  async addViewer(workspaceId, socket) {
    this.viewers.push({ workspaceId, socket });
    socket.send(JSON.stringify({ type: "status", state: "connected" }));
  }
  removeViewer(workspaceId, socket) {
    this.viewers = this.viewers.filter((viewer) => viewer.workspaceId !== workspaceId || viewer.socket !== socket);
  }
  async handleCommand(workspaceId, command, actor) {
    this.commands.push({ workspaceId, command });
    this.actors.push(actor);
  }
}

function cookieOf(response) {
  return response.headers.get("set-cookie").split(";")[0];
}

async function jsonRequest(base, path, { method = "GET", cookie, body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, body: await response.json() };
}

test("同一客户端可用路径 Cookie 同时保持不同用户与 Target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gpc-api-"));
  const store = createStateStore({ file: join(directory, "state.json"), adminUser: "owner", adminPassword: "owner-password" });
  store.createWorkspace({ id: "office", name: "办公室", startUrl: "https://chatgpt.com/g/office" });
  store.createWorkspace({ id: "laboratory", name: "实验室", startUrl: "https://chatgpt.com/g/laboratory" });
  store.createUser({ username: "office-user", password: "office-password", workspaceIds: ["office"] });
  store.createUser({ username: "lab-user", password: "laboratory-password", workspaceIds: ["laboratory"] });
  store.setBrowserProfile(manualBrowserProfile({ timezone: "Asia/Shanghai", locale: "zh-CN" }));
  const sessions = createSessionStore({ file: join(directory, "sessions.json") });
  const transfers = createTransferStore({
    root: join(directory, "transfers"),
    stateFile: join(directory, "transfers.json"),
    maxFileBytes: 1024 * 1024,
    quotaBytes: 4 * 1024 * 1024,
  });
  const broker = new FakeBroker();
  const maintenanceUpstream = http.createServer((_request, response) => response.end("maintenance-ok"));
  await new Promise((resolveListen) => maintenanceUpstream.listen(0, "127.0.0.1", resolveListen));
  const maintenanceAddress = maintenanceUpstream.address();
  const gateway = createGateway({
    store,
    sessions,
    broker,
    transfers,
    webDir: join(process.cwd(), "gateway/web"),
    maintenanceTarget: `http://127.0.0.1:${maintenanceAddress.port}`,
    maintenancePublicUrl: "http://gateway.example.test:8443/",
    resolveBrowserProfile: async ({ force }) => {
      assert.equal(force, true);
      const profile = store.setBrowserProfile(
        normalizeBrowserProfile({
          mode: "auto",
          configured: true,
          timezone: "America/Los_Angeles",
          locale: "en-US",
          source: "ip",
          detectedAt: "2026-08-19T12:00:00.000Z",
          updatedAt: "2026-08-19T12:00:00.000Z",
        }),
      );
      return { profile, detected: true, warning: "" };
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    const address = await gateway.start(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;

    const unauthenticatedProjects = await jsonRequest(base, "/admin/api/chatgpt-projects");
    assert.equal(unauthenticatedProjects.response.status, 401);

    const officeLogin = await jsonRequest(base, "/w/office/login", {
      method: "POST",
      body: { username: "office-user", password: "office-password" },
    });
    const labLogin = await jsonRequest(base, "/w/laboratory/login", {
      method: "POST",
      body: { username: "lab-user", password: "laboratory-password" },
    });
    assert.equal(officeLogin.response.status, 200);
    assert.equal(labLogin.response.status, 200);
    const officeCookie = cookieOf(officeLogin.response);
    const labCookie = cookieOf(labLogin.response);
    assert.match(officeLogin.response.headers.get("set-cookie"), /Path=\/w\/office/);
    assert.match(labLogin.response.headers.get("set-cookie"), /Path=\/w\/laboratory/);
    assert.notEqual(officeCookie, labCookie);

    const office = await jsonRequest(base, "/w/office/api/bootstrap", { cookie: officeCookie });
    const laboratory = await jsonRequest(base, "/w/laboratory/api/bootstrap", { cookie: labCookie });
    assert.equal(office.body.user.username, "office-user");
    assert.equal(laboratory.body.user.username, "lab-user");
    const crossed = await jsonRequest(base, "/w/laboratory/api/bootstrap", { cookie: officeCookie });
    assert.equal(crossed.body.authenticated, false);
    const crossSite = await jsonRequest(base, "/w/office/logout", {
      method: "POST",
      cookie: officeCookie,
      headers: { origin: "https://attacker.example" },
    });
    assert.equal(crossSite.response.status, 403);

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/w/office/socket`, { headers: { cookie: officeCookie } });
    await new Promise((resolveOpen, reject) => {
      ws.once("open", resolveOpen);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "text", text: "OFFICE_ONLY" }));
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    assert.deepEqual(broker.commands[0], { workspaceId: "office", command: { type: "text", text: "OFFICE_ONLY" } });
    assert.equal(broker.actors[0].username, "office-user");
    ws.close();

    const adminLogin = await jsonRequest(base, "/admin/login", {
      method: "POST",
      body: { username: "owner", password: "owner-password" },
    });
    const adminCookie = cookieOf(adminLogin.response);
    const projectPreview = await jsonRequest(base, "/admin/api/chatgpt-projects", { cookie: adminCookie });
    assert.equal(projectPreview.response.status, 200);
    assert.deepEqual(projectPreview.body.projects.map((project) => project.status), ["ready", "ready"]);
    const importedProjects = await jsonRequest(base, "/admin/api/chatgpt-projects/import", {
      method: "POST",
      cookie: adminCookie,
      body: { projectIds: broker.projects.map((project) => project.id) },
    });
    assert.equal(importedProjects.response.status, 201);
    assert.equal(importedProjects.body.imported.workspaces.length, 2);
    assert.equal(importedProjects.body.runtime.readyTargets, 2);
    assert.equal(Object.hasOwn(importedProjects.body.imported.users[0], "password"), false);
    assert.equal(store.login("Alpha Project", "Alpha Project")?.role, "member");
    assert.equal(store.login("组合项目", "组合项目")?.role, "member");
    assert.equal(broker.ensuredWorkspaces.length, 2);
    const importedPreview = await jsonRequest(base, "/admin/api/chatgpt-projects", { cookie: adminCookie });
    assert.ok(importedPreview.body.projects.every((project) => project.status === "imported"));

    const manualProfile = await jsonRequest(base, "/admin/api/browser-profile", {
      method: "PATCH",
      cookie: adminCookie,
      body: { timezone: "Europe/Berlin", locale: "de-DE" },
    });
    assert.equal(manualProfile.response.status, 200);
    assert.equal(manualProfile.body.profile.source, "manual");
    assert.equal(manualProfile.body.profile.acceptLanguage, "de-DE,de;q=0.9,en;q=0.8");
    assert.equal(manualProfile.body.runtime.appliedTargets, 3);
    assert.equal(broker.profileApplications, 1);

    const invalidProfile = await jsonRequest(base, "/admin/api/browser-profile", {
      method: "PATCH",
      cookie: adminCookie,
      body: { timezone: "Mars/Lab", locale: "de-DE" },
    });
    assert.equal(invalidProfile.response.status, 400);
    assert.equal(broker.profileApplications, 1);

    const detectedProfile = await jsonRequest(base, "/admin/api/browser-profile/detect", {
      method: "POST",
      cookie: adminCookie,
    });
    assert.equal(detectedProfile.response.status, 200);
    assert.equal(detectedProfile.body.detected, true);
    assert.equal(detectedProfile.body.profile.source, "ip");
    assert.equal(detectedProfile.body.profile.timezone, "America/Los_Angeles");
    assert.equal(broker.profileApplications, 2);

    const verifiedProfile = await jsonRequest(base, "/admin/api/browser-profile/verify", { cookie: adminCookie });
    assert.equal(verifiedProfile.response.status, 200);
    assert.equal(verifiedProfile.body.consistent, true);
    assert.equal(verifiedProfile.body.matchingPages, 3);

    const stateResponse = await jsonRequest(base, "/admin/api/state", { cookie: adminCookie });
    assert.equal(stateResponse.body.browserProfile.locale, "en-US");
    assert.equal(Object.hasOwn(stateResponse.body.browserProfile, "ip"), false);
    assert.deepEqual(stateResponse.body.composerToolAllowlist, [
      "Add photos & files",
      "Create image",
      "Web search",
      "Deep research",
    ]);
    const composerTools = await jsonRequest(base, "/admin/api/composer-tools", {
      method: "PATCH",
      cookie: adminCookie,
      body: { names: ["Deep research", "GitHub"] },
    });
    assert.equal(composerTools.response.status, 200);
    assert.deepEqual(composerTools.body.names, ["Deep research", "GitHub"]);
    assert.equal(composerTools.body.runtime.appliedTargets, 2);
    assert.equal(broker.focusApplications, 1);
    const policy = await jsonRequest(base, "/admin/api/sensitive-policy", {
      method: "PATCH",
      cookie: adminCookie,
      body: { enabled: true, actionPatterns: ["退出登录"], urlPatterns: ["*logout*"] },
    });
    assert.equal(policy.response.status, 200);
    assert.equal(policy.body.runtime.appliedTargets, 2);
    assert.equal(broker.policyApplications, 1);

    const uploaded = await fetch(`${base}/w/office/api/uploads`, {
      method: "POST",
      headers: {
        cookie: officeCookie,
        "content-type": "text/plain",
        "x-gpc-file-name": encodeURIComponent("本机资料.txt"),
      },
      body: "LOCAL_TO_REMOTE",
    });
    assert.equal(uploaded.status, 201);
    const uploadedBody = await uploaded.json();
    assert.equal(uploadedBody.file.name, "本机资料.txt");
    assert.equal(uploadedBody.file.workspaceId, null);
    assert.equal(Object.hasOwn(uploadedBody.file, "path"), false);
    const officeTransfers = await jsonRequest(base, "/w/office/api/transfers", { cookie: officeCookie });
    const labTransfers = await jsonRequest(base, "/w/laboratory/api/transfers", { cookie: labCookie });
    assert.equal(officeTransfers.body.files.length, 1);
    assert.equal(labTransfers.body.files.length, 0);
    assert.equal(Object.hasOwn(officeTransfers.body.files[0], "remotePath"), false);

    const downloadId = "download-12345678";
    transfers.beginDownload({ id: downloadId, workspaceId: "office", name: "远端结果.txt" });
    writeFileSync(transfers.remotePath(downloadId), "REMOTE_TO_LOCAL");
    transfers.updateDownload({ id: downloadId, state: "completed", receivedBytes: 15, totalBytes: 15 });
    const downloaded = await fetch(`${base}/w/office/files/${downloadId}`, { headers: { cookie: officeCookie } });
    assert.equal(downloaded.status, 200);
    assert.equal(await downloaded.text(), "REMOTE_TO_LOCAL");
    assert.match(downloaded.headers.get("content-disposition"), /filename\*=UTF-8/);
    assert.equal(
      (await fetch(`${base}/w/laboratory/files/${downloadId}`, { headers: { cookie: labCookie } })).status,
      404,
    );
    const adminDownloaded = await fetch(`${base}/admin/files/${downloadId}`, { headers: { cookie: adminCookie } });
    assert.equal(adminDownloaded.status, 200);
    assert.equal(await adminDownloaded.text(), "REMOTE_TO_LOCAL");
    const maintenanceRedirect = await fetch(`${base}/admin/maintenance/`, {
      headers: { cookie: adminCookie },
      redirect: "manual",
    });
    assert.equal(maintenanceRedirect.status, 302);
    assert.equal(maintenanceRedirect.headers.get("location"), "http://gateway.example.test:8443/");
    const maintenanceGateway = gateway.maintenanceServer.address();
    const maintenanceBase = `http://127.0.0.1:${maintenanceGateway.port}`;
    assert.equal((await fetch(maintenanceBase)).status, 401);
    assert.equal((await fetch(`${maintenanceBase}/__gpc/admin-browser.js`)).status, 401);
    const maintenanceScript = await fetch(`${maintenanceBase}/__gpc/admin-browser.js`, { headers: { cookie: adminCookie } });
    assert.equal(maintenanceScript.status, 200);
    assert.match(await maintenanceScript.text(), /noVNC_setting_enable_ime/);
    const maintenanceRoot = await fetch(maintenanceBase, {
      headers: { cookie: adminCookie },
      redirect: "manual",
    });
    assert.equal(maintenanceRoot.status, 302);
    assert.equal(maintenanceRoot.headers.get("location"), "/vnc/");
    const maintenanceAuthenticated = await fetch(`${maintenanceBase}/vnc/`, { headers: { cookie: adminCookie } });
    assert.equal(maintenanceAuthenticated.status, 200);
    assert.equal(await maintenanceAuthenticated.text(), "maintenance-ok");
    assert.equal(broker.maintenanceFocuses, 1);
    const created = await jsonRequest(base, "/admin/api/workspaces", {
      method: "POST",
      cookie: adminCookie,
      body: { id: "home", name: "家里", startUrl: "https://chatgpt.com/" },
    });
    assert.equal(created.response.status, 201);
    assert.equal(store.workspaces().length, 5);

    const rejectedSocket = new WebSocket(`ws://127.0.0.1:${address.port}/w/office/socket`, {
      headers: { cookie: officeCookie, origin: "https://attacker.example" },
    });
    const rejectedStatus = await new Promise((resolveRejected) => {
      rejectedSocket.once("unexpected-response", (_request, response) => {
        response.resume();
        rejectedSocket.terminate();
        resolveRejected(response.statusCode);
      });
      rejectedSocket.once("error", () => resolveRejected(403));
    });
    assert.equal(rejectedStatus, 403);

    for (const username of ["OFFICE-USER", " office-user ", "Office-User", "office-user", "OFFICE-USER", " office-user ", "Office-User", "office-user", "OFFICE-USER", " office-user "]) {
      const failedLogin = await jsonRequest(base, "/w/office/login", {
        method: "POST",
        body: { username, password: "definitely-wrong" },
      });
      assert.equal(failedLogin.response.status, 401);
    }
    const rateLimited = await jsonRequest(base, "/w/laboratory/login", {
      method: "POST",
      body: { username: "office-user", password: "office-password" },
    });
    assert.equal(rateLimited.response.status, 429);

    const adminId = store.users().find((user) => user.role === "admin").id;
    const rotated = await jsonRequest(base, `/admin/api/users/${adminId}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { password: "rotated-owner-password" },
    });
    assert.equal(rotated.response.status, 200);
    assert.equal((await jsonRequest(base, "/admin/api/state", { cookie: adminCookie })).response.status, 401);
    assert.equal(
      (
        await jsonRequest(base, "/admin/login", {
          method: "POST",
          body: { username: "owner", password: "rotated-owner-password" },
        })
      ).response.status,
      200,
    );
  } finally {
    await gateway.stop();
    await new Promise((resolveClose) => maintenanceUpstream.close(resolveClose));
    rmSync(directory, { recursive: true, force: true });
  }
});
