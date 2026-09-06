import {
  AdminApproveWrite,
  AdminRoleWrite,
  AdminUserListResponse,
  AuthCredentialsWrite,
  AuthForgotPasswordWrite,
  AuthResetPasswordWrite,
  AuthSessionResponse,
  AuthSignUpWrite,
  type AuthSessionUser,
} from "@procurement/contracts";
import {
  consoleCapability,
  mayAdministerUsers,
  mayReadSpecialistApi,
  mayWriteSpecialistApi,
} from "@procurement/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_TTL_MS, type AuthDirectory, type AuthRecord } from "./directory.js";
import { AuthConflictError } from "./errors.js";
import { clearSessionCookie, readCookie, SESSION_COOKIE, sessionCookie } from "./cookie.js";
import type { AuthMailPort } from "./mail.js";

export const TEST_SPECIALIST_SESSION: AuthRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "specialist@test.local",
  name: "Specialist",
  role: "specialist",
  accessStatus: "active",
  createdAt: "2026-09-06T00:00:00.000Z",
};

export interface RegisterAuthOptions {
  directory?: AuthDirectory;
  mail?: AuthMailPort;
  cookieSecure?: boolean;
  publicUrl?: string;
  internalApiToken?: string;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function registerAuth(app: FastifyInstance, options: RegisterAuthOptions = {}): void {
  const directory = options.directory;
  const mail = options.mail;
  const cookieSecure = options.cookieSecure === true;
  const publicUrl = (options.publicUrl ?? "http://127.0.0.1:5173").replace(/\/$/, "");
  const internalToken = options.internalApiToken?.trim() ?? "";

  const resolveUser = async (request: FastifyRequest): Promise<AuthRecord | undefined> => {
    if (directory === undefined) return TEST_SPECIALIST_SESSION;
    const token = readCookie(headerValue(request.headers.cookie), SESSION_COOKIE);
    if (token === undefined) return undefined;
    return directory.getBySessionToken(token);
  };

  const toSessionUser = async (user: AuthRecord | undefined): Promise<AuthSessionUser | null> => {
    if (user === undefined) return null;
    const pendingUserCount =
      user.role === "admin" && user.accessStatus === "active" && directory !== undefined
        ? await directory.pendingCount()
        : undefined;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      accessStatus: user.accessStatus,
      ...(pendingUserCount === undefined ? {} : { pendingUserCount }),
    };
  };

  const setSession = async (reply: FastifyReply, user: AuthRecord): Promise<void> => {
    if (directory === undefined) return;
    const token = await directory.createSession(user.id);
    reply.header(
      "set-cookie",
      sessionCookie(token, { secure: cookieSecure, maxAgeSec: Math.floor(SESSION_TTL_MS / 1000) }),
    );
  };

