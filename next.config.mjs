/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Vài header an toàn cơ bản. Riêng CSP thì cố tình KHÔNG bật ở đây,
  // vì app chạy local (localhost) và bạn có thể muốn thêm extension/devtools.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ];
  },
};

export default nextConfig;
