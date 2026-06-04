const path = require("node:path");

const standaloneOutput = process.env.NEXT_OUTPUT_STANDALONE === "1";

/** Local API target for dev rewrites (mirrors nginx `location /api/` → API). */
function devApiProxyTarget() {
  const fromEnv =
    process.env.PORTAL_API_DEV_PROXY ||
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.PORTAL_API_INTERNAL_URL ||
    "http://127.0.0.1:3001";
  return String(fromEnv).trim().replace(/\/$/, "");
}

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    const api = devApiProxyTarget();
    return [
      {
        source: "/api/:path*",
        destination: `${api}/:path*`,
      },
    ];
  },
  ...(standaloneOutput
    ? {
        output: "standalone",
        experimental: {
          outputFileTracingRoot: path.join(__dirname, "../.."),
        },
      }
    : {}),
};
