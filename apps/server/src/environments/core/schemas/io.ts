import { z } from "zod";

import type { AccessPolicy, Entity } from "./world.js";

// Input contract (notes §6), extended with an explicit userId: scope
// resolution is dual-rooted (agent + user), so the requesting user must be
// named up front rather than assumed.
export const TaskInputSchema = z.object({
  requestId: z.string().min(1),
  sceneId: z.string().min(1).optional(),
  addressedEntityId: z.string().min(1),
  userId: z.string().min(1),
  inputMode: z.string().min(1).default("simulated_spatial_address"),
  utterance: z.string().min(1),
  createdAt: z.string().min(1),
});
export type TaskInput = z.infer<typeof TaskInputSchema>;

// A container reached from the agent root via `responsible_for`, together
// with whatever it `contains`. Generic across environments (a kitchen fridge
// contains ingredients; a workshop toolbox would contain tools).
export interface ScopedContainer {
  container: Entity;
  contents: Entity[];
}

// Output of scope-builder's dual-root resolution. `userProfile` is present
// only when the agent has read access to it -- see scope-builder.ts.
export interface ScopedContext {
  agentId: string;
  userId: string;
  environment: Entity | null;
  containers: ScopedContainer[];
  // Everything else `located_in` the environment that isn't already listed
  // as a container -- e.g. furniture/appliances the agent isn't
  // specifically `responsible_for` but which still exist in the graph
  // (scene-imported) and should be answerable without falling back to
  // reading raw files. See SpatialTeammates.md's "Objects and the scene
  // graph" section: the scene graph is the sole source of object knowledge,
  // so anything in it should be surfaced through the graph, not rediscovered.
  environmentObjects: Entity[];
  skills: Entity[];
  tools: Entity[];
  accessPolicies: AccessPolicy[];
  userProfile: Entity | null;
}

// Generic envelope a workflow's output is wrapped in. TStatus is the
// workflow's own status union (e.g. kitchen's dinner-preparation states);
// TPayload is whatever stage artifacts that workflow produces.
export interface WorkflowOutputEnvelope<TStatus extends string, TPayload> {
  taskId: string;
  status: TStatus;
  createdAt: string;
  updatedAt: string;
  warnings: string[];
  payload: TPayload;
}
