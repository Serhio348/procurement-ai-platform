import { describe, expect, it } from "vitest";
import { routeNotification } from "./route.js";

describe("routeNotification", () => {
  it("keeps non-urgent copy in the inbox and does not open Telegram", () => {
    expect(
      routeNotification({
        urgent: false,
        telegramChatIds: ["42"],
      }),
    ).toEqual({ inbox: true, telegramChatIds: [] });
  });

  it("adds Telegram only when the change is urgent and a chat exists", () => {
    expect(
      routeNotification({
        urgent: true,
        telegramChatIds: ["42", "99"],
      }),
    ).toEqual({ inbox: true, telegramChatIds: ["42", "99"] });
  });

  it("does not invent a Telegram chat when urgency is high but no destination was given", () => {
    expect(routeNotification({ urgent: true, telegramChatIds: [] })).toEqual({
      inbox: true,
      telegramChatIds: [],
    });
  });
});
