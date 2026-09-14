import { z } from "zod";
import { IsoDateTime } from "./common.js";

export const SpecialistRole = z.enum(["admin", "specialist", "viewer"]);
export type SpecialistRole = z.infer<typeof SpecialistRole>;

export const AccessStatus = z.enum(["pending", "active", "rejected", "revoked"]);
export type AccessStatus = z.infer<typeof AccessStatus>;

export const AuthCredentialsWrite = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
});
export type AuthCredentialsWrite = z.infer<typeof AuthCredentialsWrite>;

/** Sign-up never accepts a role or access status from the client. */
export const AuthSignUpWrite = AuthCredentialsWrite.extend({
  name: z.string().min(1).max(200),
});
export type AuthSignUpWrite = z.infer<typeof AuthSignUpWrite>;

export const AuthForgotPasswordWrite = z.object({
  email: z.string().email().max(320),
});
export type AuthForgotPasswordWrite = z.infer<typeof AuthForgotPasswordWrite>;

export const AuthResetPasswordWrite = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(200),
});
export type AuthResetPasswordWrite = z.infer<typeof AuthResetPasswordWrite>;

export const AuthSessionUser = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  role: SpecialistRole.nullable(),
  accessStatus: AccessStatus,
  pendingUserCount: z.number().int().nonnegative().optional(),
  errorEventCount: z.number().int().nonnegative().optional(),
});
export type AuthSessionUser = z.infer<typeof AuthSessionUser>;

export const AuthSessionResponse = z.object({
  user: AuthSessionUser.nullable(),
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponse>;

export const AdminUser = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  role: SpecialistRole.nullable(),
  accessStatus: AccessStatus,
  createdAt: IsoDateTime,
});
export type AdminUser = z.infer<typeof AdminUser>;

export const AdminUserListResponse = z.object({
  items: z.array(AdminUser),
  pendingCount: z.number().int().nonnegative(),
});
export type AdminUserListResponse = z.infer<typeof AdminUserListResponse>;

/** Read-only snapshot of another specialist's workspace for the admin pane. */
export const AdminCabinetSummary = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  role: SpecialistRole.nullable(),
  accessStatus: AccessStatus,
  workspaceId: z.string().uuid().optional(),
  profileCount: z.number().int().nonnegative(),
  mineCount: z.number().int().nonnegative(),
  archiveCount: z.number().int().nonnegative(),
  trashCount: z.number().int().nonnegative(),
  lastActiveAt: IsoDateTime.optional(),
});
export type AdminCabinetSummary = z.infer<typeof AdminCabinetSummary>;

export const AdminCabinetListResponse = z.object({
  items: z.array(AdminCabinetSummary),
});
export type AdminCabinetListResponse = z.infer<typeof AdminCabinetListResponse>;

export const AdminApproveWrite = z.object({
  role: SpecialistRole,
});
export type AdminApproveWrite = z.infer<typeof AdminApproveWrite>;

export const AdminRoleWrite = z.object({
  role: SpecialistRole,
});
export type AdminRoleWrite = z.infer<typeof AdminRoleWrite>;

export const AdminJournalKind = z.enum(["access", "search", "documents", "discovery", "platform"]);
export type AdminJournalKind = z.infer<typeof AdminJournalKind>;

export const AdminJournalLevel = z.enum(["info", "error"]);
export type AdminJournalLevel = z.infer<typeof AdminJournalLevel>;

export const AdminJournalEntry = z.object({
  id: z.string().uuid(),
  at: IsoDateTime,
  kind: AdminJournalKind,
  level: AdminJournalLevel,
  message: z.string().min(1).max(2000),
  actorName: z.string().max(200).optional(),
  actorEmail: z.string().email().optional(),
  sourceProcurementId: z.string().max(256).optional(),
  /** Set when an admin cleared the error: the row stays in the log but stops being active. */
  acknowledgedAt: IsoDateTime.optional(),
});
export type AdminJournalEntry = z.infer<typeof AdminJournalEntry>;

export const AdminJournalWrite = AdminJournalEntry.omit({
  id: true,
  at: true,
  acknowledgedAt: true,
}).extend({
  at: IsoDateTime.optional(),
});
export type AdminJournalWrite = z.infer<typeof AdminJournalWrite>;

export const AdminJournalListResponse = z.object({
  items: z.array(AdminJournalEntry),
  errorCount: z.number().int().nonnegative(),
});
export type AdminJournalListResponse = z.infer<typeof AdminJournalListResponse>;

export const WorkspaceKind = z.enum(["personal", "team"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;

export const WorkspaceMemberRole = z.enum(["owner", "member", "viewer"]);
export type WorkspaceMemberRole = z.infer<typeof WorkspaceMemberRole>;

/**
 * Resolved after the session cookie. `workspaceId` is never taken from the
 * client in personal mode — only from membership.
 */
export const RequestPrincipal = z.object({
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  role: SpecialistRole.nullable(),
  accessStatus: AccessStatus,
});
export type RequestPrincipal = z.infer<typeof RequestPrincipal>;
