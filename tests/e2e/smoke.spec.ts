import { test, expect } from "@playwright/test";

test("访问 / 自动重定向到 /login，并显示登录占位页", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId("login-heading")).toContainText("管理员登录");
});
