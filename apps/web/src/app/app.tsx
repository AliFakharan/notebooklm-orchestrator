import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ToastProvider } from "@/components/ui/toast";
import { AppLayout } from "./app-layout";
import { DashboardPage } from "@/features/dashboard/dashboard";
import { CreateJobPage } from "@/features/jobs/create-job";
import { JobHistoryPage } from "@/features/jobs/job-history";
import { JobDetailsPage } from "@/features/jobs/job-details";
import { AdminAccountsPage, AdminGate, AdminProxiesPage, AdminShell } from "@/features/admin/admin";

/**
 * Application root: local single-user app (no login — the server is
 * loopback-only), so the public pages render inside the shared RTL shell.
 *
 * The /admin section reuses the SAME shell but shows the «زیرساخت» sidebar
 * group (حساب‌ها / پراکسی‌ها) instead of «کار اصلی», and is gated behind the
 * admin cookie. It has no entry link in the public UI — only reachable by URL.
 */
export function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          {/* Public (jobs) section. */}
          <Route element={<AppLayout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/new" element={<CreateJobPage />} />
            <Route path="/jobs" element={<JobHistoryPage />} />
            <Route path="/jobs/:id" element={<JobDetailsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>

          {/* Gated infrastructure section — same look, own sidebar group. */}
          <Route path="/admin" element={<AdminShell />}>
            <Route element={<AdminGate />}>
              <Route index element={<Navigate to="accounts" replace />} />
              <Route path="accounts" element={<AdminAccountsPage />} />
              <Route path="proxies" element={<AdminProxiesPage />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
