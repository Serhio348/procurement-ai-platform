import type { AccessStatus, SpecialistRole } from "@procurement/contracts";

export type ConsoleCapability = "none" | "read" | "write" | "admin";

export function consoleCapability(user: {
  accessStatus: AccessStatus;
  role: SpecialistRole | null;
}): ConsoleCapability {
  if (user.accessStatus !== "active" || user.role === null) {
    return "none";
  }
  if (user.role === "admin") return "admin";
  if (user.role === "specialist") return "write";
  return "read";
}

export function mayReadSpecialistApi(capability: ConsoleCapability): boolean {
  return capability !== "none";
}

export function mayWriteSpecialistApi(capability: ConsoleCapability): boolean {
  return capability === "write" || capability === "admin";
}

export function mayAdministerUsers(capability: ConsoleCapability): boolean {
  return capability === "admin";
}

export function hasActiveAdmin(
  users: readonly { role: SpecialistRole | null; accessStatus: AccessStatus }[],
): boolean {
  return users.some((user) => user.accessStatus === "active" && user.role === "admin");
}
