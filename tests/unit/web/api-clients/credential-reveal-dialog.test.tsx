import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { CredentialRevealDialog } from "@/app/(dashboard)/api-clients/_components/credential-reveal-dialog";
import { ToastProvider } from "@/components/ui/toast";

function renderDialog(props: Partial<React.ComponentProps<typeof CredentialRevealDialog>> = {}) {
  const onOpenChange = vi.fn();
  const utils = render(
    <ToastProvider>
      <CredentialRevealDialog
        open
        title="新建成功"
        description="请妥善保存以下凭据，关闭后将无法再次查看。"
        token="tk_live_abcdef1234567890"
        onOpenChange={onOpenChange}
        {...props}
      />
    </ToastProvider>,
  );
  return { ...utils, onOpenChange };
}

describe("CredentialRevealDialog", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    document.execCommand = vi.fn();
  });

  it("展示 token 与可选 hmacSecret，点击复制调用 clipboard 并弹 toast", async () => {
    renderDialog({ hmacSecret: "secret_xyz" });

    expect(screen.getByText(/请妥善保存/)).toBeInTheDocument();
    expect(screen.getByTestId("credential-token")).toHaveTextContent(
      "tk_live_abcdef1234567890",
    );
    expect(screen.getByTestId("credential-hmac")).toHaveTextContent("secret_xyz");

    await act(async () => {
      fireEvent.click(screen.getByTestId("copy-token"));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "tk_live_abcdef1234567890",
    );
    expect(screen.getByTestId("toast")).toHaveTextContent(/已复制/);
  });

  it("未提供 hmacSecret 时不渲染 hmac 块", () => {
    renderDialog();
    expect(screen.queryByTestId("credential-hmac")).toBeNull();
  });

  it("点击关闭按钮触发 onOpenChange(false) 并执行 onClosed", () => {
    const onClosed = vi.fn();
    const { onOpenChange } = renderDialog({ onClosed });
    fireEvent.click(screen.getByTestId("credential-close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onClosed).toHaveBeenCalled();
  });

  it("clipboard 不可用时降级 execCommand 复制", async () => {
    Object.assign(navigator, { clipboard: undefined });
    vi.mocked(document.execCommand).mockReturnValue(true);

    renderDialog();

    await act(async () => {
      fireEvent.click(screen.getByTestId("copy-token"));
    });
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(screen.getByTestId("toast")).toHaveTextContent(/已复制/);
  });
});
