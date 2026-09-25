import { and, eq, ne } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  specialistTelegram,
  specialistTelegramCodes,
  specialistTelegramSent,
  workspaces,
} from "./schema.js";

export interface TelegramLink {
  userId: string;
  chatId: string;
  username: string | undefined;
  mode: "all" | "urgent";
}

/**
 * Persistence for the specialist Telegram bot: which console user owns which
 * chat, the one-time codes that create that link and the at-most-once marker
 * per announced inbox event. Lives next to auth tables because the link is
 * per user, not per profile.
 */
export interface TelegramStore {
  linkForUser(userId: string): Promise<TelegramLink | undefined>;
  linkByChat(chatId: string): Promise<TelegramLink | undefined>;
  linkForWorkspace(workspaceId: string): Promise<TelegramLink | undefined>;
  upsertLink(input: { userId: string; chatId: string; username?: string }): Promise<void>;
  deleteLink(userId: string): Promise<void>;
  setMode(userId: string, mode: "all" | "urgent"): Promise<void>;
  createLinkCode(input: { userId: string; code: string; expiresAt: Date }): Promise<void>;
  /** Returns the user id when the code is live; consumes (deletes) it either way. */
  consumeLinkCode(code: string): Promise<string | undefined>;
  /** True when this event was not announced before — insert is the dedupe. */
  markSent(workspaceId: string, eventKey: string): Promise<boolean>;
}

export function createPostgresTelegramStore(db: Database): TelegramStore {
  const toLink = (row: {
    userId: string;
    chatId: string;
    username: string | null;
    mode: string;
  }): TelegramLink => ({
    userId: row.userId,
    chatId: row.chatId,
    username: row.username ?? undefined,
    mode: row.mode === "urgent" ? "urgent" : "all",
  });
  return {
    async linkForUser(userId) {
      const rows = await db
        .select()
        .from(specialistTelegram)
        .where(eq(specialistTelegram.userId, userId));
      const row = rows[0];
      return row === undefined ? undefined : toLink(row);
    },
    async linkByChat(chatId) {
      const rows = await db
        .select()
        .from(specialistTelegram)
        .where(eq(specialistTelegram.chatId, chatId));
      const row = rows[0];
      return row === undefined ? undefined : toLink(row);
    },
    async linkForWorkspace(workspaceId) {
      const rows = await db
        .select({
          userId: specialistTelegram.userId,
          chatId: specialistTelegram.chatId,
          username: specialistTelegram.username,
          mode: specialistTelegram.mode,
        })
        .from(specialistTelegram)
        .innerJoin(workspaces, eq(workspaces.createdBy, specialistTelegram.userId))
        .where(eq(workspaces.id, workspaceId));
      const row = rows[0];
      return row === undefined ? undefined : toLink(row);
    },
    async upsertLink(input) {
      await db
        .insert(specialistTelegram)
        .values({
          userId: input.userId,
          chatId: input.chatId,
          username: input.username ?? null,
        })
        .onConflictDoUpdate({
          target: specialistTelegram.userId,
          set: {
            chatId: input.chatId,
            username: input.username ?? null,
            updatedAt: new Date().toISOString(),
          },
        });
      // A chat is one console user: a re-linked chat replaces the old row's
      // ownership rather than shadowing it.
      await db
        .delete(specialistTelegram)
        .where(
          and(eq(specialistTelegram.chatId, input.chatId), ne(specialistTelegram.userId, input.userId)),
        );
    },
    async deleteLink(userId) {
      await db.delete(specialistTelegram).where(eq(specialistTelegram.userId, userId));
    },
    async setMode(userId, mode) {
      await db
        .update(specialistTelegram)
        .set({ mode, updatedAt: new Date().toISOString() })
        .where(eq(specialistTelegram.userId, userId));
    },
    async createLinkCode(input) {
      await db.insert(specialistTelegramCodes).values({
        code: input.code,
        userId: input.userId,
        expiresAt: input.expiresAt.toISOString(),
      });
    },
    async consumeLinkCode(code) {
      const rows = await db
        .delete(specialistTelegramCodes)
        .where(eq(specialistTelegramCodes.code, code))
        .returning({ userId: specialistTelegramCodes.userId, expiresAt: specialistTelegramCodes.expiresAt });
      const row = rows[0];
      if (row === undefined) return undefined;
      return Date.parse(row.expiresAt) >= Date.now() ? row.userId : undefined;
    },
    async markSent(workspaceId, eventKey) {
      const inserted = await db
        .insert(specialistTelegramSent)
        .values({ workspaceId, eventKey })
        .onConflictDoNothing()
        .returning({ eventKey: specialistTelegramSent.eventKey });
      return inserted.length > 0;
    },
  };
}
