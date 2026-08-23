import type { NextConfig } from 'next'
import { join } from 'node:path'

const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:3001'

const nextConfig: NextConfig = {
  // Standalone build for the Docker image; trace from the monorepo root.
  output: 'standalone',
  outputFileTracingRoot: join(__dirname, '../../'),

  // Next.js uses a compiler API absent from native TypeScript 7; type-check
  // with the tsc CLI as the supported workaround.
  experimental: {
    useTypeScriptCli: true,
  },

  // The browser reaches the API through its own origin, keeping the session
  // cookie httpOnly and SameSite=Lax without CORS or exposing the backend URL.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }]
  },
}

export default nextConfig
