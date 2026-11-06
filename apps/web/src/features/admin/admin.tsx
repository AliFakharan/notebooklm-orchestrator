import { useCallback, useEffect, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { adminLogin, adminMe, type AdminStatus } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AccountsPage } from "@/features/accounts/accounts";
import { ProxiesPage } from "@/features/proxies/proxies";

/**
 * Standalone admin pages — rendered OUTSIDE the main app layout (no sidebar),
 * so the regular app (نمای کلی / درخواست جدید / تاریخچه) is not reachable from
 * here. There is no link to these pages anywhere in the main UI; the only way
 * in is typing the URL. Access is gated by the admin cookie: unauthenticated
 * visitors see the login form, authenticated ones see the page directly.
 */
function AdminShell({ title, children }: { title: string; children: React.ReactNode }) {
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
    return (
      <div className="flex min-h-screen flex-col gap-4 p-4">
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!status.authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <LoginGate onAuthenticated={() => setStatus({ enabled: true, authenticated: true })} />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <h1 className="min-w-0 truncate text-sm font-semibold" aria-live="polite">
          {title}
        </h1>
      </header>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

/** /admin/accounts — the accounts page behind the admin gate. */
export function AdminAccountsPage() {
  return (
    <AdminShell title="حساب‌ها">
      <AccountsPage />
    </AdminShell>
  );
}

/** /admin/proxies — the proxies page behind the admin gate. */
export function AdminProxiesPage() {
  return (
    <AdminShell title="پراکسی‌ها">
      <ProxiesPage />
    </AdminShell>
  );
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
    <div className="w-full max-w-sm">
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
