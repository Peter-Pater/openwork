import { CORE_ERROR_CODES, EnvironmentError } from "../errors.js";
import type { ScopedContainer, ScopedContext } from "../schemas/io.js";
import type { Entity } from "../schemas/world.js";
import { hasAccess, incomingNeighborsByPredicate, neighborsByPredicate } from "./graph-query.js";
import type { WorldIndex } from "./world-index.js";

export interface ResolveScopedContextInput {
  agentId: string;
  userId: string;
}

// Dual-root scope resolution (notes §8, extended): the environmental
// context is rooted at the addressed AGENT, and user-specific preferences
// are rooted separately at the requesting USER -- the agent does not
// implicitly inherit reachability to the user's profile just because both
// happen to be in the same graph. Whether the agent may read the profile is
// an explicit access-policy check; if it fails (or the user has no
// profile), `userProfile` is simply absent rather than assumed.
export function resolveScopedContext(index: WorldIndex, input: ResolveScopedContextInput): ScopedContext {
  const { agentId, userId } = input;

  const agent = index.entitiesById.get(agentId);
  if (!agent) {
    throw new EnvironmentError(
      CORE_ERROR_CODES.ADDRESSED_AGENT_NOT_FOUND,
      `Addressed entity ${agentId} was not found`,
    );
  }
  if (agent.kind !== "agent") {
    throw new EnvironmentError(
      CORE_ERROR_CODES.ADDRESSED_AGENT_NOT_FOUND,
      `Addressed entity ${agentId} is not an agent (kind: ${agent.kind})`,
    );
  }

  // --- Agent-rooted environmental context ---
  const environment = neighborsByPredicate(index, agentId, "assigned_to")[0] ?? null;

  const containers: ScopedContainer[] = neighborsByPredicate(index, agentId, "responsible_for").map(
    (container) => ({
      container,
      contents: neighborsByPredicate(index, container.id, "contains"),
    }),
  );

  // Everything else located in the environment, not just what the agent is
  // specifically responsible for -- e.g. furniture/appliances that exist in
  // the graph (scene-imported) but no one is "responsible for" yet.
  const containerIds = new Set(containers.map((c) => c.container.id));
  const environmentObjects = environment
    ? incomingNeighborsByPredicate(index, environment.id, "located_in").filter((entity) => !containerIds.has(entity.id))
    : [];

  const skills = neighborsByPredicate(index, agentId, "has_skill");
  const tools = neighborsByPredicate(index, agentId, "has_tool");
  const accessPolicies = index.policiesBySubject.get(agentId) ?? [];

  // --- User-rooted preferences, gated by an explicit access check ---
  let userProfile: Entity | null = null;
  const profile = neighborsByPredicate(index, userId, "has_profile")[0];
  if (profile && hasAccess(index, agentId, "read", profile.id)) {
    userProfile = profile;
  }

  return {
    agentId,
    userId,
    environment,
    containers,
    environmentObjects,
    skills,
    tools,
    accessPolicies,
    userProfile,
  };
}
