export function withCredentials(init: RequestInit = {}): RequestInit {
  return { ...init, credentials: "include" };
}
