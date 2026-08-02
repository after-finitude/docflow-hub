import type { NextConfig } from 'next'
import { join } from 'node:path'

const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:3001'

const nextConfig: NextConfig = {
  // standalone-сборка для docker-образа; корень трассировки — корень монорепо.
  output: 'standalone',
  outputFileTracingRoot: join(__dirname, '../../'),

  // Next.js обращается к программному API компилятора, которого у нативного
  // TypeScript 7 нет; штатный обходной путь — проверка типов через CLI tsc.
  experimental: {
    useTypeScriptCli: true,
  },

  // Браузер ходит в API через собственный origin: session-cookie остаётся
  // httpOnly и SameSite=Lax без CORS и без раскрытия адреса бэкенда.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }]
  },
}

export default nextConfig
