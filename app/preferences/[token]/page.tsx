/**
 * 公开偏好中心页面（不需登录）。
 *
 * 路径：`/preferences/[token]`
 *
 * 设计：
 *  - Server Component 仅做一次 token 形式校验，避免向公开页注入 cookie 依赖
 *  - 真正的数据加载、提交逻辑放到 client 组件 PreferencesClient，调用同源 /api/preferences/[token]
 *  - 不依赖 dashboard layout（避免触发 sidebar 内的鉴权 hooks）
 *  - 不暴露完整邮箱，仅显示 emailMasked
 */

import PreferencesClient from "./preferences-client";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function PreferencesPage({ params }: PageProps) {
  const { token } = await params;
  if (!token || token.length > 128) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl font-semibold">链接无效</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          该偏好链接缺少必要参数或已过期，请检查邮件中的链接是否完整。
        </p>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-2xl p-6 sm:p-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">邮件订阅偏好</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          管理您接收的邮件分类。交易类邮件（如订单、安全提醒）不可关闭。
        </p>
      </header>
      <PreferencesClient token={token} />
    </main>
  );
}
