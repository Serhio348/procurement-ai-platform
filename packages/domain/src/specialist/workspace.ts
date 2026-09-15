import {
  SpecialistReviewVerdict,
  SpecialistTriageDecision,
  SpecialistWorkingProfile,
  SpecialistWorkspaceState,
  type SpecialistProfileWrite,
  type SpecialistTriageKind,
  type SpecialistWorkingProfile as SpecialistWorkingProfileValue,
  type SpecialistWorkspaceState as SpecialistWorkspaceStateValue,
} from "@procurement/contracts";
import { resolvePlatformKeywords, sameSearchPhrases } from "./looking-for.js";

/** How long a review verdict of "irrelevant" is trusted before the hit may be looked at again. */
export const REVIEW_VERDICT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const REVIEW_ALGORITHM_VERSION = "search-review-v2";

/**
 * Margin subtracted from lastDiscoveryAt when asking the source for new
 * procedures. Covers clock skew and procedures posted with a past date.
 */
export const DISCOVERY_WATERMARK_MARGIN_MS = 24 * 60 * 60 * 1000;

/** Calendar day (YYYY-MM-DD) the next discovery pass should ask the source from, or undefined for a full pass. */
export function discoveryPublishedFrom(
  profile: Pick<SpecialistWorkingProfileValue, "lastDiscoveryAt">,
): string | undefined {
  if (profile.lastDiscoveryAt === undefined) return undefined;
  const since = Date.parse(profile.lastDiscoveryAt) - DISCOVERY_WATERMARK_MARGIN_MS;
  if (!Number.isFinite(since)) return undefined;
  return new Date(since).toISOString().slice(0, 10);
}

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
  #reviewedIrrelevant: SpecialistReviewVerdict[] = [];
  #archivedSourceIds = new Set<string>();

  constructor(profile: SpecialistWorkingProfileValue = emptySpecialistWorkingProfile()) {
    const parsed = SpecialistWorkingProfile.parse(profile);
    this.#profiles = [parsed];
    this.#activeProfileId = parsed.id;
  }

  static parse(raw: unknown): SpecialistWorkspace {
    const state = SpecialistWorkspaceState.parse(migrateWorkspaceState(raw));
    const workspace = new SpecialistWorkspace(state.profiles[0]);
    workspace.#profiles = state.profiles.map((item) => SpecialistWorkingProfile.parse(item));
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
    workspace.#reviewedIrrelevant = state.reviewedIrrelevant.filter(
      (item) => item.algorithmVersion === REVIEW_ALGORITHM_VERSION,
    );
    workspace.#archivedSourceIds = new Set(state.archivedSourceIds);
    return workspace;
  }

  snapshot(): SpecialistWorkspaceStateValue {
    return SpecialistWorkspaceState.parse({
      profiles: this.#profiles,
      activeProfileId: this.#activeProfileId,
      decisions: this.#decisions,
      dismissedInboxIds: this.#dismissedInboxIds,
      reviewedIrrelevant: this.#reviewedIrrelevant,
      archivedSourceIds: [...this.#archivedSourceIds],
    });
  }

  /** Records that a discovery pass for the profile finished at `at`. */
  markDiscovered(id: string, at: string): SpecialistWorkingProfileValue {
    this.#profiles = this.#profiles.map((item) =>
      item.id === id ? SpecialistWorkingProfile.parse({ ...item, lastDiscoveryAt: at }) : item,
    );
    return this.profileById(id);
  }

  rememberIrrelevant(profileId: string, sourceProcurementId: string, decidedAt: string): void {
    if (this.isReviewedIrrelevant(profileId, sourceProcurementId)) return;
    this.#reviewedIrrelevant.push(
      SpecialistReviewVerdict.parse({
        profileId,
        sourceProcurementId,
        decidedAt,
        algorithmVersion: REVIEW_ALGORITHM_VERSION,
      }),
    );
  }

  isReviewedIrrelevant(profileId: string, sourceProcurementId: string): boolean {
    return this.#reviewedIrrelevant.some(
      (item) => item.profileId === profileId && item.sourceProcurementId === sourceProcurementId,
    );
  }

  reviewedIrrelevantSourceIds(profileId: string): ReadonlySet<string> {
    return new Set(
      this.#reviewedIrrelevant
        .filter((item) => item.profileId === profileId)
        .map((item) => item.sourceProcurementId),
    );
  }

  /** Forgets verdicts older than `maxAgeMs` and verdicts of profiles that no longer exist. */
  forgetStaleVerdicts(now: string, maxAgeMs = REVIEW_VERDICT_MAX_AGE_MS): number {
    const cutoff = Date.parse(now) - maxAgeMs;
    const profileIds = new Set(this.#profiles.map((item) => item.id));
    const before = this.#reviewedIrrelevant.length;
    this.#reviewedIrrelevant = this.#reviewedIrrelevant.filter(
      (item) => profileIds.has(item.profileId) && Date.parse(item.decidedAt) >= cutoff,
    );
    return before - this.#reviewedIrrelevant.length;
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

  /**
   * Archive is a shelf next to the triage decision, not a decision itself:
   * a monitored case comes back as "monitor", a participated one as
   * "participate", and an archived case stops being re-read by monitoring.
   */
  setArchived(sourceProcurementId: string, archived: boolean): void {
    if (archived) {
      this.#archivedSourceIds.add(sourceProcurementId);
    } else {
      this.#archivedSourceIds.delete(sourceProcurementId);
    }
  }

  isArchived(sourceProcurementId: string): boolean {
    return this.#archivedSourceIds.has(sourceProcurementId);
  }

  archivedSourceIds(): Set<string> {
    return new Set(this.#archivedSourceIds);
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

  /** Kind to restore after «Убрать»: last Слежу/Участвую, otherwise Слежу. */
  lastWorkingKind(sourceProcurementId: string): "monitor" | "participate" {
    for (let index = this.#decisions.length - 1; index >= 0; index -= 1) {
      const decision = this.#decisions[index];
      if (decision?.sourceProcurementId !== sourceProcurementId) continue;
      if (decision.kind === "monitor" || decision.kind === "participate") return decision.kind;
    }
    return "monitor";
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
    const excludeKeywords = input.excludeKeywords
      .map((phrase) => phrase.trim())
      .filter((phrase) => phrase.length > 0);
    // New search phrases mean the source must be re-read from scratch and
    // earlier "irrelevant" verdicts no longer describe this profile.
    const phrasesChanged =
      !sameSearchPhrases(keywords, current.keywords) ||
      !sameSearchPhrases(excludeKeywords, current.excludeKeywords);
    const next = SpecialistWorkingProfile.parse({
      ...current,
      lastDiscoveryAt: phrasesChanged ? undefined : current.lastDiscoveryAt,
      name: input.name.trim(),
      purpose: (input.purpose ?? "").trim() || lookingFor,
      description: lookingFor,
      keywords,
      excludeKeywords,
      statuses: input.statuses ?? current.statuses,
      excludeSingleSource: input.excludeSingleSource,
      filters: input.filters ?? current.filters,
    });
    this.#profiles = this.#profiles.map((item) => (item.id === id ? next : item));
    if (phrasesChanged) {
      this.#reviewedIrrelevant = this.#reviewedIrrelevant.filter((item) => item.profileId !== id);
    }
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
    reviewedIrrelevant?: unknown;
    archivedSourceIds?: unknown;
  };
  const dismissedInboxIds = Array.isArray(record.dismissedInboxIds) ? record.dismissedInboxIds : [];
  const reviewedIrrelevant = Array.isArray(record.reviewedIrrelevant) ? record.reviewedIrrelevant : [];
  const archivedSourceIds = Array.isArray(record.archivedSourceIds) ? record.archivedSourceIds : [];
  if (Array.isArray(record.profiles) && record.profiles.length > 0) {
    const profiles = record.profiles.map((item) => SpecialistWorkingProfile.parse(item));
    const active =
      profiles.find((item) => item.id === record.activeProfileId) ?? profiles[0];
    return {
      profiles,
      activeProfileId: active?.id,
      decisions: record.decisions ?? [],
      dismissedInboxIds,
      reviewedIrrelevant,
      archivedSourceIds,
    };
  }
  if (record.profile !== undefined) {
    const profile = SpecialistWorkingProfile.parse(record.profile);
    return {
      profiles: [profile],
      activeProfileId: profile.id,
      decisions: record.decisions ?? [],
      dismissedInboxIds,
      reviewedIrrelevant,
      archivedSourceIds,
    };
  }
  const created = emptySpecialistWorkingProfile();
  return {
    profiles: [created],
    activeProfileId: created.id,
    decisions: record.decisions ?? [],
    dismissedInboxIds,
    reviewedIrrelevant,
    archivedSourceIds,
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
