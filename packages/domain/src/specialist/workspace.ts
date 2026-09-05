import {
  SpecialistTriageDecision,
  SpecialistWorkingProfile,
  SpecialistWorkspaceState,
  electricalEquipmentSeedV1,
  type SpecialistTriageKind,
  type SpecialistWorkingProfile as SpecialistWorkingProfileValue,
  type SpecialistWorkspaceState as SpecialistWorkspaceStateValue,
} from "@procurement/contracts";

export function defaultSpecialistWorkingProfile(): SpecialistWorkingProfileValue {
  return SpecialistWorkingProfile.parse({
    name: electricalEquipmentSeedV1.name,
    keywords: electricalEquipmentSeedV1.keywords,
    excludeKeywords: electricalEquipmentSeedV1.excludeKeywords,
    watchNewProcurements: false,
  });
}

export class SpecialistWorkspace {
  #profile: SpecialistWorkingProfileValue;
  readonly #decisions: SpecialistTriageDecision[] = [];

  constructor(profile: SpecialistWorkingProfileValue = defaultSpecialistWorkingProfile()) {
    this.#profile = SpecialistWorkingProfile.parse(profile);
  }

  static parse(raw: unknown): SpecialistWorkspace {
    const state = SpecialistWorkspaceState.parse(raw);
    const workspace = new SpecialistWorkspace(state.profile);
    for (const decision of state.decisions) {
      workspace.#decisions.push(SpecialistTriageDecision.parse(decision));
    }
    return workspace;
  }

  snapshot(): SpecialistWorkspaceStateValue {
    return SpecialistWorkspaceState.parse({
      profile: this.#profile,
      decisions: this.#decisions,
    });
  }

  profile(): SpecialistWorkingProfileValue {
    return this.#profile;
  }

  replaceProfile(input: {
    name: string;
    keywords: readonly string[];
    excludeKeywords: readonly string[];
  }): void {
    this.#profile = SpecialistWorkingProfile.parse({
      ...this.#profile,
      name: input.name,
      keywords: [...input.keywords],
      excludeKeywords: [...input.excludeKeywords],
    });
  }

  setWatch(watchNewProcurements: boolean): void {
    this.#profile = SpecialistWorkingProfile.parse({
      ...this.#profile,
      watchNewProcurements,
    });
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
