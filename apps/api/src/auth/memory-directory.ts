import { randomUUID } from "node:crypto";
import type { AccessStatus, SpecialistRole } from "@procurement/contracts";
import { hasActiveAdmin } from "@procurement/domain";
import {
  RESET_TTL_MS,
  SESSION_TOUCH_MS,
  SESSION_TTL_MS,
  normalizeEmail,
  publicAuthRecord,
  type AuthDirectory,
  type AuthRecord,
  type ClosedAuthSession,
} from "./directory.js";
import { AuthConflictError } from "./errors.js";
import { hashPassword, verifyPassword } from "./password.js";
import { hashToken, randomToken } from "./token.js";

interface StoredUser extends AuthRecord {
  passwordHash: string;
}

interface StoredSession {
  userId: string;
  tokenHash: string;
  expiresAt: number;
  startedAt: number;
  lastSeenAt: number;
}

interface StoredReset {
  userId: string;
  tokenHash: string;
  expiresAt: number;
}

export function createMemoryAuthDirectory(now: () => Date = () => new Date()): AuthDirectory {
  const users = new Map<string, StoredUser>();
  const byEmail = new Map<string, string>();
  const sessions = new Map<string, StoredSession>();
  const resets = new Map<string, StoredReset>();

  function listRecords(): AuthRecord[] {
    return [...users.values()]
      .map((user) => publicAuthRecord(user))
      .sort((left, right) => {
        if (left.accessStatus === "pending" && right.accessStatus !== "pending") return -1;
        if (right.accessStatus === "pending" && left.accessStatus !== "pending") return 1;
        return right.createdAt.localeCompare(left.createdAt);
      });
  }

  async function replaceStatus(
    id: string,
    next: { role?: SpecialistRole | null; accessStatus: AccessStatus },
  ): Promise<AuthRecord | undefined> {
    const current = users.get(id);
    if (current === undefined) return undefined;
    const proposed = listRecords().map((user) =>
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
    const updated: StoredUser = {
      ...current,
      role: next.role === undefined ? current.role : next.role,
      accessStatus: next.accessStatus,
    };
    users.set(id, updated);
    return publicAuthRecord(updated);
  }

  return {
    async signUp(input) {
      const email = normalizeEmail(input.email);
      if (byEmail.has(email)) {
        throw new AuthConflictError("email_taken");
      }
      const createdAt = now().toISOString();
      const user: StoredUser = {
        id: randomUUID(),
        email,
        name: input.name.trim(),
        role: null,
        accessStatus: "pending",
        createdAt,
        passwordHash: await hashPassword(input.password),
      };
      users.set(user.id, user);
      byEmail.set(email, user.id);
      return publicAuthRecord(user);
    },

    async signIn(input) {
      const id = byEmail.get(normalizeEmail(input.email));
      if (id === undefined) return undefined;
      const user = users.get(id);
      if (user === undefined) return undefined;
      if (!(await verifyPassword(input.password, user.passwordHash))) return undefined;
      return publicAuthRecord(user);
    },

    async createSession(userId) {
      const token = randomToken();
      const startedAt = now().getTime();
      sessions.set(hashToken(token), {
        userId,
        tokenHash: hashToken(token),
        expiresAt: startedAt + SESSION_TTL_MS,
        startedAt,
        lastSeenAt: startedAt,
      });
      return token;
    },

    async getBySessionToken(token) {
      const hashed = hashToken(token);
      const session = sessions.get(hashed);
      if (session === undefined) return undefined;
      const current = now().getTime();
      if (session.expiresAt <= current) {
        sessions.delete(hashed);
        return undefined;
      }
      if (current - session.lastSeenAt >= SESSION_TOUCH_MS) {
        session.lastSeenAt = current;
      }
      const user = users.get(session.userId);
      return user === undefined ? undefined : publicAuthRecord(user);
    },

    async deleteSession(token) {
      const hashed = hashToken(token);
      const session = sessions.get(hashed);
      if (session === undefined) return undefined;
      sessions.delete(hashed);
      return closedSession(session);
    },

    async deleteSessionsForUser(userId) {
      await this.closeSessionsForUser(userId);
    },

    async closeSessionsForUser(userId) {
      const closed: ClosedAuthSession[] = [];
      for (const [key, session] of sessions) {
        if (session.userId !== userId) continue;
        closed.push(closedSession(session));
        sessions.delete(key);
      }
      return closed;
    },

    async countUsers() {
      return users.size;
    },

    async bootstrapAdmin(email, password, name) {
      if (users.size > 0) return undefined;
      const createdAt = now().toISOString();
      const user: StoredUser = {
        id: randomUUID(),
        email: normalizeEmail(email),
        name: name.trim(),
        role: "admin",
        accessStatus: "active",
        createdAt,
        passwordHash: await hashPassword(password),
      };
      users.set(user.id, user);
      byEmail.set(user.email, user.id);
      return publicAuthRecord(user);
    },

    async listUsers() {
      return listRecords();
    },

    async listLatestSeen() {
      const latest = new Map<string, string>();
      const current = now().getTime();
      for (const session of sessions.values()) {
        if (session.expiresAt <= current) continue;
        const at = new Date(session.lastSeenAt).toISOString();
        const previous = latest.get(session.userId);
        if (previous === undefined || at > previous) latest.set(session.userId, at);
      }
      return latest;
    },

    async pendingCount() {
      return [...users.values()].filter((user) => user.accessStatus === "pending").length;
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
      const current = users.get(id);
      if (current === undefined || current.accessStatus !== "active") return undefined;
      return replaceStatus(id, { role, accessStatus: "active" });
    },

    async createPasswordReset(email) {
      const id = byEmail.get(normalizeEmail(email));
      if (id === undefined) return undefined;
      for (const [key, reset] of resets) {
        if (reset.userId === id) resets.delete(key);
      }
      const token = randomToken();
      resets.set(hashToken(token), {
        userId: id,
        tokenHash: hashToken(token),
        expiresAt: now().getTime() + RESET_TTL_MS,
      });
      return token;
    },

    async resetPassword(token, password) {
      const hashed = hashToken(token);
      const reset = resets.get(hashed);
      if (reset === undefined || reset.expiresAt <= now().getTime()) {
        resets.delete(hashed);
        return false;
      }
      const user = users.get(reset.userId);
      if (user === undefined) return false;
      users.set(user.id, { ...user, passwordHash: await hashPassword(password) });
      resets.delete(hashed);
      await this.deleteSessionsForUser(user.id);
      return true;
    },
  };
}

function closedSession(session: StoredSession): ClosedAuthSession {
  return {
    userId: session.userId,
    startedAt: new Date(session.startedAt).toISOString(),
    lastSeenAt: new Date(session.lastSeenAt).toISOString(),
  };
}
