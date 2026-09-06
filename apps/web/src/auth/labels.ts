import type { AccessStatus, SpecialistRole } from "@procurement/contracts";

export function roleLabel(role: SpecialistRole | null): string {
  if (role === "admin") return "Администратор";
  if (role === "specialist") return "Специалист";
  if (role === "viewer") return "Наблюдатель";
  return "Без роли";
}

export function accessMessage(status: AccessStatus): string {
  if (status === "rejected") return "Доступ не выдан.";
  if (status === "revoked") return "Доступ отозван.";
  return "Заявка отправлена. Администратор ещё не выдал доступ.";
}
