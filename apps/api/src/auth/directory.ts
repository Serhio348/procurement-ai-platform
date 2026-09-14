import type {
  AccessStatus,
  AuthCredentialsWrite,
  AuthSignUpWrite,
  SpecialistRole,
} from "@procurement/contracts";

export interface AuthRecord {
  id: string;
  email: string;
  name: string;
  role: SpecialistRole | null;
  accessStatus: AccessStatus;
  createdAt: string;
}

export interface ClosedAuthSession {
  userId: string;
  startedAt: string;
  lastSeenAt: string;
}

export interface AuthDirectory {
  signUp: (input: AuthSignUpWrite) => Promise<AuthRecord>;
  signIn: (input: AuthCredentialsWrite) => Promise<AuthRecord | undefined>;
  createSession: (userId: string) => Promise<string>;
  getBySessionToken: (token: string) => Promise<AuthRecord | undefined>;
  deleteSession: (token: string) => Promise<ClosedAuthSession | undefined>;
  deleteSessionsForUser: (userId: string) => Promise<void>;
  closeSessionsForUser: (userId: string) => Promise<ClosedAuthSession[]>;
  countUsers: () => Promise<number>;
  bootstrapAdmin: (email: string, password: string, name: string) => Promise<AuthRecord | undefined>;
  listUsers: () => Promise<AuthRecord[]>;
  /** Latest `last_seen_at` among sessions that are still open. */
  listLatestSeen: () => Promise<ReadonlyMap<string, string>>;
  pendingCount: () => Promise<number>;
  approve: (id: string, role: SpecialistRole) => Promise<AuthRecord | undefined>;
  reject: (id: string) => Promise<AuthRecord | undefined>;
  revoke: (id: string) => Promise<AuthRecord | undefined>;
  changeRole: (id: string, role: SpecialistRole) => Promise<AuthRecord | undefined>;
  createPasswordReset: (email: string) => Promise<string | undefined>;
  resetPassword: (token: string, password: string) => Promise<boolean>;
}

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_TOUCH_MS = 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function publicAuthRecord(record: AuthRecord): AuthRecord {
  return {
    id: record.id,
    email: record.email,
    name: record.name,
    role: record.role,
    accessStatus: record.accessStatus,
    createdAt: record.createdAt,
  };
}
