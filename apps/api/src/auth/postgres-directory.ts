import type { AccessStatus, SpecialistRole } from "@procurement/contracts";
import { authPasswordResets, authSessions, authUsers, type Database } from "@procurement/db";
import { hasActiveAdmin } from "@procurement/domain";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  RESET_TTL_MS,
  SESSION_TTL_MS,
  normalizeEmail,
  publicAuthRecord,
  type AuthDirectory,
  type AuthRecord,
} from "./directory.js";
import { AuthConflictError } from "./errors.js";
import { hashPassword, verifyPassword } from "./password.js";
import { hashToken, randomToken } from "./token.js";

function toRecord(row: {
  id: string;
  email: string;
  name: string;
  role: SpecialistRole | null;
  accessStatus: AccessStatus;
  createdAt: string;
}): AuthRecord {
  return publicAuthRecord({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    accessStatus: row.accessStatus,
    createdAt: row.createdAt,
  });
}

function sortUsers(items: AuthRecord[]): AuthRecord[] {
  return [...items].sort((left, right) => {
    if (left.accessStatus === "pending" && right.accessStatus !== "pending") return -1;
    if (right.accessStatus === "pending" && left.accessStatus !== "pending") return 1;
    return right.createdAt.localeCompare(left.createdAt);
  });
}

export function createPostgresAuthDirectory(
  db: Database,
  now: () => Date = () => new Date(),
): AuthDirectory {
  async function allUsers(): Promise<AuthRecord[]> {
    const rows = await db.select().from(authUsers);
    return sortUsers(rows.map(toRecord));
  }

  async function replaceStatus(
    id: string,
    next: { role?: SpecialistRole | null; accessStatus: AccessStatus },
  ): Promise<AuthRecord | undefined> {
    const current = (await allUsers()).find((user) => user.id === id);
    if (current === undefined) return undefined;
    const proposed = (await allUsers()).map((user) =>
      user.id === id
        ? {
            ...user,
            role: next.role === undefined ? user.role : next.role,
            accessStatus: next.accessStatus,
          }
        : user,
    );
    if (!hasActiveAdmin(proposed)) {
      throw new AuthConflictError("last_admin");
    }
    const updatedAt = now().toISOString();
    const rows = await db
      .update(authUsers)
      .set({
        ...(next.role === undefined ? {} : { role: next.role }),
        accessStatus: next.accessStatus,
        updatedAt,
      })
      .where(eq(authUsers.id, id))
      .returning();
    const row = rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  return {
    async signUp(input) {
      const email = normalizeEmail(input.email);
      const createdAt = now().toISOString();
      try {
        const rows = await db
          .insert(authUsers)
          .values({
            id: randomUUID(),
            email,
            name: input.name.trim(),
            passwordHash: await hashPassword(input.password),
            role: null,
            accessStatus: "pending",
            createdAt,
            updatedAt: createdAt,
          })
          .returning();
        const row = rows[0];
        if (row === undefined) throw new Error("auth_user_insert_empty");
        return toRecord(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AuthConflictError("email_taken");
        }
        throw error;
      }
    },

    async signIn(input) {
      const rows = await db
        .select()
        .from(authUsers)
        .where(eq(authUsers.email, normalizeEmail(input.email)))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return undefined;
      if (!(await verifyPassword(input.password, row.passwordHash))) return undefined;
      return toRecord(row);
    },

    async createSession(userId) {
      const token = randomToken();
      const createdAt = now().toISOString();
      await db.insert(authSessions).values({
        id: randomUUID(),
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(now().getTime() + SESSION_TTL_MS).toISOString(),
        createdAt,
      });
      return token;
    },

    async getBySessionToken(token) {
      const hashed = hashToken(token);
      const rows = await db
        .select({
          user: authUsers,
          expiresAt: authSessions.expiresAt,
        })
        .from(authSessions)
        .innerJoin(authUsers, eq(authSessions.userId, authUsers.id))
        .where(eq(authSessions.tokenHash, hashed))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return undefined;
      if (new Date(row.expiresAt).getTime() <= now().getTime()) {
        await db.delete(authSessions).where(eq(authSessions.tokenHash, hashed));
        return undefined;
      }
      return toRecord(row.user);
    },

    async deleteSession(token) {
      await db.delete(authSessions).where(eq(authSessions.tokenHash, hashToken(token)));
    },

    async deleteSessionsForUser(userId) {
      await db.delete(authSessions).where(eq(authSessions.userId, userId));
    },

    async countUsers() {
      const rows = await db.select({ id: authUsers.id }).from(authUsers);
      return rows.length;
    },

    async bootstrapAdmin(email, password, name) {
      if ((await this.countUsers()) > 0) return undefined;
      const createdAt = now().toISOString();
      const rows = await db
        .insert(authUsers)
        .values({
          id: randomUUID(),
          email: normalizeEmail(email),
          name: name.trim(),
          passwordHash: await hashPassword(password),
          role: "admin",
          accessStatus: "active",
          createdAt,
          updatedAt: createdAt,
        })
        .returning();
      const row = rows[0];
      return row === undefined ? undefined : toRecord(row);
    },

    async listUsers() {
      return allUsers();
    },

    async pendingCount() {
      const rows = await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.accessStatus, "pending"));
      return rows.length;
    },

    async approve(id, role) {
      return replaceStatus(id, { role, accessStatus: "active" });
    },

    async reject(id) {
      return replaceStatus(id, { accessStatus: "rejected" });
    },

    async revoke(id) {
      const updated = await replaceStatus(id, { accessStatus: "revoked" });
      if (updated !== undefined) {
        await this.deleteSessionsForUser(id);
      }
      return updated;
    },

    async changeRole(id, role) {
      const rows = await db.select().from(authUsers).where(eq(authUsers.id, id)).limit(1);
      const row = rows[0];
      if (row === undefined || row.accessStatus !== "active") return undefined;
      return replaceStatus(id, { role, accessStatus: "active" });
    },

    async createPasswordReset(email) {
      const rows = await db
        .select()
        .from(authUsers)
        .where(eq(authUsers.email, normalizeEmail(email)))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return undefined;
      await db.delete(authPasswordResets).where(eq(authPasswordResets.userId, row.id));
      const token = randomToken();
      await db.insert(authPasswordResets).values({
        id: randomUUID(),
        userId: row.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(now().getTime() + RESET_TTL_MS).toISOString(),
        createdAt: now().toISOString(),
      });
      return token;
    },

    async resetPassword(token, password) {
      const hashed = hashToken(token);
      const rows = await db
        .select()
        .from(authPasswordResets)
        .where(eq(authPasswordResets.tokenHash, hashed))
        .limit(1);
      const reset = rows[0];
      if (reset === undefined || new Date(reset.expiresAt).getTime() <= now().getTime()) {
        if (reset !== undefined) {
          await db.delete(authPasswordResets).where(eq(authPasswordResets.id, reset.id));
        }
        return false;
      }
      await db
        .update(authUsers)
        .set({ passwordHash: await hashPassword(password), updatedAt: now().toISOString() })
        .where(eq(authUsers.id, reset.userId));
      await db.delete(authPasswordResets).where(eq(authPasswordResets.id, reset.id));
      await this.deleteSessionsForUser(reset.userId);
      return true;
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}
