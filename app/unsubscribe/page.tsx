"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***@***";
  const visible = local.length <= 2 ? local[0] + "*" : local[0] + "***" + local[local.length - 1];
  return `${visible}@${domain}`;
}

function UnsubscribeContent() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const email = params.get("email") ?? "";
  const category = params.get("category") ?? undefined;
  const masked = email ? maskEmail(email) : "您的邮箱";

  if (!token) {
    return (
      <div className="card">
        <h1>退订链接无效</h1>
        <p>缺少必要的 token 参数。请检查邮件中的链接是否完整。</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h1>确认退订</h1>
      <p>
        {category
          ? `您确定要退订「${category}」分类的邮件吗？退订后，${masked} 将不再收到该分类的邮件。`
          : `您确定要退订所有邮件吗？退订后，${masked} 将不再收到我们的任何邮件通知。`}
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const btn = e.currentTarget.querySelector("button") as HTMLButtonElement;
          btn.disabled = true;
          btn.textContent = "处理中...";
          try {
            const res = await fetch("/api/unsubscribe", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token, ...(category ? { category } : {}) }),
            });
            const data = await res.json();
            if (data.ok) {
              btn.textContent = "已退订";
              const p = document.createElement("p");
              p.textContent = category
                ? `已成功退订「${category}」分类。`
                : "已成功退订所有邮件。";
              btn.parentElement?.appendChild(p);
            } else {
              btn.textContent = "退订失败";
              btn.disabled = false;
            }
          } catch {
            btn.textContent = "网络错误，请重试";
            btn.disabled = false;
          }
        }}
      >
        <button
          type="submit"
          style={{
            marginTop: 16,
            padding: "10px 24px",
            background: "#dc2626",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 15,
          }}
        >
          确认退订
        </button>
      </form>
    </div>
  );
}

export default function UnsubscribePage() {
  return (
    <div
      style={{
        fontFamily: "system-ui, -apple-system, 'Segoe UI', Arial, sans-serif",
        background: "#f6f7f9",
        margin: 0,
        padding: "48px 16px",
        color: "#222",
        minHeight: "100vh",
      }}
    >
      <style>{`
        .card {
          max-width: 480px;
          margin: 0 auto;
          background: #fff;
          border-radius: 8px;
          padding: 32px;
          box-shadow: 0 1px 3px rgba(0,0,0,.1);
        }
        h1 { margin: 0 0 16px; font-size: 20px; }
        p { line-height: 1.6; margin: 8px 0; }
      `}</style>
      <Suspense fallback={<div className="card"><p>加载中...</p></div>}>
        <UnsubscribeContent />
      </Suspense>
    </div>
  );
}
