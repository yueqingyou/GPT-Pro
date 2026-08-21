const DEFAULT_GEO_ENDPOINT = "https://ipwho.is/?fields=success,country_code,timezone.id";
const PROFILE_SOURCES = new Set(["ip", "environment", "manual"]);

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function cleanEnvironmentLocale(raw) {
  const value = String(raw || "").trim();
  if (!value || /^(?:C|POSIX)(?:\.|$)/i.test(value)) return "";
  return value.split(".")[0].split("@")[0].replaceAll("_", "-");
}

export function normalizeTimezone(raw) {
  const timezone = String(raw || "").trim();
  if (!timezone || timezone.length > 64) throw fail("时区必须是有效的 IANA 名称");
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw fail("时区必须是有效的 IANA 名称，例如 Asia/Shanghai");
  }
}

export function normalizeLocale(raw) {
  const locale = cleanEnvironmentLocale(raw);
  if (!locale || locale.length > 64) throw fail("浏览器语言必须是有效的 BCP 47 标签");
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    throw fail("浏览器语言必须是有效的 BCP 47 标签，例如 zh-CN");
  }
}

export function browserLanguages(rawLocale) {
  const locale = normalizeLocale(rawLocale);
  const language = new Intl.Locale(locale).language;
  return [...new Set([locale, language, language === "en" ? null : "en"].filter(Boolean))];
}

export function acceptLanguageFor(rawLocale) {
  return browserLanguages(rawLocale)
    .map((language, index) => (index === 0 ? language : `${language};q=${(1 - index / 10).toFixed(1)}`))
    .join(",");
}

function timestamp(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw fail("浏览器环境时间戳无效");
  return parsed.toISOString();
}

function safeDetectionError(raw) {
  return String(raw || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 240);
}

export function emptyBrowserProfile() {
  return {
    mode: "auto",
    configured: false,
    timezone: "",
    locale: "",
    languages: [],
    acceptLanguage: "",
    source: "unset",
    detectedAt: "",
    updatedAt: "",
    lastDetectionError: "",
  };
}

export function normalizeBrowserProfile(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail("浏览器环境结构无效");
  const mode = raw.mode === "manual" ? "manual" : raw.mode === "auto" ? "auto" : null;
  if (!mode) throw fail("浏览器环境模式无效");
  if (!raw.configured) return { ...emptyBrowserProfile(), mode };

  const locale = normalizeLocale(raw.locale);
  const source = String(raw.source || "");
  if (!PROFILE_SOURCES.has(source)) throw fail("浏览器环境来源无效");
  if ((mode === "manual") !== (source === "manual")) throw fail("浏览器环境模式与来源不一致");
  const detectedAt = timestamp(raw.detectedAt);
  if ((source === "ip") !== !!detectedAt) throw fail("出口 IP 探测时间与环境来源不一致");
  const updatedAt = timestamp(raw.updatedAt);
  if (!updatedAt) throw fail("浏览器环境缺少更新时间");
  return {
    mode,
    configured: true,
    timezone: normalizeTimezone(raw.timezone),
    locale,
    languages: browserLanguages(locale),
    acceptLanguage: acceptLanguageFor(locale),
    source,
    detectedAt,
    updatedAt,
    lastDetectionError: safeDetectionError(raw.lastDetectionError),
  };
}

function configuredProfile({ mode, timezone, locale, source, detectedAt = "", lastDetectionError = "", now }) {
  const updatedAt = now().toISOString();
  return normalizeBrowserProfile({
    mode,
    configured: true,
    timezone,
    locale,
    source,
    detectedAt,
    updatedAt,
    lastDetectionError,
  });
}

export function manualBrowserProfile({ timezone, locale, now = () => new Date() }) {
  return configuredProfile({ mode: "manual", timezone, locale, source: "manual", now });
}

export function environmentBrowserProfile({ env = process.env, lastDetectionError = "", now = () => new Date() } = {}) {
  const timezone = normalizeTimezone(
    env.PROFILE_TIMEZONE || env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const locale = normalizeLocale(
    [env.PROFILE_LOCALE, env.LC_ALL, env.LC_MESSAGES, env.LANG]
      .map(cleanEnvironmentLocale)
      .find(Boolean) || Intl.DateTimeFormat().resolvedOptions().locale || "en-US",
  );
  return configuredProfile({
    mode: "auto",
    timezone,
    locale,
    source: "environment",
    lastDetectionError,
    now,
  });
}

async function defaultFetchJson(endpoint, { timeoutMs, fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(endpoint, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`出口 IP 信息服务返回 HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 64 * 1024) throw new Error("出口 IP 信息响应过大");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("出口 IP 信息不是有效 JSON");
  }
}

function localeFromProvider(data) {
  const country = String(data.country_code || "").trim().toLocaleUpperCase("en-US");
  if (!/^[A-Z]{2}$/.test(country)) throw new Error("出口 IP 信息没有可用的语言或国家代码");
  const likelyLanguage = new Intl.Locale(`und-${country}`).maximize().language;
  return normalizeLocale(`${likelyLanguage}-${country}`);
}

function timezoneFromProvider(data) {
  return normalizeTimezone(data.timezone?.id);
}

export async function detectBrowserProfileFromIp({
  endpoint = DEFAULT_GEO_ENDPOINT,
  fetchJson = defaultFetchJson,
  timeoutMs = 5000,
  now = () => new Date(),
} = {}) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw fail("出口 IP 信息服务地址无效");
  }
  if (url.protocol !== "https:") throw fail("出口 IP 信息服务必须使用 HTTPS");
  const data = await fetchJson(url.toString(), { timeoutMs });
  if (!data || typeof data !== "object" || data.error || data.success === false) {
    throw new Error("出口 IP 信息服务未返回可用结果");
  }
  const detectedAt = now().toISOString();
  return configuredProfile({
    mode: "auto",
    timezone: timezoneFromProvider(data),
    locale: localeFromProvider(data),
    source: "ip",
    detectedAt,
    now,
  });
}

export async function resolveAutomaticBrowserProfile({
  autoDetect = true,
  endpoint = DEFAULT_GEO_ENDPOINT,
  fetchJson,
  timeoutMs = 5000,
  env = process.env,
  now = () => new Date(),
} = {}) {
  if (!autoDetect) {
    const warning = "出口 IP 自动探测已禁用；已使用部署环境值，请在管理页核对。";
    return { profile: environmentBrowserProfile({ env, lastDetectionError: warning, now }), detected: false, warning };
  }
  try {
    return {
      profile: await detectBrowserProfileFromIp({ endpoint, fetchJson, timeoutMs, now }),
      detected: true,
      warning: "",
    };
  } catch (error) {
    const warning = "出口 IP 自动探测失败；已使用部署环境值，请在管理页核对或手动设置。";
    return {
      profile: environmentBrowserProfile({ env, lastDetectionError: warning, now }),
      detected: false,
      warning,
      error,
    };
  }
}
