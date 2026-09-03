/**
 * Urgent ChangeEvents go to Telegram when a chat exists. Non-urgent copy
 * stays in the in-app inbox. The agent never invents a destination.
 */
export function routeNotification(input: {
  urgent: boolean;
  telegramChatIds: readonly string[];
}): { inbox: true; telegramChatIds: string[] } {
  return {
    inbox: true,
    telegramChatIds: input.urgent ? [...input.telegramChatIds] : [],
  };
}
