const isDevelopment = process.env.NODE_ENV === 'development'
const isProduction = process.env.NODE_ENV === 'production'

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ''} https://*.clerk.accounts.dev https://clerk.hopit.dev https://challenges.cloudflare.com https://*.js.stripe.com https://js.stripe.com`,
  "connect-src 'self' https://*.clerk.accounts.dev https://clerk.hopit.dev https://clerk-telemetry.com https://*.clerk-telemetry.com https://api.stripe.com wss://*.clerk.accounts.dev wss://clerk.hopit.dev",
  "img-src 'self' data: blob: https://img.clerk.com",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "frame-src 'self' https://challenges.cloudflare.com https://*.js.stripe.com https://js.stripe.com https://hooks.stripe.com",
  "form-action 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  ...(!isDevelopment ? ['upgrade-insecure-requests'] : []),
].join('; ')

export const browserSecurityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  ...(isProduction
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]
    : []),
]
