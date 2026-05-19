"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      data-testid="dashboard-logout"
      className="inline-flex h-9 items-center rounded-md border px-3 text-sm hover:bg-muted disabled:opacity-50"
      onClick={async () => {
        setBusy(true);
        try {
          await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
        } finally {
          router.replace("/login");
          router.refresh();
        }
      }}
    >
      退出登录
    </button>
  );
}
