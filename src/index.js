import { UI } from "./ui.js";

const ALLOWED_HOSTS = new Set([
  "huggingface.co",
  "cdn-lfs.huggingface.co",
  "hf-hub-lfs-prod.s3.us-east-1.amazonaws.com",
  "cdn.hf.co",
  "us.aws.cdn.hf.co",
  "cas-server.xethub.hf.co",
]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "cookie",
  "cf-connecting-ip", "cf-ipcountry", "cf-ray", "x-forwarded-for",
]);

const RESERVED_ROUTES = new Set(["hf", "api", "models", "https:"]);
const SHORT_LINK_ENV_NAMES = ["SHORT_LINKS", "FIXED_LINKS", "LINKS"];

function html() {
  return new Response(UI, {
    headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "no-store" },
  });
}

function badRequest(message) {
  return new Response(message, { status: 400, headers: { "content-type": "text/plain; charset=UTF-8" } });
}

// blob → resolve: HuggingFace blob 页面转直接下载
function hfBlobToResolve(target) {
  if (target.hostname !== "huggingface.co") return target;
  const p = target.pathname;
  if (!p.includes("/blob/")) return target;
  return new URL(`https://huggingface.co${p.replace("/blob/", "/resolve/")}${target.search}`);
}

function parseShortLinks(value) {
  if (!value) return {};

  const trimmed = value.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith("{")) return JSON.parse(trimmed);

  return Object.fromEntries(trimmed.split(/\r?\n/).map((line) => {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) return null;
    const separator = clean.includes("=") ? "=" : ":";
    const index = clean.indexOf(separator);
    if (index < 1) return null;
    return [clean.slice(0, index).trim(), clean.slice(index + 1).trim()];
  }).filter(Boolean));
}

function shortLinksFromEnv(env = {}) {
  for (const name of SHORT_LINK_ENV_NAMES) {
    if (typeof env[name] === "string" && env[name].trim()) return parseShortLinks(env[name]);
  }
  return {};
}

function shortLinkTarget(url, env) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 1 || RESERVED_ROUTES.has(parts[0])) return null;

  const links = shortLinksFromEnv(env);
  const target = links[parts[0]];
  if (typeof target !== "string" || !target.trim()) return null;

  return hfBlobToResolve(new URL(target.trim()));
}

function targetFromRequest(url, env) {
  const fixedTarget = shortLinkTarget(url, env);
  if (fixedTarget) return fixedTarget;

  // Full HuggingFace URL form: /https://huggingface.co/user/model/resolve/main/file
  const raw = url.href.slice(url.origin.length + 1);
  if (raw.startsWith("https://")) return hfBlobToResolve(new URL(raw));

  const parts = url.pathname.split("/").filter(Boolean);
  // /hf/USER/MODEL/... (resolve, blob, tree, etc.)
  if (parts[0] === "hf" && parts.length >= 3) {
    return hfBlobToResolve(new URL(`https://huggingface.co/${parts.slice(1).join("/")}${url.search}`));
  }
  // /api/... -> HuggingFace API
  if (parts[0] === "api" && parts.length >= 2) {
    return new URL(`https://huggingface.co/api/${parts.slice(1).join("/")}${url.search}`);
  }
  // /models/USER/MODEL/... (shortcut)
  if (parts[0] === "models" && parts.length >= 4) {
    return hfBlobToResolve(new URL(`https://huggingface.co/${parts.join("/")}${url.search}`));
  }
  return null;
}

function safeHeaders(headers) {
  const result = new Headers();
  for (const [name, value] of headers) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) result.set(name, value);
  }
  result.set("user-agent", "cf-hf-link/1.0");
  return result;
}

function isCacheableAsset(target) {
  if (target.hostname === "huggingface.co")
    return /\/resolve\//.test(target.pathname) && !target.pathname.endsWith("/api/");
  if (target.hostname.endsWith(".hf.co") || target.hostname.endsWith(".huggingface.co"))
    return true;
  return false;
}

// 判断是否为文件下载（需要强制 attachment）
function isFileDownload(target) {
  if (target.hostname === "huggingface.co" && /\/resolve\//.test(target.pathname)) return true;
  if (target.hostname.endsWith(".hf.co") || target.hostname.endsWith(".huggingface.co")) return true;
  if (target.hostname === "hf-hub-lfs-prod.s3.us-east-1.amazonaws.com") return true;
  return false;
}

function proxyUrl(requestUrl, target) {
  return `${requestUrl.origin}/${target.href}`;
}

async function proxy(request, env) {
  const requestUrl = new URL(request.url);
  let target;
  try {
    target = targetFromRequest(requestUrl, env);
  } catch {
    return badRequest("Invalid fixed short link target");
  }
  if (!target) return requestUrl.pathname === "/" ? html() : badRequest("Use /hf/USER/MODEL/..., /SHORT_NAME, or /https://huggingface.co/...");
  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) return badRequest("Target host is not allowed");
  if (!["GET", "HEAD", "POST"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD, POST" } });

  const init = {
    method: request.method,
    headers: safeHeaders(request.headers),
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch {
    return new Response("Unable to reach HuggingFace upstream", { status: 502 });
  }

  const headers = safeHeaders(upstream.headers);
  const location = upstream.headers.get("location");
  if (location && upstream.status >= 300 && upstream.status < 400) {
    const redirectTarget = new URL(location, target);
    if (redirectTarget.protocol === "https:" && ALLOWED_HOSTS.has(redirectTarget.hostname)) {
      headers.set("location", proxyUrl(requestUrl, redirectTarget));
    } else {
      headers.set("location", location);
    }
  }

  // 强制浏览器下载，而不是在页面中打开
  if (isFileDownload(target) && request.method === "GET" && upstream.ok) {
    // 从路径中提取文件名
    const pathname = target.hostname.endsWith(".hf.co") || target.hostname.endsWith(".huggingface.co")
      ? new URL(upstream.headers.get("x-final-url") || target).pathname
      : target.pathname;
    const filename = decodeURIComponent(pathname.split("/").pop() || "download");
    if (!headers.has("content-disposition")) {
      headers.set("content-disposition", `attachment; filename="${filename}"`);
    }
  }

  // Model files are immutable at a resolve URL. Cache at edge for a year.
  if (isCacheableAsset(target) && request.method === "GET" && !request.headers.has("range") && upstream.ok) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  } else if (target.hostname === "huggingface.co" && target.pathname.startsWith("/api/")) {
    headers.set("cache-control", "no-store");
  }
  headers.set("x-hf-accelerator", "cf-hf-link");
  return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers });
}

export default { fetch: proxy };
