import type {
  CapabilityId,
  DomainProfileId,
  IntentId,
  IntentType,
  PolicyScope,
  ProcurementId,
} from "@procurement/contracts";

export interface SupervisorModelInput {
  requestId: string;
  intents: Array<{
    id: IntentId;
    type: IntentType;
    scope: PolicyScope;
    statement: string;
    domainProfileIds: DomainProfileId[];
    procurementId?: ProcurementId;
  }>;
  domainProfiles: Array<{
    id: DomainProfileId;
    name: string;
    purpose: string;
    associatedCapabilities: CapabilityId[];
    priority: number;
  }>;
  effectiveRules: Array<{
    key: string;
    value: string | number | boolean;
    statement: string;
    scope: PolicyScope;
  }>;
  procurement?: {
    id: ProcurementId;
    title: string;
    status: string;
    stage: string;
  };
  availableCapabilities: Array<{
    capability: CapabilityId;
    role: string;
    responsibility: string;
  }>;
}

export interface SupervisorModelPort {
  createPlan(input: SupervisorModelInput): Promise<unknown>;
}
