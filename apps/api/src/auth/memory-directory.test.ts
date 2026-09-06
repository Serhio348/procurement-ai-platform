import { describe, expect, it } from "vitest";
import { AuthConflictError } from "./errors.js";
import { createMemoryAuthDirectory } from "./memory-directory.js";

describe("createMemoryAuthDirectory", () => {
  it("creates a pending account and ignores a later admin until approved", async () => {
    const directory = createMemoryAuthDirectory();
    const created = await directory.signUp({
      email: "User@Example.com",
      name: "Иван",
      password: "secret-password",
    });

    expect(created.email).toBe("user@example.com");
    expect(created.accessStatus).toBe("pending");
    expect(created.role).toBeNull();
    await expect(
      directory.signUp({
        email: "user@example.com",
        name: "Другой",
        password: "other-password",
      }),
    ).rejects.toBeInstanceOf(AuthConflictError);
  });

  it("lets an admin approve a pending user and keeps the last admin", async () => {
    const directory = createMemoryAuthDirectory();
    await directory.bootstrapAdmin("admin@example.com", "admin-password", "Администратор");
    const pending = await directory.signUp({
      email: "spec@example.com",
      name: "Специалист",
      password: "spec-password",
    });
    const approved = await directory.approve(pending.id, "specialist");

    expect(approved?.accessStatus).toBe("active");
    expect(approved?.role).toBe("specialist");
    const admins = (await directory.listUsers()).filter(
      (user) => user.role === "admin" && user.accessStatus === "active",
    );
    await expect(directory.revoke(admins[0]?.id ?? "")).rejects.toBeInstanceOf(AuthConflictError);
  });

  it("signs in only with the stored password after a reset", async () => {
    const directory = createMemoryAuthDirectory();
    await directory.signUp({
      email: "user@example.com",
      name: "Иван",
      password: "secret-password",
    });
    const token = await directory.createPasswordReset("user@example.com");
    expect(token).toBeDefined();
    await expect(directory.resetPassword(token ?? "", "new-password")).resolves.toBe(true);
    await expect(
      directory.signIn({ email: "user@example.com", password: "secret-password" }),
    ).resolves.toBeUndefined();
    const user = await directory.signIn({ email: "user@example.com", password: "new-password" });
    expect(user?.email).toBe("user@example.com");
  });

  it("returns the last seen time when a session is closed", async () => {
    let current = Date.parse("2026-09-06T12:00:00.000Z");
    const directory = createMemoryAuthDirectory(() => new Date(current));
    const created = await directory.signUp({
      email: "user@example.com",
      name: "Иван",
      password: "secret-password",
    });
    const token = await directory.createSession(created.id);
    current += 7 * 60_000;
    await directory.getBySessionToken(token);
    const closed = await directory.deleteSession(token);

    expect(closed?.userId).toBe(created.id);
    expect(closed?.startedAt).toBe("2026-09-06T12:00:00.000Z");
    expect(closed?.lastSeenAt).toBe("2026-09-06T12:07:00.000Z");
  });
});
