import type { AdminJournalEntry } from "@procurement/contracts";

export const ADMIN_PANES = ["access", "cabinets", "presence", "discovery", "errors", "journal"] as const;

export type AdminPane = (typeof ADMIN_PANES)[number];

const PRESENCE_LINE = /вошёл в консоль|вышел\.|закрыл предыдущую сессию/;

export function parseAdminPane(value: string | undefined): AdminPane | undefined {
  return ADMIN_PANES.find((pane) => pane === value);
}

export function adminPanePath(pane: AdminPane, userId?: string): string {
  if (pane === "cabinets" && userId !== undefined && userId.length > 0) {
    return `/admin/cabinets/${userId}`;
  }
  return `/admin/${pane}`;
}

export function adminPaneLabel(pane: AdminPane): string {
  if (pane === "access") return "Доступ";
  if (pane === "cabinets") return "Кабинеты";
  if (pane === "presence") return "Входы";
  if (pane === "discovery") return "Слежение";
  if (pane === "errors") return "Ошибки";
  return "Журнал";
}

export function adminPaneLead(pane: AdminPane): string {
  if (pane === "access") return "Заявки на вход и роли. Кто был в системе — во вкладке «Входы».";
  if (pane === "cabinets") {
    return "Сводка чужих кабинетов: профили и закупки. Только чтение, решения специалиста не меняются.";
  }
  if (pane === "presence") {
    return "Кто вошёл и сколько был в системе. Время — до последнего запроса, не до закрытия вкладки.";
  }
  if (pane === "discovery") {
    return "Фоновый сбор с площадки раз в час. Здесь видно, когда он последний раз прошёл.";
  }
  if (pane === "errors") return "Сбои поиска, слежения и документов. Счётчик — за 7 дней.";
  return "Полная лента обслуживания. Сырой журнал сервера сюда не выводим.";
}

export function isPresenceEntry(item: AdminJournalEntry): boolean {
  return item.kind === "access" && PRESENCE_LINE.test(item.message);
}

export function journalForPane(
  items: readonly AdminJournalEntry[],
  pane: AdminPane,
): readonly AdminJournalEntry[] {
  if (pane === "access" || pane === "cabinets") return [];
  if (pane === "presence") return items.filter(isPresenceEntry);
  if (pane === "discovery") return items.filter((item) => item.kind === "discovery");
  if (pane === "errors") return items.filter((item) => item.level === "error");
  return items;
}

export function lastDiscoveryEntry(
  items: readonly AdminJournalEntry[],
): AdminJournalEntry | undefined {
  return items.find((item) => item.kind === "discovery");
}
