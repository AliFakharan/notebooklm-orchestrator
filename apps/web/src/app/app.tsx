import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ToastProvider } from "@/components/ui/toast";
import { AuthGate } from "./auth-gate";
import { AppLayout } from "./app-layout";
import { DashboardPage } from "@/features/dashboard/dashboard";
import { CreateJobPage } from "@/features/jobs/create-job";
import { JobHistoryPage } from "@/features/jobs/job-history";
import { JobDetailsPage } from "@/features/jobs/job-details";
import { AccountsPage } from "@/features/accounts/accounts";
import { ProxiesPage } from "@/features/proxies/proxies";
import { ProvidersPage } from "@/features/providers/providers";
import { SettingsPage } from "@/features/settings/settings";

/**
 * Application root: the token gate wraps the whole app (the backend requires
 * it on every /api route except /api/health), then the router renders the
 * pages inside the shared RTL shell.
 */
export function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <AuthGate>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/new" element={<CreateJobPage />} />
              <Route path="/jobs" element={<JobHistoryPage />} />
              <Route path="/jobs/:id" element={<JobDetailsPage />} />
              <Route path="/accounts" element={<AccountsPage />} />
              <Route path="/proxies" element={<ProxiesPage />} />
              <Route path="/providers" element={<ProvidersPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </AuthGate>
      </BrowserRouter>
    </ToastProvider>
  );
}