  app.addHook("onRequest", async (request, reply) => {
    const path = requestPath(request.url);
    if (path === "/api/health" || path.startsWith("/api/auth")) return;
    if (path === "/api/inbox/events" && request.method === "POST" && internalToken.length > 0) {
      if (headerValue(request.headers["x-internal-token"]) !== internalToken) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      return;
    }
    const user = await resolveUser(request);
    if (user === undefined) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const capability = consoleCapability(user);
    if (path.startsWith("/api/admin")) {
      if (!mayAdministerUsers(capability)) {
        return reply.code(403).send({ error: "forbidden" });
      }
      return;
    }
    if (!mayReadSpecialistApi(capability)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (WRITE_METHODS.has(request.method) && !mayWriteSpecialistApi(capability)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    return undefined;
  });

  app.get("/api/auth/session", async (request) => {
    const user = await resolveUser(request);
    return AuthSessionResponse.parse({ user: await toSessionUser(user) });
  });

  app.post("/api/auth/sign-up", async (request, reply) => {
    if (directory === undefined) {
      return reply.code(503).send({ error: "auth_unavailable" });
    }
    const parsed = AuthSignUpWrite.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    try {
      const user = await directory.signUp(parsed.data);
      await setSession(reply, user);
      return AuthSessionResponse.parse({ user: await toSessionUser(user) });
    } catch (error) {
      return mapAuthError(reply, error);
    }
  });

  app.post("/api/auth/sign-in", async (request, reply) => {
    if (directory === undefined) {
      return reply.code(503).send({ error: "auth_unavailable" });
    }
    const parsed = AuthCredentialsWrite.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const user = await directory.signIn(parsed.data);
    if (user === undefined) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    await setSession(reply, user);
    return AuthSessionResponse.parse({ user: await toSessionUser(user) });
  });

  app.post("/api/auth/sign-out", async (request, reply) => {
    if (directory !== undefined) {
      const token = readCookie(headerValue(request.headers.cookie), SESSION_COOKIE);
      if (token !== undefined) await directory.deleteSession(token);
    }
    reply.header("set-cookie", clearSessionCookie(cookieSecure));
    return AuthSessionResponse.parse({ user: null });
  });

  app.post("/api/auth/forgot-password", async (request, reply) => {
    if (directory === undefined) {
      return reply.code(503).send({ error: "auth_unavailable" });
    }
    if (mail === undefined) {
      return reply.code(503).send({ error: "smtp_unconfigured" });
    }
    const parsed = AuthForgotPasswordWrite.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const token = await directory.createPasswordReset(parsed.data.email);
    if (token !== undefined) {
      await mail.send({
        to: parsed.data.email.trim().toLowerCase(),
        subject: "Сброс пароля — Платформа закупок",
        text: `Ссылка для сброса пароля (действует 1 час):\n${publicUrl}/reset-password?token=${token}\n`,
      });
    }
    return { ok: true as const };
  });

  app.post("/api/auth/reset-password", async (request, reply) => {
    if (directory === undefined) {
      return reply.code(503).send({ error: "auth_unavailable" });
    }
    const parsed = AuthResetPasswordWrite.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const ok = await directory.resetPassword(parsed.data.token, parsed.data.password);
    if (!ok) {
      return reply.code(400).send({ error: "invalid_reset" });
    }
    reply.header("set-cookie", clearSessionCookie(cookieSecure));
    return { ok: true as const };
  });

  app.get("/api/admin/users", async (_request, reply) => {
    if (directory === undefined) {
      return reply.code(503).send({ error: "auth_unavailable" });
    }
    const items = await directory.listUsers();
    return AdminUserListResponse.parse({
      items,
      pendingCount: items.filter((item) => item.accessStatus === "pending").length,
    });
  });

  app.post("/api/admin/users/:id/approve", async (request, reply) => {
    return mutateAdminUser(request, reply, directory, async (store, id, body) => {
      const parsed = AdminApproveWrite.safeParse(body);
      if (!parsed.success) return { error: "invalid_request" as const };
      return store.approve(id, parsed.data.role);
    });
  });

  app.post("/api/admin/users/:id/reject", async (request, reply) => {
    return mutateAdminUser(request, reply, directory, (store, id) => store.reject(id));
  });

  app.post("/api/admin/users/:id/revoke", async (request, reply) => {
    return mutateAdminUser(request, reply, directory, (store, id) => store.revoke(id));
  });

  app.patch("/api/admin/users/:id", async (request, reply) => {
    return mutateAdminUser(request, reply, directory, async (store, id, body) => {
      const parsed = AdminRoleWrite.safeParse(body);
      if (!parsed.success) return { error: "invalid_request" as const };
      return store.changeRole(id, parsed.data.role);
    });
  });
}

async function mutateAdminUser(
  request: FastifyRequest,
  reply: FastifyReply,
  directory: AuthDirectory | undefined,
  act: (
    directory: AuthDirectory,
    id: string,
    body: unknown,
  ) => Promise<AuthRecord | undefined | { error: "invalid_request" }>,
): Promise<unknown> {
  if (directory === undefined) {
    return reply.code(503).send({ error: "auth_unavailable" });
  }
  const params = request.params as { id: string };
  try {
    const result = await act(directory, params.id, request.body ?? {});
    if (result !== undefined && "error" in result) {
      return reply.code(400).send({ error: result.error });
    }
    if (result === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    const items = await directory.listUsers();
    return AdminUserListResponse.parse({
      items,
      pendingCount: items.filter((item) => item.accessStatus === "pending").length,
    });
  } catch (error) {
    return mapAuthError(reply, error);
  }
}

function mapAuthError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthConflictError && error.code === "email_taken") {
    return reply.code(409).send({ error: "email_taken" });
  }
  if (error instanceof AuthConflictError && error.code === "last_admin") {
    return reply.code(409).send({ error: "last_admin" });
  }
  throw error;
}

function requestPath(url: string): string {
  const cut = url.indexOf("?");
  return cut === -1 ? url : url.slice(0, cut);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
