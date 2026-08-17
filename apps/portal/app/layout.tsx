import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: {
    default: "Loopcom",
    template: "%s · Loopcom",
  },
  description:
    "Loopcom — the AI communications platform. Calls, SMS, WhatsApp, CRM and billing in one place.",
  applicationName: "Loopcom",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16.png", type: "image/png", sizes: "16x16" },
      { url: "/favicon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [{ url: "/favicon-180.png", sizes: "180x180" }],
  },
  openGraph: {
    type: "website",
    siteName: "Loopcom",
    title: "Loopcom",
    description: "The AI communications platform.",
    images: [{ url: "/loopcom-invoice.png", width: 1200, height: 265, alt: "Loopcom" }],
  },
  // The portal is an authenticated console; keep it out of search results.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0c1218",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
