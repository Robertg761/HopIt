import type { NextConfig } from "next";

const installHeaders = [
  { key: 'Content-Type', value: 'text/plain; charset=utf-8' },
  { key: 'Cache-Control', value: 'public, max-age=300, must-revalidate' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
      { source: '/install', headers: installHeaders },
      { source: '/install.sh', headers: installHeaders },
    ];
  },
};

export default nextConfig;
