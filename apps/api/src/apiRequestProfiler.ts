import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

type JwtShape = { sub?: string; tenantId?: string; role?: string };

type RouteAgg = {
  count: number;
  totalMs: number;
  maxMs: number;
};

function clientIp(req: FastifyRequest): string {
  const xff = req.headers["x-forwarded-for"];
  const first =
    typeof xff === "string"
      ? xff.split(",")[0]?.trim()
      : Array.isArray(xff)
        ? String(xff[0] || "").split(",")[0]?.trim()
        : "";
  if (first) return first.slice(0, 64);
  const raw = (req as { ip?: string }).ip;
  return raw ? String(raw).slice(0, 64) : "unknown";
}

function routeTemplate(req: FastifyRequest): string {
  const ro = req.routeOptions as { url?: string } | undefined;
  const u = ro?.url;
  if (u && typeof u === "string") return u;
  const path = req.url?.split("?")[0] ?? "unknown";
  return path || "unknown";
}

function truncateUa(ua: string | undefined): string {
  const s = (ua || "").replace(/\s+/g, " ").trim();
  if (s.length <= 160) return s;
  return `${s.slice(0, 157)}...`;
}

function authKind(req: FastifyRequest, pathNoQuery: string): "jwt" | "bearer" | "internal_path" | "none" {
  if (pathNoQuery.includes("/internal/")) return "internal_path";
  const u = req.user as JwtShape | undefined;
  if (u?.sub) return "jwt";
  const auth = String(req.headers.authorization || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) return "bearer";
  return "none";
}

/**
 * Temporary request profiler for API CPU investigations.
 *
 * - `CONNECT_API_PROFILE=1` — every ~10s log one structured line with top routes
 *   and top client IPs (grep: `api_request_profile`).
 * - `CONNECT_API_PROFILE_EACH=1` — also log one line per finished request (noisy;
 *   use only for short windows; still grep-safe, no bodies/tokens).
 */
export function installApiRequestProfiler(app: FastifyInstance): void {
  if (process.env.CONNECT_API_PROFILE !== "1") return;

  const logEach = process.env.CONNECT_API_PROFILE_EACH === "1";
  const byRoute = new Map<string, RouteAgg>();
  const byIp = new Map<string, number>();

  const bumpRoute = (key: string, ms: number) => {
    let a = byRoute.get(key);
    if (!a) {
      a = { count: 0, totalMs: 0, maxMs: 0 };
      byRoute.set(key, a);
    }
    a.count += 1;
    a.totalMs += ms;
    if (ms > a.maxMs) a.maxMs = ms;
  };

  const bumpIp = (ip: string) => {
    byIp.set(ip, (byIp.get(ip) ?? 0) + 1);
  };

  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const start = (req as { _metricsStart?: number })._metricsStart;
    if (start == null) return;
    const durationMs = Math.max(0, Date.now() - start);
    const pathNoQuery = req.url?.split("?")[0] ?? "";
    const method = req.method;
    const template = routeTemplate(req);
    const key = `${method} ${template}`;
    const status = reply.statusCode;
    const ip = clientIp(req);
    const ua = truncateUa(req.headers["user-agent"] as string | undefined);
    const user = req.user as JwtShape | undefined;
    const auth = authKind(req, pathNoQuery);
    const lenHdr = reply.getHeader("content-length");
    const contentLength =
      typeof lenHdr === "number" ? lenHdr : typeof lenHdr === "string" ? Number(lenHdr) || undefined : undefined;

    bumpRoute(key, durationMs);
    bumpIp(ip);

    if (logEach) {
      app.log.info(
        {
          msg: "api_request_profile",
          method,
          route: template,
          path: pathNoQuery,
          status,
          durationMs,
          ip,
          userAgent: ua,
          userId: user?.sub ?? null,
          tenantId: user?.tenantId ?? null,
          role: user?.role ?? null,
          authKind: auth,
          contentLength: Number.isFinite(contentLength as number) ? contentLength : undefined,
        },
        "api_request_profile",
      );
    }
  });

  const flush = () => {
    const topRoutes = [...byRoute.entries()]
      .map(([route, v]) => ({
        route,
        count: v.count,
        avgMs: Math.round(v.totalMs / Math.max(1, v.count)),
        maxMs: v.maxMs,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25);

    const topClientIps = [...byIp.entries()]
      .map(([ip, count]) => ({ ip, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    app.log.info(
      {
        msg: "api_request_profile_summary",
        windowSec: 10,
        topRoutes,
        topClientIps,
      },
      "api_request_profile",
    );

    byRoute.clear();
    byIp.clear();
  };

  const timer = setInterval(flush, 10_000);
  timer.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(timer);
    flush();
  });
}
