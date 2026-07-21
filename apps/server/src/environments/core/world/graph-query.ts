import type { Capability, Entity, RelationPredicate } from "../schemas/world.js";
import type { WorldIndex } from "./world-index.js";

// Entities reached from `subjectId` via an outgoing relation with the given
// predicate, e.g. neighborsByPredicate(index, "chef_agent_01", "has_skill").
export function neighborsByPredicate(index: WorldIndex, subjectId: string, predicate: RelationPredicate): Entity[] {
  const relations = index.outgoingRelationsBySubject.get(subjectId) ?? [];
  const entities: Entity[] = [];
  for (const relation of relations) {
    if (relation.predicate !== predicate) continue;
    const entity = index.entitiesById.get(relation.objectId);
    if (entity) entities.push(entity);
  }
  return entities;
}

// Entities that reach `objectId` via an incoming relation with the given
// predicate, e.g. incomingNeighborsByPredicate(index, "kitchen_01",
// "located_in") -- everything located in the kitchen, regardless of whether
// any agent is specifically responsible for it.
export function incomingNeighborsByPredicate(index: WorldIndex, objectId: string, predicate: RelationPredicate): Entity[] {
  const relations = index.incomingRelationsByObject.get(objectId) ?? [];
  const entities: Entity[] = [];
  for (const relation of relations) {
    if (relation.predicate !== predicate) continue;
    const entity = index.entitiesById.get(relation.subjectId);
    if (entity) entities.push(entity);
  }
  return entities;
}

// All entities reachable from `rootId` by repeatedly following the given
// predicate (e.g. nested containment). Cycle-safe.
export function descendantsByPredicate(index: WorldIndex, rootId: string, predicate: RelationPredicate): Entity[] {
  const visited = new Set<string>([rootId]);
  const result: Entity[] = [];
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId) continue;
    for (const entity of neighborsByPredicate(index, currentId, predicate)) {
      if (visited.has(entity.id)) continue;
      visited.add(entity.id);
      result.push(entity);
      queue.push(entity.id);
    }
  }
  return result;
}

// True if `subjectId` has an access-policy rule granting `operation` on
// `resourceId`. A rule matches if its `resources` list contains the exact
// resourceId, OR contains "*" -- the wildcard stands in for "reachable
// within my (currently the one, global) subspace" until the real
// reachability-recompute mechanism exists (see SpatialTeammates.md); the
// "descendants:x" convention from the fixtures is not resolved here, since
// no MVP0 access check needs it. "allow" and "allow_with_confirmation" both
// grant read access -- allow_with_confirmation additionally gates the
// *action* itself elsewhere (e.g. the purchase-approval gate), out of scope
// here.
export function hasAccess(index: WorldIndex, subjectId: string, operation: string, resourceId: string): boolean {
  const policies = index.policiesBySubject.get(subjectId) ?? [];
  for (const policy of policies) {
    for (const rule of policy.rules) {
      if (rule.operation !== operation) continue;
      if (!rule.resources.includes("*") && !rule.resources.includes(resourceId)) continue;
      return rule.effect !== "deny";
    }
  }
  return false;
}

// The capability binding on `subjectId` for `operation`, if any (notes §5.4).
// This is a workflow-level precondition helper, not something world-loader
// calls -- a structurally valid world can lack any given capability, and
// it's up to the workflow that needs it to check and fail accordingly.
export function findCapability(index: WorldIndex, subjectId: string, operation: string): Capability | undefined {
  const capabilities = index.capabilitiesBySubject.get(subjectId) ?? [];
  return capabilities.find((capability) => capability.operation === operation);
}

export function hasCapability(index: WorldIndex, subjectId: string, operation: string): boolean {
  return findCapability(index, subjectId, operation) !== undefined;
}

export interface ArtifactListing {
  entity: Entity;
  attachedTo: string | null;
}

// Every digital_artifact entity in the world, with whatever it's
// `attached_to` (if anything). Lets an agent discover artifacts created in
// an earlier turn -- or an earlier session entirely, since these persist --
// without already knowing their id.
export function listArtifacts(index: WorldIndex): ArtifactListing[] {
  return index.world.entities
    .filter((entity) => entity.kind === "digital_artifact")
    .map((entity) => {
      const attachedToRelation = (index.outgoingRelationsBySubject.get(entity.id) ?? []).find(
        (relation) => relation.predicate === "attached_to",
      );
      return { entity, attachedTo: attachedToRelation?.objectId ?? null };
    });
}
