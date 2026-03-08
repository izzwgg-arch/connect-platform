import { SidebarNav } from "./SidebarNav";
import { Topbar } from "./Topbar";

export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <SidebarNav />
      <main className="main">
        <Topbar />
        <div className="content-wrap">{children}</div>
      </main>
    </div>
  );
}
