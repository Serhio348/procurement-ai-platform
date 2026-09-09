import {
  SpecialistTriageDecision,
  SpecialistWorkingProfile,
  SpecialistWorkspaceState,
  electricalEquipmentSeedV1,
  type SpecialistProfileWrite,
  type SpecialistTriageKind,
  type SpecialistWorkingProfile as SpecialistWorkingProfileValue,
  type SpecialistWorkspaceState as SpecialistWorkspaceStateValue,
} from "@procurement/contracts";
import { resolvePlatformKeywords, sameSearchPhrases } from "./looking-for.js";

export function emptySpecialistWorkingProfile(
  id = crypto.randomUUID(),
): SpecialistWorkingProfileValue {
  return SpecialistWorkingProfile.parse({
    id,
    name: "",
    purpose: "",
    description: "",
    keywords: [],
    excludeKeywords: [],
    watchNewProcurements: false,
  });
}

export function defaultSpecialistWorkingProfile(): SpecialistWorkingProfileValue {
  return emptySpecialistWorkingProfile();
}

export function profileDisplayName(profile: { name: string }): string {
  const name = profile.name.trim();
  return name.length > 0 ? name : "Без названия";
}

export class SpecialistWorkspace {
  #profiles: SpecialistWorkingProfileValue[];
  #activeProfileId: string;
  readonly #decisions: SpecialistTriageDecision[] = [];
  #dismissedInboxIds: string[] = [];

  constructor(profile: SpecialistWorkingProfileValue = emptySpecialistWorkingProfile()) {
    const parsed = SpecialistWorkingProfile.parse(stripStockElectricalSeed(profile));
    this.#profiles = [parsed];
    this.#activeProfileId = parsed.id;
  }

  static parse(raw: unknown): SpecialistWorkspace {
    const state = SpecialistWorkspaceState.parse(migrateWorkspaceState(raw));
    const workspace = new SpecialistWorkspace(state.profiles[0]);
    workspace.#profiles = state.profiles.map((item) =>
      SpecialistWorkingProfile.parse(stripStockElectricalSeed(item)),
    );
    const active =
      workspace.#profiles.find((item) => item.id === state.activeProfileId) ?? workspace.#profiles[0];
    if (active === undefined) {
      throw new Error("workspace has no profiles");
    }
    workspace.#activeProfileId = active.id;
    workspace.#decisions.length = 0;
    for (const decision of state.decisions) {
      workspace.#decisions.push(SpecialistTriageDecision.parse(decision));
    }
    workspace.#dismissedInboxIds = [...state.dismissedInboxIds];
    return workspace;
  }

  snapshot(): SpecialistWorkspaceStateValue {
    return SpecialistWorkspaceState.parse({
      profiles: this.#profiles,
      activeProfileId: this.#activeProfileId,
      decisions: this.#decisions,
      dismissedInboxIds: this.#dismissedInboxIds,
    });
  }

  dismissedInboxIds(): readonly string[] {
    return this.#dismissedInboxIds;
  }

  setDismissedInboxIds(ids: readonly string[]): void {
    this.#dismissedInboxIds = [...new Set(ids)];
  }

  profiles(): readonly SpecialistWorkingProfileValue[] {
    return this.#profiles;
  }

  profile(): SpecialistWorkingProfileValue {
    return this.profileById(this.#activeProfileId);
  }

  findProfile(id: string): SpecialistWorkingProfileValue | undefined {
    return this.#profiles.find((item) => item.id === id);
  }

  profileById(id: string): SpecialistWorkingProfileValue {
    const found = this.findProfile(id);
    if (found === undefined) {
      throw new Error("profile_not_found");
    }
    return found;
  }

  activate(id: string): SpecialistWorkingProfileValue {
    const found = this.profileById(id);
    this.#activeProfileId = found.id;
    return found;
  }

  addProfile(): SpecialistWorkingProfileValue {
    const created = emptySpecialistWorkingProfile();
    this.#profiles.push(created);
    this.#activeProfileId = created.id;
    return created;
  }

  removeProfile(id: string): SpecialistWorkingProfileValue {
    this.profileById(id);
    if (this.#profiles.length === 1) {
      throw new Error("last_profile");
    }
    this.#profiles = this.#profiles.filter((item) => item.id !== id);
    if (this.#activeProfileId === id) {
      const next = this.#profiles[0];
      if (next === undefined) {
        throw new Error("workspace has no profiles");
      }
      this.#activeProfileId = next.id;
    }
    return this.profile();
  }

  replaceProfile(input: SpecialistProfileWrite): void {
    this.#replace(this.#activeProfileId, input);
  }

  replaceProfileById(id: string, input: SpecialistProfileWrite): SpecialistWorkingProfileValue {
    this.#replace(id, input);
    return this.profileById(id);
  }

  setWatch(watchNewProcurements: boolean): void {
    this.setWatchById(this.#activeProfileId, watchNewProcurements);
  }

  setWatchById(id: string, watchNewProcurements: boolean): SpecialistWorkingProfileValue {
    this.#profiles = this.#profiles.map((item) =>
      item.id === id
        ? SpecialistWorkingProfile.parse({ ...item, watchNewProcurements })
        : item,
    );
    return this.profileById(id);
  }

  recordDecision(sourceProcurementId: string, kind: SpecialistTriageKind, madeAt: string): void {
    this.#decisions.push(
      SpecialistTriageDecision.parse({ sourceProcurementId, kind, madeAt }),
    );
  }

  latestKind(sourceProcurementId: string): SpecialistTriageKind | undefined {
    for (let index = this.#decisions.length - 1; index >= 0; index -= 1) {
      const decision = this.#decisions[index];
      if (decision?.sourceProcurementId === sourceProcurementId) return decision.kind;
    }
    return undefined;
  }

  rejectedSourceIds(): Set<string> {
    return sourceIdsWithLatestKind(this.#decisions, "reject");
  }

  decidedSourceIds(): Set<string> {
    const ids = new Set<string>();
    for (const decision of this.#decisions) {
      ids.add(decision.sourceProcurementId);
    }
    return ids;
  }

  #replace(id: string, input: SpecialistProfileWrite): void {
    const current = this.profileById(id);
    const lookingFor = (input.description ?? "").trim();
    const keywords = resolvePlatformKeywords(lookingFor, input.keywords);
    const next = SpecialistWorkingProfile.parse({
      ...current,
      name: input.name.trim(),
      purpose: (input.purpose ?? "").trim() || lookingFor,
      description: lookingFor,
      keywords,
      excludeKeywords: input.excludeKeywords.map((phrase) => phrase.trim()).filter((phrase) => phrase.length > 0),
      statuses: input.statuses ?? current.statuses,
      filters: input.filters ?? current.filters,
    });
    this.#profiles = this.#profiles.map((item) => (item.id === id ? next : item));
  }
}

