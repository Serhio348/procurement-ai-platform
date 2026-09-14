import { describe, expect, it } from "vitest";
import { AdminCabinetSummary, AuthSignUpWrite, AuthSessionUser } from "./auth.js";

describe("AuthSignUpWrite", () => {
  it("keeps email, name and password and drops a client-supplied role", () => {
    const parsed = AuthSignUpWrite.parse({
      email: "user@example.com",
      name: "Иван",
      password: "secret-password",
      role: "admin",
      accessStatus: "active",
    });

    expect(parsed).toEqual({
      email: "user@example.com",
      name: "Иван",
      password: "secret-password",
    });
    expect(parsed).not.toHaveProperty("role");
    expect(parsed).not.toHaveProperty("accessStatus");
  });
});

describe("AuthSessionUser", () => {
  it("allows a pending account with no role yet", () => {
    const user = AuthSessionUser.parse({
      id: "user-1",
      email: "user@example.com",
      name: "Иван",
      role: null,
      accessStatus: "pending",
    });

    expect(user.role).toBeNull();
    expect(user.accessStatus).toBe("pending");
    expect(user.pendingUserCount).toBeUndefined();
  });
});

describe("AdminCabinetSummary", () => {
  it("keeps a cabinet readable without a live session or workspace id", () => {
    const summary = AdminCabinetSummary.parse({
      userId: "user-1",
      email: "user@example.com",
      name: "Иван",
      role: "specialist",
      accessStatus: "active",
      profileCount: 1,
      mineCount: 2,
      archiveCount: 0,
      trashCount: 3,
    });
    expect(summary.workspaceId).toBeUndefined();
    expect(summary.lastActiveAt).toBeUndefined();
  });
});
