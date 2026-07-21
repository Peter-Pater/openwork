import type { AccessPolicy, Capability, Entity, Observation, Relation, WorldData } from "../schemas/world.js";

export interface WorldIndex {
  world: WorldData;
  entitiesById: Map<string, Entity>;
  outgoingRelationsBySubject: Map<string, Relation[]>;
  incomingRelationsByObject: Map<string, Relation[]>;
  observationsByObject: Map<string, Observation[]>;
  capabilitiesBySubject: Map<string, Capability[]>;
  policiesBySubject: Map<string, AccessPolicy[]>;
  aliasesToEntityIds: Map<string, string[]>;
}

function pushToMapArray<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

export function buildWorldIndex(world: WorldData): WorldIndex {
  const entitiesById = new Map<string, Entity>();
  const aliasesToEntityIds = new Map<string, string[]>();
  for (const entity of world.entities) {
    entitiesById.set(entity.id, entity);
    for (const alias of entity.aliases) {
      pushToMapArray(aliasesToEntityIds, alias, entity.id);
    }
  }

  const outgoingRelationsBySubject = new Map<string, Relation[]>();
  const incomingRelationsByObject = new Map<string, Relation[]>();
  for (const relation of world.relations) {
    pushToMapArray(outgoingRelationsBySubject, relation.subjectId, relation);
    pushToMapArray(incomingRelationsByObject, relation.objectId, relation);
  }

  const observationsByObject = new Map<string, Observation[]>();
  for (const observation of world.observations) {
    pushToMapArray(observationsByObject, observation.objectId, observation);
  }

  const capabilitiesBySubject = new Map<string, Capability[]>();
  for (const capability of world.capabilities) {
    pushToMapArray(capabilitiesBySubject, capability.subjectId, capability);
  }

  const policiesBySubject = new Map<string, AccessPolicy[]>();
  for (const policy of world.accessPolicies) {
    pushToMapArray(policiesBySubject, policy.subjectId, policy);
  }

  return {
    world,
    entitiesById,
    outgoingRelationsBySubject,
    incomingRelationsByObject,
    observationsByObject,
    capabilitiesBySubject,
    policiesBySubject,
    aliasesToEntityIds,
  };
}
