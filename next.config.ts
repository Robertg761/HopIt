import type { NextConfig } from "next";

import { browserSecurityHeaders } from './src/lib/security-headers'

const installHeaders = [
  { key: 'Content-Type', value: 'text/plain; charset=utf-8' },
  { key: 'Cache-Control', value: 'public, max-age=300, must-revalidate' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The app never uses next/image, but the /_next/image optimizer endpoint
  // exists by default and is a DoS surface (GHSA-q8wf-6r8g-63ch). Disable it
  // outright; nothing depends on it.
  images: { unoptimized: true },
  allowedDevOrigins: ['127.0.0.1', '192.168.2.81'],
  transpilePackages: ['@hopit/backend-d1', '@hopit/core'],
  async rewrites() {
    // Serve the reviewable static installer at the clean `/install` path so
    // `curl -fsSL https://hopit.dev/install | sh` works.
    return [{ source: '/install', destination: '/install.sh' }];
  },
  async headers() {
    // Force text/plain (browsers otherwise download .sh) and a short cache.
    return [
      { source: '/(.*)', headers: browserSecurityHeaders },
      { source: '/install', headers: installHeaders },
      { source: '/install.sh', headers: installHeaders },
    ];
  },
};

export default nextConfig;
