import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Email Marketing Platform",
  description: "Self-hosted marketing email system",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">{children}</body>
    </html>
  );
}
