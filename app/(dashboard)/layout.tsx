import type { ReactNode } from "react";
import LogoutButton from "./_components/logout-button";
import Sidebar from "./_components/sidebar";
import { ToastProvider } from "@/components/ui/toast";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-col">
        <header className="flex items-center justify-between border-b px-6 py-3">
          <div className="text-sm font-semibold tracking-tight" data-testid="dashboard-brand">
            Email Marketing · 后台
          </div>
          <LogoutButton />
        </header>
        <div className="flex flex-1">
          <Sidebar />
          <main className="flex-1 px-6 py-6">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
