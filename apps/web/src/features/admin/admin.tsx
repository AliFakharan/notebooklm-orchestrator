import { useCallback, useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { Cable, KeyRound, LockKeyhole, Users } from "lucide-react";
import { adminLogin, adminMe, type AdminStatus } from "@/lib/api";
import { AppShell, type NavItem } from "@/app/app-layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AccountsPage } from "@/features/accounts/accounts";
import { ProxiesPage } from "@/features/proxies/proxies";

/**
 * زیرساخت — the admin-gated section. It reuses the exact same app shell
 * (header + sidebar) as the public pages, but its sidebar shows the
 * «زیرساخت» group (حساب‌ها / پراکسی‌ها) instead of «کار اصلی», and there is
 * no link to it anywhere in the public UI — the only way in is the URL.
 */
const ADMIN_NAV: NavItem[] = [
  { to: "/admin/accounts", label: "حساب‌ها", icon: Users, end: true, group: "زیرساخت" },
  { to: "/admin/proxies", label: "پراکسی‌ها", icon: Cable, end: true, group: "زیرساخت" },
  { to: "/admin/api-keys", label: "کلیدهای API", icon: KeyRound, end: true, group: "زیرساخت" },
];

function adminTitle(path: string): string {
  if (path === "/admin/proxies") return "پراکسی‌ها";
  if (path === "/admin/accounts") return "حساب‌ها";
  if (path === "/admin/api-keys") return "کلیدهای API";
  return "ورود به بخش زیرساخت";
}

/** Layout route for the whole /admin section (same look as the public app). */
export function AdminShell() {
  return <AppShell nav={ADMIN_NAV} titleFor={adminTitle} />;
}

/**
 * Gate: until the admin cookie is present the content area shows the login
 * form; the sidebar (زیرساخت group) stays visible either way.
 */
export function AdminGate() {
  const [status, setStatus] = useState<AdminStatus | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await adminMe());
    } catch {
      setStatus({ enabled: false, authenticated: false });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!status) {
    return <Skeleton className="h-40 w-full" />;
  }

  if (!status.authenticated) {
    return <LoginGate onAuthenticated={() => setStatus({ enabled: true, authenticated: true })} />;
  }

  return <Outlet />;
}

export function AdminAccountsPage() {
  return <AccountsPage />;
}

export function AdminProxiesPage() {
  return <ProxiesPage />;
}

function LoginGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      // On success the server sets the HttpOnly session cookie; when the gate
      // is disabled (no env credentials) it returns gated:false and the
      // infrastructure is simply open — either way we proceed.
      await adminLogin(username.trim(), password);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ورود ناموفق بود.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm">
      <Card>
        <CardHeader>
          <CardTitle>ورود به بخش زیرساخت</CardTitle>
          <CardDescription>حساب‌ها و پراکسی‌ها فقط با رمز عبور در دسترسند.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field label="نام کاربری" htmlFor="admin-user">
              <Input
                id="admin-user"
                dir="ltr"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </Field>
            <Field label="رمز عبور" htmlFor="admin-pass">
              <Input
                id="admin-pass"
                dir="ltr"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy || !username.trim() || !password}>
              <LockKeyhole />
              {busy ? "در حال ورود…" : "ورود"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
