/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(process.env.PROSER_NEXT_DIST_DIR ? { distDir: process.env.PROSER_NEXT_DIST_DIR } : {}),
  experimental: { proxyClientMaxBodySize: '32mb' },
  transpilePackages: [
    '@hivemagnus/canvas-word-engine',
    '@cheftaco/proser-editor',
    '@cheftaco/proser-contracts',
  ],
};

module.exports = nextConfig;
