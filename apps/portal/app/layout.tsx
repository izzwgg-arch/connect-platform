import "./globals.css";
import Link from "next/link";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="side">
            <h2>Connect</h2>
            <Link href="/">Home</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/login">Login</Link>
            <Link href="/signup">Sign Up</Link>
            <Link href="/dashboard">Dashboard</Link>
            <Link href="/dashboard/numbers">Numbers</Link>
            <Link href="/dashboard/extensions">Extensions</Link>
            <Link href="/dashboard/sms">SMS</Link>
            <Link href="/dashboard/10dlc">10DLC</Link>
            <Link href="/dashboard/admin/10dlc">Admin 10DLC</Link>
            <Link href="/legal/privacy">Privacy</Link>
            <Link href="/legal/terms">Terms</Link>
          </aside>
          <main className="main">
            <div className="top">Connect Communications Portal</div>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
