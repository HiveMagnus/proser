/** @type {import('next').NextConfig} */
const securityHeaders = [
  // The workspace is never embedded by another site.
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  // Browsers honour this only on HTTPS responses.
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    // API responses are relayed from Factory, which sets its own headers.
    return [
      { source: '/((?!api/).*)', headers: securityHeaders },
      // Browsers check the offline worker for updates on every visit.
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
  ...(process.env.PROSER_NEXT_DIST_DIR ? { distDir: process.env.PROSER_NEXT_DIST_DIR } : {}),
  experimental: { proxyClientMaxBodySize: '32mb' },
  transpilePackages: [
    '@hivemagnus/canvas-word-engine',
    '@hivemagnus/proser-editor',
    '@hivemagnus/proser-contracts',
  ],
};

module.exports = nextConfig;
