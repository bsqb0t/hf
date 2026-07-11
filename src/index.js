import { UI } from "./ui.js";

const ALLOWED_HOSTS = new Set([
  "huggingface.co",
  "cdn-lfs.huggingface.co",
  "hf-hub-lfs-prod.s3.us-east-1.amazonaws.com",
]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "cookie",
  "cf-connecting-ip", "cf-ipcountry", "cf-ray", "x-forwarded-for",
]);

function html() {
  return new Response(UI, {
    headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "no-store" },
  });
}

function badRequest(message) {
  return new Response(message, { status: 400, headers: { "content-type": "text/plain; charset=UTF-8" } });
}

function targetFromRequest(url) {
  // Full HuggingFace URL form: /https://huggingface.co/user/model/resolve/main/file
  const raw = url.href.slice(url.origin.length + 1);
  if (raw.startsWith("https://")) return new URL(raw);

  const parts = url.pathname.split("/").filter(Boolean);
  // /hf/USER/MODEL/resolve/main/FILE
  if (parts[0] === "hf" && parts.length >= 3) {
    return new URL(`https://huggingface.co/${parts.slice(1).join("/")}${url.search}`);
  }
  // /api/... -> HuggingFace API
  if (parts[0] === "api" && parts.length >= 2) {
    return new URL(`https://huggingface.co/api/${parts.slice(1).join("/")}${url.search}`);
  }
  // /models/USER/MODEL/resolve/main/FILE (shortcut)
  if (parts[0] === "models" && parts.length >= 4) {
    return new URL(`https://huggingface.co/${parts.join("/")}${url.search}`);
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
  // Model weights, tokenizer files, configs etc. are immutable once published
  return target.hostname === "huggingface.co"
    && /\/resolve\//.test(target.pathname)
    && !target.pathname.endsWith("/api/");
}

function proxyUrl(requestUrl, target) {
  return `${requestUrl.origin}/${target.href}`;
}

async function proxy(request) {
  const requestUrl = new URL(request.url);
  const target = targetFromRequest(requestUrl);
  if (!target) return requestUrl.pathname === "/" ? html() : badRequest("Use /hf/USER/MODEL/... or /https://huggingface.co/...");
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
