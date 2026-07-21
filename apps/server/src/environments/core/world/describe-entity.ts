import type { AccessPolicy, Capability, Entity, Observation } from "../schemas/world.js";
import type { WorldIndex } from "./world-index.js";

export interface OutgoingRelationView {
  predicate: string;
  targetId: string;
  targetLabel: string;
}

export interface IncomingRelationView {
  predicate: string;
  sourceId: string;
  sourceLabel: string;
}

export interface EntityDescription {
  entity: Entity;
  outgoingRelations: OutgoingRelationView[];
  incomingRelations: IncomingRelationView[];
  observations: Observation[];
  capabilitiesAsSubject: Capability[];
  accessPoliciesAsSubject: AccessPolicy[];
}

// Joins one entity with everything referencing/referenced-by it into a
// single flat, human-readable object -- the JSON-graph format (normalized
// arrays) is efficient to query but not directly readable, so this exists
// purely for manual verification that the graph reflects the intended
// design (SpatialTeammates.md's "Human-readable inspection" section).
export function describeEntity(index: WorldIndex, entityId: string): EntityDescription | null {
  const entity = index.entitiesById.get(entityId);
  if (!entity) return null;

  const outgoingRelations = (index.outgoingRelationsBySubject.get(entityId) ?? []).map((relation) => ({
    predicate: relation.predicate,
    targetId: relation.objectId,
    targetLabel: index.entitiesById.get(relation.objectId)?.label ?? relation.objectId,
  }));

  const incomingRelations = (index.incomingRelationsByObject.get(entityId) ?? []).map((relation) => ({
    predicate: relation.predicate,
    sourceId: relation.subjectId,
    sourceLabel: index.entitiesById.get(relation.subjectId)?.label ?? relation.subjectId,
  }));

  return {
    entity,
    outgoingRelations,
    incomingRelations,
    observations: index.observationsByObject.get(entityId) ?? [],
    capabilitiesAsSubject: index.capabilitiesBySubject.get(entityId) ?? [],
    accessPoliciesAsSubject: index.policiesBySubject.get(entityId) ?? [],
  };
}
