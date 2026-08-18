/** @type {import('next').NextConfig} */
const nextConfig = {
  // 允许并行构建/开发用不同产物目录，避免多个进程互相覆盖 .next
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // 以 Node 运行（next start）；API 路由可使用文件系统存储。
  output: "standalone",
  images: { unoptimized: true },
};

export default nextConfig;
