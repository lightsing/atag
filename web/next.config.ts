import type { NextConfig } from "next";

const nextConfig: NextConfig = process.env.ATAG_PAGES === "1" ? {
  output: "export",
  basePath: process.env.ATAG_PAGES_BASE_PATH ?? "",
  trailingSlash: true,
} : {};

export default nextConfig;
