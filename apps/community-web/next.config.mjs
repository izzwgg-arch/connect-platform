/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  async headers() {
    const api = process.env.NEXT_PUBLIC_COMMUNITY_API_URL || "http://localhost:3101";
    // Next dev mode evaluates source maps; production never gets unsafe-eval.
    const devEval = process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'";
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(self)" },
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${devEval} https://accounts.google.com https://appleid.cdn-apple.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: ${api}; media-src 'self' blob: ${api}; connect-src 'self' ${api} https://accounts.google.com https://appleid.apple.com; frame-src https://accounts.google.com https://appleid.apple.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
          },
        ],
      },
    ];
  },
};
export default nextConfig;
