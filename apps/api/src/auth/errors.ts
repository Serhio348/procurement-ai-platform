export class AuthConflictError extends Error {
  readonly code: "email_taken" | "last_admin";

  constructor(code: "email_taken" | "last_admin") {
    super(code);
    this.code = code;
  }
}
