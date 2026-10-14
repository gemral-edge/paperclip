import type { Request, RequestHandler } from "express";

/**
 * Remote API-key guard.
 *
 * Paperclip runs in `local_trusted` mode: every local request is treated as a
 * trusted board actor with no auth. That is fine for `localhost:3100` (the owner's
 * machine), but the server is ALSO exposed publicly through a Cloudflare tunnel
 * (gemops.gemcapitalholding.com → localhost:3100). Without this guard, anyone who
 * knows the URL can hit the control plane unauthenticated (run agents, read configs,
 * CRM, chat history). See HARD RULE #0 ("Paperclip access ONLY via localhost").
 *
 * This guard requires a shared `PAPERCLIP_API_KEY` for REMOTE requests only:
 *   - Local (loopback) requests        → pass (the UI + local tooling, trusted).
 *   - Remote, self-authenticating paths → pass (webhooks verify their own signatures,
 *     health is harmless): see EXEMPT_PREFIXES.
 *   - Remote, everything else          → require a valid PAPERCLIP_API_KEY, else 401.
 *
 * "Remote" is detected via `cf-connecting-ip` / `cf-ray`, which Cloudflare ALWAYS
 * adds on the tunnel and a client cannot strip, so it cannot be spoofed by sending a
 * fake `Host: localhost` header. A non-loopback Host is also treated as remote.
 *
 * Fail-closed: if PAPERCLIP_API_KEY is unset, ALL non-exempt remote requests are
 * rejected (the hole stays closed even when misconfigured).
 */

// Paths (relative to the /api mount) that must stay reachable without the API key.
const EXEMPT_PREFIXES = [
  "/health",
  // [19/08] Thu hẹp từ "/channels/facebook" (prefix bọc cả /send, /comment-reply, /pages) xuống ĐÚNG
  // 2 đường Meta gọi vào không thể mang API key: webhook (Meta POST/GET) + oauth (redirect trình duyệt).
  // /send bây giờ yêu cầu API key khi remote (proxy nội bộ qua loopback vẫn pass). Codex R1-F1.
  "/channels/facebook/webhook",
  "/channels/facebook/oauth",
  "/channels/facebook-web",
  "/channels/zalo-personal", // Zalo webhook
  "/channels/youtube",
  // [14/10 EC-086] CHỈ callback (Threads redirect trình duyệt về, không mang key). /oauth/start KHÔNG exempt:
  // chị bấm start trên localhost:3100 — người lạ không khởi động được luồng gắn token.
  "/channels/threads/oauth/callback",
];

function isRemoteRequest(req: Request): boolean {
  // Cloudflare adds these on every tunnel request; a client cannot remove them.
  if (req.header("cf-connecting-ip") || req.header("cf-ray")) return true;
  const raw = (req.header("x-forwarded-host")?.split(",")[0] || req.header("host") || "")
    .trim()
    .toLowerCase();
  const host = raw.replace(/:\d+$/, "");
  if (host && host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return true;
  return false;
}

function isExempt(path: string): boolean {
  return EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p));
}

function extractApiKey(req: Request): string {
  const auth = req.header("authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return (req.header("x-paperclip-api-key") || "").trim();
}

export function remoteApiKeyGuard(apiKey: string): RequestHandler {
  return (req, res, next) => {
    if (!isRemoteRequest(req)) return next(); // local UI / tooling — trusted
    if (isExempt(req.path)) return next(); // self-authenticating webhooks + health
    const provided = extractApiKey(req);
    if (apiKey && provided && provided === apiKey) return next();
    res.status(401).json({ error: "Unauthorized: API key required for remote access" });
  };
}
