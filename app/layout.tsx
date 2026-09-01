import type { Metadata, Viewport } from "next";
import { PwaRegister } from "./PwaRegister";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Joyce Workspace",
    template: "%s · Joyce Workspace",
  },
  description:
    "Joyce 的个人外贸运营系统：客户记忆、产品知识、销售方法和每日工作。",
  applicationName: "Joyce Workspace",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Joyce Workspace",
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    title: "Joyce Workspace",
    description:
      "Customer memory · Product knowledge · Sales methods · Daily work",
    images: ["/og.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Joyce Workspace",
    description:
      "Customer memory · Product knowledge · Sales methods · Daily work",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#f6f7f5",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
