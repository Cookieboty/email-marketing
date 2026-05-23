"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/dashboard", label: "控制台" },
  { href: "/users", label: "用户" },
  { href: "/tags", label: "标签" },
  { href: "/segments", label: "分群" },
  { href: "/subscription-categories", label: "订阅分类" },
  { href: "/templates", label: "模板" },
  { href: "/template-blocks", label: "模板片段" },
  { href: "/media", label: "媒体" },
  { href: "/campaigns", label: "活动" },
  { href: "/automations", label: "自动化" },
  { href: "/import-sources", label: "数据导入" },
  { href: "/api-clients", label: "API Clients" },
  { href: "/settings/smtp", label: "SMTP 配置" },
  { href: "/audit-log", label: "审计日志" },
] as const;

export default function Sidebar() {
  const pathname = usePathname();
  return (
    <aside
      data-testid="dashboard-sidebar"
      className="flex w-56 shrink-0 flex-col border-r bg-muted/30 px-3 py-4"
    >
      <nav className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname?.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              data-testid={`nav-${item.href.split("/").filter(Boolean).pop() ?? "root"}`}
              className={cn(
                "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
