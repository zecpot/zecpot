/**
 * Minimal HTTP server. No request logging, no cookies, no third-party anything.
 *   GET  /               static web app (apps/web/public)
 *   GET  /data/*         public round data written by store.publish()
 *   POST /api/claim      {round, ticket, to, sig}
 *   POST /api/mock/*     only in mock mode (demo buttons)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' https://1click.chaindefuser.com https://api.mainnet-beta.solana.com; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "permissions-policy": "interest-cohort=()",
};

export type Handler = (body: unknown) => Promise<{ status: number; json: unknown }>;

export function startServer(opts: { port: number; webDir: string; dataDir: string; post: Record<string, Handler> }) {
  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer) => {
    res.writeHead(status, { ...HEADERS, "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  const serveFile = async (res: ServerResponse, root: string, rel: string) => {
    const path = normalize(join(root, rel));
    if (!path.startsWith(resolve(root))) return send(res, 403, TYPES[".txt"]!, "forbidden");
    try {
      let body: string | Buffer = await readFile(path);
      // Link previews need absolute URLs: SITE_URL=https://your.domain (no trailing slash)
      if (rel === "index.html") body = body.toString("utf8").replaceAll("%SITE_URL%", (process.env.SITE_URL ?? "").replace(/\/+$/, ""));
      send(res, 200, TYPES[extname(path)] ?? "application/octet-stream", body);
    } catch {
      send(res, 404, TYPES[".txt"]!, "not found");
    }
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((ok, fail) => {
      let s = "";
      req.on("data", (c) => {
        s += c;
        if (s.length > 10_000) req.destroy();
      });
      req.on("end", () => {
        try {
          ok(s ? JSON.parse(s) : {});
        } catch (e) {
          fail(e);
        }
      });
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (req.method === "GET" && url.pathname.startsWith("/data/")) {
        return await serveFile(res, opts.dataDir, url.pathname.slice("/data/".length));
      }
      // Operator and demo endpoints answer only on this machine. A tunnel or proxy (Cloudflare, nginx)
      // also connects from localhost, so any forwarding header means the request came from outside.
      if (url.pathname === "/api/operator" || url.pathname.startsWith("/api/mock/")) {
        const h = req.headers;
        const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
        if (!local || h["cf-connecting-ip"] || h["x-forwarded-for"] || h["x-real-ip"] || h["forwarded"] || h["cf-ray"]) {
          if (url.pathname === "/api/operator" || process.env.ZECPOT_PUBLIC_DEMO !== "1") return send(res, 404, TYPES[".txt"]!, "not found");
        }
      }
      if (req.method === "POST" && opts.post[url.pathname]) {
        const out = await opts.post[url.pathname]!(await readBody(req));
        return send(res, out.status, TYPES[".json"]!, JSON.stringify(out.json));
      }
      if (req.method === "GET") {
        const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        return await serveFile(res, opts.webDir, rel);
      }
      send(res, 405, TYPES[".txt"]!, "method not allowed");
    } catch (e) {
      send(res, 400, TYPES[".json"]!, JSON.stringify({ ok: false, error: (e as Error).message }));
    }
  });
  server.listen(opts.port);
  return server;
}

/** Resolves once the port is bound; rejects (e.g. EADDRINUSE) instead of crashing the process. */
export function listening(server: ReturnType<typeof createServer>) {
  return new Promise<void>((ok, fail) => {
    if (server.listening) return ok();
    server.once("listening", () => ok());
    server.once("error", fail);
  });
}
