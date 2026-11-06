import { useCallback, useEffect, useState } from "react";
import { Cable, LockKeyhole, LogOut } from "lucide-react";
import { adminLogin, adminLogout, adminMe, type AdminStatus } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccountsPage } from "@/features/accounts/accounts";
import { ProxiesPage } from "@/features/proxies/proxies";

/**
 * زیرساخت — the admin-gated section (accounts + proxies).
 *
 * The infrastructure API (accounts/proxies/sessions) is protected by an
 * HttpOnly cookie session created via `POST /api/admin/login` (user/pass from
 * env). This page checks `GET /api/admin/me`: unauthenticated visitors see the
 * login form; authenticated ones get the two tabs (حساب‌ها / پراکسی‌ها) and a
 * logout action.
 */
export function AdminPage() {
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
      <div className="flex flex-col gap-3">
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!status.authenticated) {
    return <LoginGate onAuthenticated={() => setStatus({ enabled: true, authenticated: true })} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">بخش خصوصی: مدیریت حساب‌ها و پراکسی‌ها.</p>
        <Button variant="outline" size="sm" onClick={() => void adminLogout().then(load)}>
          <LogOut />
          خروج
        </Button>
      </div>
      <Tabs defaultValue="accounts">
        <TabsList aria-label="بخش‌های زیرساخت">
          <TabsTrigger value="accounts">حساب‌ها</TabsTrigger>
          <TabsTrigger value="proxies">
            <Cable className="size-3.5" />
            پراکسی‌ها
          </TabsTrigger>
        </TabsList>
        <TabsContent value="accounts" className="mt-4">
          <AccountsPage />
        </TabsContent>
        <TabsContent value="proxies" className="mt-4">
          <ProxiesPage />
        </TabsContent>
      </Tabs>
    </div>
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
