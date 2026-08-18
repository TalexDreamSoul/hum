import type { Metadata } from "next";
import { SiteFrame } from "@/components/site-frame";
import "@cloudflare/kumo/styles/kumo-standalone";
import "./globals.css";

export const metadata: Metadata = {
  title: "hum·lab — 儿童歌曲音频分析",
  description: "儿童歌曲分析、内容入库、审批与外部服务配置。",
  robots: { index: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="bg-kumo-base text-kumo-default">
        <SiteFrame>{children}</SiteFrame>
      </body>
    </html>
  );
}
