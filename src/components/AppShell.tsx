import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  Activity,
  Database,
  DollarSign,
  Gauge,
  ListOrdered,
  Radar,
  Settings,
  Share2,
} from "lucide-react";

const NAV = [
  { to: "/", label: "Overview", icon: Gauge, exact: true },
  { to: "/sources", label: "Source Explorer", icon: Database, exact: false },
  { to: "/radar", label: "Radar", icon: Radar, exact: false },
  { to: "/resolver", label: "Origin Resolver", icon: Share2, exact: false },
  { to: "/queue", label: "Scan Queue", icon: ListOrdered, exact: false },
  { to: "/workers", label: "Workers", icon: Activity, exact: false },
  { to: "/api-cost", label: "API & Cost", icon: DollarSign, exact: false },
  { to: "/settings", label: "Settings", icon: Settings, exact: false },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="sticky top-0 z-20 border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-warn">
        Phase 1 — Source Discovery Only · no live crawling · no external API calls
      </div>
      <div className="flex">
        <aside className="sticky top-[30px] hidden h-[calc(100vh-30px)] w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-2 py-3 md:flex">
          <div className="px-2 pb-3">
            <div className="font-mono text-sm font-semibold tracking-tight text-sidebar-foreground">
              Source Scan Hub
            </div>
            <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              Internal operations
            </div>
          </div>
          <nav className="flex flex-col gap-0.5">
            {NAV.map(({ to, label, icon: Icon, exact }) => (
              <Link
                key={to}
                to={to}
                activeOptions={{ exact }}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent"
                activeProps={{
                  className:
                    "bg-sidebar-accent text-sidebar-primary font-medium border-l-2 border-sidebar-primary",
                }}
              >
                <Icon className="size-3.5" />
                {label}
              </Link>
            ))}
          </nav>
          <div className="mt-auto rounded border border-border bg-card p-2 text-[10px] leading-relaxed text-muted-foreground">
            <span className="text-foreground">Market scope: Vietnam</span> = the full internet
            ecosystem serving Vietnamese users, regardless of TLD (.com, .co, .shop, .vn …). Not
            limited to .vn domains.
          </div>
        </aside>
        <main className="min-w-0 flex-1 p-4">{children}</main>
      </div>
    </div>
  );
}
