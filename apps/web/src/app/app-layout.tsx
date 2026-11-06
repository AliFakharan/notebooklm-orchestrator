import { NavLink, Outlet, useLocation } from "react-router-dom";
import { AudioLines, Gauge, PlusCircle, Radio } from "lucide-react";
import { Sidebar, SidebarGroup, SidebarItem } from "@/components/ui/sidebar";

export interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  end: boolean;
  /** Sidebar group title the item belongs to (order of first use). */
  group: string;
}

function NavLinkItem({ to, label, icon: Icon, end }: Omit<NavItem, "group">) {
  return (
    <NavLink to={to} end={end}>
      {({ isActive }) => <SidebarItem icon={Icon} label={label} active={isActive} />}
    </NavLink>
  );
}

/**
 * Shared shell: sidebar (inline-start, right in RTL) + page header + content
 * column. The nav items and the page-title map are provided by the caller so
 * the admin section can reuse the exact same look with its own menu.
 */
export function AppShell({
  nav,
  titleFor,
}: {
  nav: NavItem[];
  titleFor: (path: string) => string;
}) {
  const location = useLocation();
  const groups = [...new Set(nav.map((n) => n.group))];

  return (
    <div className="flex min-h-screen gap-4 p-4">
      <Sidebar
        className="sticky top-4 hidden h-[calc(100vh-2rem)] md:flex"
        header={
          <div className="flex items-center gap-2 px-0.5">
            <span className="flex size-8 items-center justify-center rounded-control bg-brand text-brand-foreground">
              <AudioLines className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold leading-5">مدیریت پردازش صدا</p>
              <p className="truncate text-[11px] text-muted-foreground">NotebookLM Orchestrator</p>
            </div>
          </div>
        }
      >
        {groups.map((g) => (
          <SidebarGroup key={g} title={g}>
            {nav
              .filter((n) => n.group === g)
              .map((n) => (
                <NavLinkItem key={n.to} {...n} />
              ))}
          </SidebarGroup>
        ))}
      </Sidebar>

      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <header className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
          <h1 className="min-w-0 truncate text-sm font-semibold" aria-live="polite">
            {titleFor(location.pathname)}
          </h1>
        </header>

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

const NAV: NavItem[] = [
  { to: "/", label: "نمای کلی", icon: Gauge, end: true, group: "کار اصلی" },
  { to: "/new", label: "درخواست جدید", icon: PlusCircle, end: false, group: "کار اصلی" },
  { to: "/jobs", label: "تاریخچه‌ی درخواست‌ها", icon: Radio, end: false, group: "کار اصلی" },
];

function mainTitle(path: string): string {
  if (path === "/") return "نمای کلی";
  if (path === "/new") return "درخواست پردازش جدید";
  if (path.startsWith("/jobs/")) return "جزئیات درخواست";
  if (path === "/jobs") return "تاریخچه‌ی درخواست‌ها";
  return "پنل مدیریت";
}

/** Shell for the public (jobs) section. */
export function AppLayout() {
  return <AppShell nav={NAV} titleFor={mainTitle} />;
}
