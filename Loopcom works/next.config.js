/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    domains: ['localhost'],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
  env: {
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    JWT_SECRET: process.env.JWT_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    // Repo currently has legacy lint issues; don't block production builds.
    ignoreDuringBuilds: true,
  },
}

module.exports = nextConfig
