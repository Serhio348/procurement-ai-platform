import { describe, expect, it } from "vitest";
import { AuthSignUpWrite, AuthSessionUser } from "./auth.js";

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
