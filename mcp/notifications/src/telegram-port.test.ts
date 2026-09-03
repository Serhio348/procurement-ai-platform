import { describe, expect, it } from "vitest";
import { LiveTelegramSender, RecordingTelegramSender, TelegramSendError } from "./telegram-port.js";

describe("RecordingTelegramSender", () => {
  it("records already-formed text without calling the network", async () => {
    const sender = new RecordingTelegramSender();
    const result = await sender.send({ chatId: "42", text: "Статус изменился" });
    expect(result.messageId).toBe("1");
    expect(sender.sent).toEqual([{ chatId: "42", text: "Статус изменился", messageId: "1" }]);
  });
});

describe("LiveTelegramSender", () => {
  it("posts sendMessage and does not put the bot token in a thrown error", async () => {
    const token = "secret-bot-token";
    let postedUrl = "";
    const sender = new LiveTelegramSender({
      token,
      fetchImpl: async (url, init) => {
        postedUrl = String(url);
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          chat_id: "42",
          text: "Готово",
          disable_web_page_preview: true,
        });
        return Response.json({ ok: true, result: { message_id: 77 } });
      },
    });

    const result = await sender.send({ chatId: "42", text: "Готово" });
    expect(result.messageId).toBe("77");
    expect(postedUrl).toContain(`/bot${token}/sendMessage`);
  });

  it("maps a Bot API failure without echoing the token", async () => {
    const token = "secret-bot-token";
    const sender = new LiveTelegramSender({
      token,
      fetchImpl: async () => Response.json({ ok: false, description: "Forbidden" }, { status: 403 }),
    });

    await expect(sender.send({ chatId: "42", text: "Готово" })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TelegramSendError);
      expect((error as Error).message).toBe("Telegram send failed: Forbidden");
      expect((error as Error).message).not.toContain(token);
      return true;
    });
  });
});
