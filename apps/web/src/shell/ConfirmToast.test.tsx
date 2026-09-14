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
});
