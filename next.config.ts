import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 允许局域网同 Wi-Fi 设备访问 dev 资源（HMR / _next）
  allowedDevOrigins: ["172.30.91.197"],
};

export default nextConfig;
