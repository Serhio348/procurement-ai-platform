export interface AuthMailPort {
  send: (input: { to: string; subject: string; text: string }) => Promise<void>;
}

export function createSmtpMailPort(env: NodeJS.ProcessEnv): AuthMailPort | undefined {
  const host = env["AUTH_SMTP_HOST"]?.trim() ?? "";
  const from = env["AUTH_SMTP_FROM"]?.trim() ?? "";
  if (host.length === 0 || from.length === 0) return undefined;
  const port = Number.parseInt(env["AUTH_SMTP_PORT"] ?? "587", 10);
  const user = env["AUTH_SMTP_USER"]?.trim() ?? "";
  const password = env["AUTH_SMTP_PASS"] ?? "";
  return {
    async send(input) {
      const nodemailer = await import("nodemailer");
      const transport = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        ...(user.length === 0 ? {} : { auth: { user, pass: password } }),
      });
      await transport.sendMail({
        from,
        to: input.to,
        subject: input.subject,
        text: input.text,
      });
      transport.close();
    },
  };
}
