import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ['127.0.0.1', '192.168.2.81'],
  transpilePackages: ['@hopit/backend-d1', '@hopit/core'],
};

export default nextConfig;
