/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // 启用 SWC 最小化以提升性能
  swcMinify: true,
  // 优化编译性能
  compiler: {
    // 生产环境移除 console 日志
    removeConsole: process.env.NODE_ENV === 'production',
  },
  // 优化实验性功能
  experimental: {
    // 优化包导入，减少 bundle 大小
    optimizePackageImports: [
      'lucide-react',
      '@headlessui/react',
      'sonner',
    ],
  },
  images: {
    remotePatterns: [
      {
        hostname: 's2.googleusercontent.com',
      },
    ],
  },
  serverExternalPackages: ['pdf-parse'],
};

export default nextConfig;
