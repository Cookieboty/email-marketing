/**
 * 退订落地页 / 偏好中心的静态文案 i18n 字典（spec/email-template-multilingual §605）。
 *
 * 只覆盖收件人面向的极少量字符串：登陆、确认、结果、错误。
 * 不引入运行时依赖，纯 const 表。
 */

import type { Locale } from "@prisma/client";

export type UnsubscribeLocale = Locale;

export const UNSUBSCRIBE_FALLBACK_LOCALE: UnsubscribeLocale = "zh";

interface Dict {
  invalidTitle: string;
  invalidBody: string;
  invalidMissingToken: string;
  rateLimited: string;
  globalAlreadyTitle: string;
  globalAlreadyBody: string;
  globalSuccessTitle: string;
  globalSuccessBody: string;
  categorySuccessTitle: string;
  categorySuccessBody: (name: string) => string;
  categoryTransactionalTitle: string;
  categoryTransactionalBody: (name: string) => string;
  categoryNotFoundTitle: string;
  categoryNotFoundBody: string;
  topicAlreadyTitle: string;
  topicAlreadyBody: (name: string) => string;
  topicSuccessTitle: string;
  topicSuccessBody: (name: string) => string;
  topicNotFoundTitle: string;
  topicNotFoundBody: string;
  pageConfirmTitle: string;
  pageConfirmGlobal: (email: string) => string;
  pageConfirmCategory: (email: string, category: string) => string;
  pageButtonConfirm: string;
  pageButtonProcessing: string;
  pageButtonDone: string;
  pageButtonFailed: string;
  pageNetworkError: string;
  pageDoneGlobal: string;
  pageDoneCategory: (category: string) => string;
  pageLoading: string;
  pageMaskedFallback: string;
}

const DICTS: Record<UnsubscribeLocale, Dict> = {
  zh: {
    invalidTitle: "退订链接无效",
    invalidBody: "链接格式错误。请检查邮件中的链接是否完整。",
    invalidMissingToken: "缺少必要的 token 参数。请检查邮件中的链接是否完整。",
    rateLimited: "请求过于频繁，请稍后再试。",
    globalAlreadyTitle: "您已退订",
    globalAlreadyBody: "您此前已退订所有邮件，本次操作无变化。",
    globalSuccessTitle: "退订成功",
    globalSuccessBody: "您已成功退订全部邮件，将不再收到我们的任何邮件通知。",
    categorySuccessTitle: "退订成功",
    categorySuccessBody: (name) =>
      `您已成功退订「${name}」分类，仍可继续接收其他类型的邮件。`,
    categoryTransactionalTitle: "该邮件不可退订",
    categoryTransactionalBody: (name) =>
      `「${name}」属于交易类通知（如订单确认、账户安全），按法规和安全要求不可退订。`,
    categoryNotFoundTitle: "分类已下线",
    categoryNotFoundBody:
      "该订阅分类已被移除，本次操作未生效。如需全局退订，请使用邮件中的「退订所有邮件」链接。",
    topicAlreadyTitle: "您已退订",
    topicAlreadyBody: (name) =>
      `您此前已退订「${name}」主题，本次操作无变化。`,
    topicSuccessTitle: "退订成功",
    topicSuccessBody: (name) =>
      `您已成功退订「${name}」主题，仍可继续接收其他主题与分类的邮件。`,
    topicNotFoundTitle: "主题已下线",
    topicNotFoundBody:
      "该主题已被移除，本次操作未生效。如需全局退订，请使用邮件中的「退订所有邮件」链接。",
    pageConfirmTitle: "确认退订",
    pageConfirmGlobal: (email) =>
      `您确定要退订所有邮件吗？退订后，${email} 将不再收到我们的任何邮件通知。`,
    pageConfirmCategory: (email, category) =>
      `您确定要退订「${category}」分类的邮件吗？退订后，${email} 将不再收到该分类的邮件。`,
    pageButtonConfirm: "确认退订",
    pageButtonProcessing: "处理中...",
    pageButtonDone: "已退订",
    pageButtonFailed: "退订失败",
    pageNetworkError: "网络错误，请重试",
    pageDoneGlobal: "已成功退订所有邮件。",
    pageDoneCategory: (category) => `已成功退订「${category}」分类。`,
    pageLoading: "加载中...",
    pageMaskedFallback: "您的邮箱",
  },
  en: {
    invalidTitle: "Invalid unsubscribe link",
    invalidBody:
      "The link format is invalid. Please check that the link in the email is complete.",
    invalidMissingToken: "Missing required token. Please use the link from the email.",
    rateLimited: "Too many requests. Please try again later.",
    globalAlreadyTitle: "Already unsubscribed",
    globalAlreadyBody: "You have already unsubscribed from all emails. No change.",
    globalSuccessTitle: "Unsubscribed",
    globalSuccessBody:
      "You have been unsubscribed from all emails. You will no longer receive any notifications from us.",
    categorySuccessTitle: "Unsubscribed",
    categorySuccessBody: (name) =>
      `You have been unsubscribed from the "${name}" category. You can still receive other emails.`,
    categoryTransactionalTitle: "Cannot unsubscribe from this category",
    categoryTransactionalBody: (name) =>
      `"${name}" is a transactional category (such as order confirmations or account security) and cannot be unsubscribed for regulatory and security reasons.`,
    categoryNotFoundTitle: "Category removed",
    categoryNotFoundBody:
      "This category has been removed and no action was taken. To unsubscribe from all emails, use the global unsubscribe link in the email.",
    topicAlreadyTitle: "Already unsubscribed",
    topicAlreadyBody: (name) =>
      `You have already unsubscribed from "${name}". No change.`,
    topicSuccessTitle: "Unsubscribed",
    topicSuccessBody: (name) =>
      `You have been unsubscribed from the "${name}" topic. You can still receive other topics and categories.`,
    topicNotFoundTitle: "Topic removed",
    topicNotFoundBody:
      "This topic has been removed and no action was taken. To unsubscribe from all emails, use the global unsubscribe link in the email.",
    pageConfirmTitle: "Confirm unsubscribe",
    pageConfirmGlobal: (email) =>
      `Are you sure you want to unsubscribe from all emails? After unsubscribing, ${email} will no longer receive any emails from us.`,
    pageConfirmCategory: (email, category) =>
      `Are you sure you want to unsubscribe from the "${category}" category? After unsubscribing, ${email} will no longer receive emails of that category.`,
    pageButtonConfirm: "Confirm unsubscribe",
    pageButtonProcessing: "Processing...",
    pageButtonDone: "Unsubscribed",
    pageButtonFailed: "Unsubscribe failed",
    pageNetworkError: "Network error. Please retry.",
    pageDoneGlobal: "Successfully unsubscribed from all emails.",
    pageDoneCategory: (category) =>
      `Successfully unsubscribed from the "${category}" category.`,
    pageLoading: "Loading...",
    pageMaskedFallback: "your inbox",
  },
};

export function getUnsubscribeDict(
  locale: UnsubscribeLocale | null | undefined,
): Dict {
  if (locale && locale in DICTS) return DICTS[locale];
  return DICTS[UNSUBSCRIBE_FALLBACK_LOCALE];
}
