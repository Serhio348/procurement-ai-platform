import { describe, expect, it } from "vitest";
import {
  consoleCapability,
  hasActiveAdmin,
  mayAdministerUsers,
  mayReadSpecialistApi,
  mayWriteSpecialistApi,
} from "./access.js";

describe("consoleCapability", () => {
  it("gives a pending account no console access even if a role leaked onto the record", () => {
    expect(consoleCapability({ accessStatus: "pending", role: "admin" })).toBe("none");
    expect(consoleCapability({ accessStatus: "rejected", role: "specialist" })).toBe("none");
    expect(consoleCapability({ accessStatus: "revoked", role: "viewer" })).toBe("none");
  });

  it("gives no access to an active account until an admin assigns a role", () => {
    expect(consoleCapability({ accessStatus: "active", role: null })).toBe("none");
  });

  it("maps active roles to read, write, or administer", () => {
    expect(consoleCapability({ accessStatus: "active", role: "viewer" })).toBe("read");
    expect(consoleCapability({ accessStatus: "active", role: "specialist" })).toBe("write");
    expect(consoleCapability({ accessStatus: "active", role: "admin" })).toBe("admin");
  });
});

describe("capability gates", () => {
  it("lets a viewer read and keeps write and admin for stronger roles", () => {
    expect(mayReadSpecialistApi("read")).toBe(true);
    expect(mayWriteSpecialistApi("read")).toBe(false);
    expect(mayAdministerUsers("read")).toBe(false);
    expect(mayWriteSpecialistApi("write")).toBe(true);
    expect(mayAdministerUsers("write")).toBe(false);
    expect(mayAdministerUsers("admin")).toBe(true);
  });

  it("refuses to drop the last active admin", () => {
    expect(
      hasActiveAdmin([
        { role: "admin", accessStatus: "revoked" },
        { role: "specialist", accessStatus: "active" },
      ]),
    ).toBe(false);
    expect(hasActiveAdmin([{ role: "admin", accessStatus: "active" }])).toBe(true);
  });
});
