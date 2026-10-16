import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { healthReady, setAdminToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";

interface AuthState {
  /** Whether a token has been supplied this session (in-memory only). */
  hasToken: boolean;
  /** True once /api/health/ready accepted the token (or auth is disabled). */
  verified: boolean;
  authenticate: (token: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

/** Read the current auth state anywhere in the tree. */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthGate>");
  return ctx;
}

/**
 * Wraps the app. The backend protects every /api route (except /api/health)
 * with an optional bearer admin token. We keep that token in memory for the
 * session only — never localStorage/sessionStorage — and gate the UI on a
 * successful readiness check.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [verified, setVerified] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");

  const authenticate = useCallback(async (token: string) => {
    const trimmed = token.trim();
    setChecking(true);
    setError(null);
    setAdminToken(trimmed || null);
    try {
      await healthReady();
      setHasToken(Boolean(trimmed));
      setVerified(true);
    } catch (err) {
      setVerified(false);
      setHasToken(false);
      setAdminToken(null);
      setError(err instanceof Error ? err.message : "تأیید توکن ناموفق بود.");
    } finally {
      setChecking(false);
    }
  }, []);

  const signOut = useCallback(() => {
    setAdminToken(null);
    setHasToken(false);
    setVerified(false);
    setTokenInput("");
    setError(null);
  }, []);

  const value = useMemo(
    () => ({ hasToken, verified, authenticate, signOut }),
    [hasToken, verified, authenticate, signOut],
  );

  if (verified) {
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm animate-fade-up">
        <CardHeader>
          <CardTitle>ورود به پنل مدیریت</CardTitle>
          <CardDescription>
            این اپلیکیشن روی شبکه‌ی محلی اجرا می‌شود. اگر روی سرور یک توکن مدیریت تنظیم باشد
            (NLO_ADMIN_TOKEN)، آن را وارد کنید.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void authenticate(tokenInput);
            }}
            className="flex flex-col gap-4"
          >
            <Field
              label="توکن مدیریت"
              htmlFor="admin-token"
              hint="در صورت نبود توکن، این فیلد را خالی بگذارید."
            >
              <Input
                id="admin-token"
                type="password"
                dir="ltr"
                autoComplete="off"
                placeholder="••••••••••••"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                disabled={checking}
              />
            </Field>
            {error && (
              <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="size-4 shrink-0" />
                {error}
              </p>
            )}
            <Button type="submit" disabled={checking}>
              {checking ? "در حال بررسی…" : "ورود"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
