import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramConnect, type TelegramApi } from "./TelegramConnect.js";

afterEach(cleanup);

function api(overrides: Partial<TelegramApi> = {}): TelegramApi {
  return {
    status: async () => ({ available: true, linked: false }),
    link: async () => ({ code: "abc", url: "https://t.me/bot?start=abc", expiresInSec: 600 }),
    setMode: async () => ({ available: true, linked: true, mode: "urgent" }),
    unlink: async () => ({ available: true, linked: false }),
    ...overrides,
  };
}

describe("TelegramConnect", () => {
  it("honestly shows an unavailable bot", async () => {
    render(<TelegramConnect api={api({ status: async () => ({ available: false, linked: false }) })} />);
    await waitFor(() =>
      expect(screen.getByText(/Бот не настроен на сервере/)).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: /Подключить/ })).toBeNull();
  });

  it("creates a link and offers to open the bot", async () => {
    const user = userEvent.setup();
    const link = vi.fn(api().link);
    window.open = vi.fn();
    render(<TelegramConnect api={api({ link })} />);

    await user.click(await screen.findByRole("button", { name: "Подключить Telegram" }));
    expect(link).toHaveBeenCalled();
    expect((await screen.findByRole("link", { name: "открыть бота" })).getAttribute("href")).toBe(
      "https://t.me/bot?start=abc",
    );
  });

  it("toggles mode and unlinks a connected chat", async () => {
    const user = userEvent.setup();
    const setMode = vi.fn(api().setMode);
    const unlink = vi.fn(api().unlink);
    render(
      <TelegramConnect
        api={api({
          status: async () => ({ available: true, linked: true, mode: "all", username: "ivan" }),
          setMode,
          unlink,
        })}
      />,
    );

    expect(await screen.findByText(/@ivan/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Только срочные" }));
    await waitFor(() => expect(setMode).toHaveBeenCalledWith("urgent"));
    await user.click(await screen.findByRole("button", { name: "Отключить" }));
    await waitFor(() => expect(unlink).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Подключить Telegram" });
  });
});
