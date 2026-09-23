import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmToast } from "./ConfirmToast.js";

afterEach(() => {
  cleanup();
});

describe("ConfirmToast", () => {
  it("confirms from the toast and cancels on Отмена or Escape", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConfirmToast message="Удалить закупку?" danger onConfirm={onConfirm} onCancel={onCancel} />,
    );

    expect(screen.getByRole("alertdialog", { name: "Подтвердите действие" })).toBeTruthy();
    expect(screen.queryByText(/193\./)).toBeNull();
    await user.click(screen.getByRole("button", { name: "ОК" }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    rerender(
      <ConfirmToast message="Удалить закупку?" danger onConfirm={onConfirm} onCancel={onCancel} />,
    );
    await user.click(screen.getByRole("button", { name: "Отмена" }));
    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("traps Tab/Shift+Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">outside</button>
        <ConfirmToast message="Удалить?" onConfirm={vi.fn()} onCancel={vi.fn()} />
      </div>,
    );

    const ok = screen.getByRole("button", { name: "ОК" });
    const cancel = screen.getByRole("button", { name: "Отмена" });
    expect(cancel === document.activeElement).toBe(true);

    // Cancel is the last control — Tab wraps back to «ОК».
    await user.tab();
    expect(ok === document.activeElement).toBe(true);
    await user.tab();
    expect(cancel === document.activeElement).toBe(true);
    // Shift+Tab from the first control wraps to the last.
    await user.tab({ shift: true });
    expect(ok === document.activeElement).toBe(true);
    await user.tab({ shift: true });
    expect(cancel === document.activeElement).toBe(true);
  });

  it("restores focus to the element that opened the dialog", async () => {
    function Harness({ open }: { open: boolean }) {
      return (
        <div>
          <button type="button">trigger</button>
          {open ? (
            <ConfirmToast message="Удалить?" onConfirm={vi.fn()} onCancel={vi.fn()} />
          ) : null}
        </div>
      );
    }
    const { rerender } = render(<Harness open={false} />);
    const trigger = screen.getByRole("button", { name: "trigger" });
    trigger.focus();

    rerender(<Harness open />);
    expect(screen.getByRole("button", { name: "Отмена" }) === document.activeElement).toBe(true);

    rerender(<Harness open={false} />);
    expect(trigger === document.activeElement).toBe(true);
  });
});
