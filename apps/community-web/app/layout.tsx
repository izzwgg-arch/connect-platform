import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";

export const metadata: Metadata = {
  title: { default: "Loopcom Community", template: "%s · Loopcom Community" },
  description: "The professional network built for how our businesses actually work.",
  applicationName: "Loopcom Community",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#0c1218" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
