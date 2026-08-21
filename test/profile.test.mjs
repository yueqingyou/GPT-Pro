import assert from "node:assert/strict";
import test from "node:test";
import {
  detectBrowserProfileFromIp,
  manualBrowserProfile,
  normalizeLocale,
  normalizeTimezone,
  resolveAutomaticBrowserProfile,
} from "../lib/profile.mjs";

const FIXED_NOW = () => new Date("2026-08-19T12:00:00.000Z");

test("手动环境将时区、locale、navigator.languages 与 Accept-Language 归一化", () => {
  const profile = manualBrowserProfile({ timezone: "Asia/Shanghai", locale: "zh_CN.UTF-8", now: FIXED_NOW });
  assert.equal(profile.mode, "manual");
  assert.equal(profile.source, "manual");
  assert.equal(profile.timezone, "Asia/Shanghai");
  assert.equal(profile.locale, "zh-CN");
  assert.deepEqual(profile.languages, ["zh-CN", "zh", "en"]);
  assert.equal(profile.acceptLanguage, "zh-CN,zh;q=0.9,en;q=0.8");
  assert.equal(profile.updatedAt, "2026-08-19T12:00:00.000Z");
  assert.equal(normalizeTimezone("US/Pacific"), "America/Los_Angeles");
  assert.throws(() => normalizeTimezone("Mars/Lab"), /IANA/);
  assert.throws(() => normalizeLocale("not_a_locale_@"), /BCP 47/);
});

test("出口 IP 探测只提取时区和语言，不返回公网 IP", async () => {
  let requested;
  const profile = await detectBrowserProfileFromIp({
    endpoint: "https://geo.example.test/json/",
    timeoutMs: 4321,
    now: FIXED_NOW,
    fetchJson: async (endpoint, options) => {
      requested = { endpoint, options };
      return {
        ip: "203.0.113.77",
        city: "不应保存",
        success: true,
        country_code: "US",
        timezone: { id: "America/Los_Angeles" },
      };
    },
  });
  assert.deepEqual(requested, { endpoint: "https://geo.example.test/json/", options: { timeoutMs: 4321 } });
  assert.equal(profile.source, "ip");
  assert.equal(profile.timezone, "America/Los_Angeles");
  assert.equal(profile.locale, "en-US");
  assert.equal(profile.detectedAt, "2026-08-19T12:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(profile), /203\.0\.113\.77|不应保存/);
});

test("自动探测失败时使用可验证的部署环境值并要求管理员核对", async () => {
  const result = await resolveAutomaticBrowserProfile({
    endpoint: "https://geo.example.test/json/",
    fetchJson: async () => {
      throw new Error("模拟网络失败");
    },
    env: { PROFILE_TIMEZONE: "Europe/Berlin", PROFILE_LOCALE: "de_DE.UTF-8" },
    now: FIXED_NOW,
  });
  assert.equal(result.detected, false);
  assert.equal(result.profile.source, "environment");
  assert.equal(result.profile.timezone, "Europe/Berlin");
  assert.equal(result.profile.locale, "de-DE");
  assert.match(result.profile.lastDetectionError, /手动设置/);
  assert.doesNotMatch(result.profile.lastDetectionError, /模拟网络失败/);
});

test("禁用自动探测时不访问外部服务", async () => {
  let fetched = false;
  const result = await resolveAutomaticBrowserProfile({
    autoDetect: false,
    fetchJson: async () => {
      fetched = true;
      return {};
    },
    env: { TZ: "UTC", LANG: "en_US.UTF-8" },
    now: FIXED_NOW,
  });
  assert.equal(fetched, false);
  assert.equal(result.profile.source, "environment");
  assert.equal(result.profile.timezone, "UTC");
  assert.equal(result.profile.locale, "en-US");
});

test("显式部署环境无效时直接报错", async () => {
  await assert.rejects(
    () => resolveAutomaticBrowserProfile({ autoDetect: false, env: { PROFILE_TIMEZONE: "Mars/Lab", PROFILE_LOCALE: "en-US" } }),
    /IANA/,
  );
});
