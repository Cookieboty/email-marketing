/**
 * 公开退订落地页（备用入口）。
 *
 * 邮件正文中的 unsubscribe_link 已经直接指向 /api/unsubscribe 的 GET HTML 落
 * 地页（更轻量），本页面主要用于：
 *  - 偏好中心 / 用户手动复制链接的浏览器访问
 *  - 测试发送场景下的开发者预览
 *
 * spec/email-template-multilingual §605：按 User.locale 渲染 zh/en 静态文案。
 * 本页是 Server Component，按 token 查一次 user.locale 后把字符串下发到内
 * 联的 client form 组件用于交互。
 */

import { prisma } from "@/lib/prisma";
import { getUnsubscribeDict } from "@/lib/modules/subscription-category/unsubscribe-i18n";
import { UnsubscribeForm } from "./_components/unsubscribe-form";

function maskEmail(email: string, fallback: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return fallback;
  const visible =
    local.length <= 2
      ? `${local[0]}*`
      : `${local[0]}***${local[local.length - 1]}`;
  return `${visible}@${domain}`;
}

interface SearchParams {
  token?: string;
  email?: string;
  category?: string;
}

export const dynamic = "force-dynamic";

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const token = (params.token ?? "").trim();
  const explicitEmail = (params.email ?? "").trim();
  const category = (params.category ?? "").trim() || undefined;

  const user = token
    ? await prisma.user.findUnique({
        where: { unsubscribeToken: token },
        select: { email: true, locale: true },
      })
    : null;
  const dict = getUnsubscribeDict(user?.locale ?? null);

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
      {(() => {
        if (!token) {
          return (
            <div className="card">
              <h1>{dict.invalidTitle}</h1>
              <p>{dict.invalidMissingToken}</p>
            </div>
          );
        }
        const masked = maskEmail(
          user?.email ?? explicitEmail,
          dict.pageMaskedFallback,
        );
        return (
          <div className="card">
            <h1>{dict.pageConfirmTitle}</h1>
            <p>
              {category
                ? dict.pageConfirmCategory(masked, category)
                : dict.pageConfirmGlobal(masked)}
            </p>
            <UnsubscribeForm
              token={token}
              category={category}
              labels={{
                confirm: dict.pageButtonConfirm,
                processing: dict.pageButtonProcessing,
                done: dict.pageButtonDone,
                failed: dict.pageButtonFailed,
                network: dict.pageNetworkError,
                doneText: category
                  ? dict.pageDoneCategory(category)
                  : dict.pageDoneGlobal,
              }}
            />
          </div>
        );
      })()}
    </div>
  );
}
