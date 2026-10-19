import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  AudioLines,
  Boxes,
  Cable,
  Gauge,
  PlusCircle,
  Radio,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sidebar, SidebarGroup, SidebarItem } from "@/components/ui/sidebar";

const NAV = [
  { to: "/", label: "نمای کلی", icon: Gauge, end: true },
  { to: "/new", label: "درخواست جدید", icon: PlusCircle, end: false },
  { to: "/jobs", label: "تاریخچه‌ی درخواست‌ها", icon: Radio, end: false },
];

const INFRA = [
  { to: "/accounts", label: "حساب‌ها", icon: Boxes, end: false },
  { to: "/proxies", label: "پراکسی‌ها", icon: Cable, end: false },
];

function NavLinkItem({
  to,
  label,
  icon: Icon,
  end,
}: {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  end: boolean;
}) {
  return (
    <NavLink to={to} end={end}>
      {({ isActive }) => <SidebarItem icon={Icon} label={label} active={isActive} />}
    </NavLink>
  );
}

/**
 * Shared shell: the sidebar sits at the inline-start (right in RTL) and the
 * main column shows the page content.
 */
export function AppLayout() {
  const location = useLocation();

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
        <SidebarGroup title="کار اصلی">
          {NAV.map((n) => (
            <NavLinkItem key={n.to} {...n} />
          ))}
        </SidebarGroup>
        <SidebarGroup title="زیرساخت">
          {INFRA.map((n) => (
            <NavLinkItem key={n.to} {...n} />
          ))}
        </SidebarGroup>
        <SidebarGroup title="تنظیمات">
          <NavLinkItem to="/settings" label="تنظیمات" icon={Settings} end={false} />
        </SidebarGroup>
      </Sidebar>

      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <header className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate text-sm font-semibold" aria-live="polite">
              {navTitle(location.pathname)}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <NavLink to="/settings">
              <Button variant="ghost" size="icon" aria-label="تنظیمات">
                <SlidersHorizontal />
              </Button>
            </NavLink>
          </div>
        </header>

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function navTitle(path: string): string {
  if (path === "/") return "نمای کلی";
  if (path === "/new") return "درخواست پردازش جدید";
  if (path.startsWith("/jobs/")) return "جزئیات درخواست";
  if (path === "/jobs") return "تاریخچه‌ی درخواست‌ها";
  if (path === "/accounts") return "حساب‌ها";
  if (path === "/proxies") return "پراکسی‌ها";
  if (path === "/settings") return "تنظیمات";
  return "پنل مدیریت";
}
