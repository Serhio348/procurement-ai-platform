import { NotificationId, type NotificationSendRequest, type NotificationUrgency } from "@procurement/contracts";

export interface InboxItem {
  id: NotificationId;
  title: string;
  body: string;
  urgency: NotificationUrgency;
  procurementId?: string;
  dedupeKey: string;
  deliveredAt: string;
}

export class MemoryInboxStore {
  readonly #byDedupe = new Map<string, InboxItem>();
  readonly #items: InboxItem[] = [];
  readonly #clock: () => Date;
  readonly #id: () => NotificationId;

  constructor(options?: { clock?: () => Date; id?: () => NotificationId }) {
    this.#clock = options?.clock ?? (() => new Date());
    this.#id = options?.id ?? (() => NotificationId.parse(crypto.randomUUID()));
  }

  send(request: NotificationSendRequest): { item: InboxItem; duplicate: boolean } {
    const existing = this.#byDedupe.get(request.dedupeKey);
    if (existing !== undefined) {
      return { item: existing, duplicate: true };
    }
    const item: InboxItem = {
      id: this.#id(),
      title: request.title,
      body: request.body,
      urgency: request.urgency,
      ...(request.procurementId === undefined ? {} : { procurementId: request.procurementId }),
      dedupeKey: request.dedupeKey,
      deliveredAt: this.#clock().toISOString(),
    };
    this.#byDedupe.set(request.dedupeKey, item);
    this.#items.push(item);
    return { item, duplicate: false };
  }

  list(): readonly InboxItem[] {
    return this.#items;
  }
}