function migrateWorkspaceState(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) {
    const created = emptySpecialistWorkingProfile();
    return { profiles: [created], activeProfileId: created.id, decisions: [], dismissedInboxIds: [] };
  }
  const record = raw as {
    profiles?: unknown;
    profile?: unknown;
    activeProfileId?: unknown;
    decisions?: unknown;
    dismissedInboxIds?: unknown;
  };
  const dismissedInboxIds = Array.isArray(record.dismissedInboxIds) ? record.dismissedInboxIds : [];
  if (Array.isArray(record.profiles) && record.profiles.length > 0) {
    const profiles = record.profiles.map((item) =>
      SpecialistWorkingProfile.parse(stripStockElectricalSeed(item)),
    );
    const active =
      profiles.find((item) => item.id === record.activeProfileId) ?? profiles[0];
    return {
      profiles,
      activeProfileId: active?.id,
      decisions: record.decisions ?? [],
      dismissedInboxIds,
    };
  }
  if (record.profile !== undefined) {
    const profile = SpecialistWorkingProfile.parse(stripStockElectricalSeed(record.profile));
    return {
      profiles: [profile],
      activeProfileId: profile.id,
      decisions: record.decisions ?? [],
      dismissedInboxIds,
    };
  }
  const created = emptySpecialistWorkingProfile();
  return {
    profiles: [created],
    activeProfileId: created.id,
    decisions: record.decisions ?? [],
    dismissedInboxIds,
  };
}

function stripStockElectricalSeed(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const profile = raw as {
    name?: unknown;
    description?: unknown;
    keywords?: unknown;
  };
  const name = typeof profile.name === "string" ? profile.name : "";
  const description = typeof profile.description === "string" ? profile.description : "";
  const keywords = Array.isArray(profile.keywords)
    ? profile.keywords.filter((item): item is string => typeof item === "string")
    : [];
  const stockName = name === electricalEquipmentSeedV1.name;
  const stockDescription = description === electricalEquipmentSeedV1.description;
  const stockKeywords = sameSearchPhrases(keywords, electricalEquipmentSeedV1.keywords);
  if (!stockName && !stockDescription && !stockKeywords) return raw;
  return {
    ...raw,
    name: "",
    purpose: "",
    description: "",
    keywords: [],
    excludeKeywords: [],
  };
}

function sourceIdsWithLatestKind(
  decisions: readonly SpecialistTriageDecision[],
  kind: SpecialistTriageKind,
): Set<string> {
  const latest = new Map<string, SpecialistTriageKind>();
  for (const decision of decisions) {
    latest.set(decision.sourceProcurementId, decision.kind);
  }
  const ids = new Set<string>();
  for (const [sourceProcurementId, current] of latest) {
    if (current === kind) ids.add(sourceProcurementId);
  }
  return ids;
}
