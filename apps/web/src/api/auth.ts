import {
  AdminApproveWrite,
  AdminRoleWrite,
  AdminUserListResponse,
  AuthSessionResponse,
  type AdminUserListResponse as AdminUserListResponseValue,
  type AuthSessionUser,
  type SpecialistRole,
} from "@procurement/contracts";
import { withCredentials } from "./http.js";

export async function fetchSession(fetcher: typeof fetch = fetch): Promise<AuthSessionUser | null> {
  const response = await fetcher("/api/auth/session", withCredentials());
  if (!response.ok) {
    throw new Error("Не удалось проверить сессию");
  }
  return AuthSessionResponse.parse(await response.json()).user;
}

export async function signIn(
  email: string,
  password: string,
  fetcher: typeof fetch = fetch,
): Promise<AuthSessionUser> {
  const response = await fetcher(
    "/api/auth/sign-in",
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  if (!response.ok) {
    throw new Error(response.status === 401 ? "Неверный email или пароль" : "Не удалось войти");
  }
  const user = AuthSessionResponse.parse(await response.json()).user;
  if (user === null) throw new Error("Не удалось войти");
  return user;
}

export async function signUp(
  input: { email: string; name: string; password: string },
  fetcher: typeof fetch = fetch,
): Promise<AuthSessionUser> {
  const response = await fetcher(
    "/api/auth/sign-up",
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    throw new Error(
      response.status === 409 ? "Этот email уже зарегистрирован" : "Не удалось создать аккаунт",
    );
  }
  const user = AuthSessionResponse.parse(await response.json()).user;
  if (user === null) throw new Error("Не удалось создать аккаунт");
  return user;
}

export async function signOut(fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher("/api/auth/sign-out", withCredentials({ method: "POST" }));
  if (!response.ok) {
    throw new Error("Не удалось выйти");
  }
}

export async function forgotPassword(email: string, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher(
    "/api/auth/forgot-password",
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }),
  );
  if (response.status === 503) {
    throw new Error("Почтовый сервер не настроен. Обратитесь к администратору.");
  }
  if (!response.ok) {
    throw new Error("Не удалось отправить письмо");
  }
}

export async function resetPassword(
  token: string,
  password: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(
    "/api/auth/reset-password",
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    }),
  );
  if (!response.ok) {
    throw new Error("Ссылка недействительна или пароль слишком короткий");
  }
}

export async function fetchAdminUsers(
  fetcher: typeof fetch = fetch,
): Promise<AdminUserListResponseValue> {
  const response = await fetcher("/api/admin/users", withCredentials());
  if (!response.ok) {
    throw new Error("Не удалось загрузить пользователей");
  }
  return AdminUserListResponse.parse(await response.json());
}

export async function approveUser(
  id: string,
  role: SpecialistRole,
  fetcher: typeof fetch = fetch,
): Promise<AdminUserListResponseValue> {
  const response = await fetcher(
    `/api/admin/users/${id}/approve`,
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(AdminApproveWrite.parse({ role })),
    }),
  );
  if (!response.ok) {
    throw new Error("Не удалось одобрить заявку");
  }
  return AdminUserListResponse.parse(await response.json());
}

export async function rejectUser(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<AdminUserListResponseValue> {
  const response = await fetcher(
    `/api/admin/users/${id}/reject`,
    withCredentials({ method: "POST" }),
  );
  if (!response.ok) {
    throw new Error("Не удалось отклонить заявку");
  }
  return AdminUserListResponse.parse(await response.json());
}

export async function revokeUser(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<AdminUserListResponseValue> {
  const response = await fetcher(
    `/api/admin/users/${id}/revoke`,
    withCredentials({ method: "POST" }),
  );
  if (!response.ok) {
    throw new Error(response.status === 409 ? "Нельзя отозвать последнего администратора" : "Не удалось отозвать доступ");
  }
  return AdminUserListResponse.parse(await response.json());
}

export async function changeUserRole(
  id: string,
  role: SpecialistRole,
  fetcher: typeof fetch = fetch,
): Promise<AdminUserListResponseValue> {
  const response = await fetcher(
    `/api/admin/users/${id}`,
    withCredentials({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(AdminRoleWrite.parse({ role })),
    }),
  );
  if (!response.ok) {
    throw new Error(response.status === 409 ? "Нельзя снять последнего администратора" : "Не удалось сменить роль");
  }
  return AdminUserListResponse.parse(await response.json());
}
