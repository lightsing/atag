import type { Metadata, Viewport } from "next";
import "leaflet/dist/leaflet.css";
import "./globals.css";

const favicon = `${process.env.ATAG_PAGES_BASE_PATH ?? ""}/favicon.svg`;

export const metadata: Metadata = {
  title: "ATAG · 我的设备",
  description: "管理自己的 ATAG：在地图上查看 Find My 位置报告，并通过附近蓝牙辨认、配置和管理 Tag。",
  icons: {
    icon: favicon,
    shortcut: favicon,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f3efe7",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
