import { z } from "zod";

// Generic, environment-agnostic world model. No kitchen (or any other
// environment's) vocabulary belongs here -- see notes §5.

export const ENTITY_KINDS = [
  "agent",
  "physical_object",
  "spatial_region",
  "user",
  "profile",
  "skill",
  "tool",
  "digital_artifact",
  "task",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const SUPPORTED_SCHEMA_VERSIONS = ["0.1"] as const;

export const EntitySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(ENTITY_KINDS),
  type: z.string().min(1),
  label: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  description: z.string().optional(),
  spatial: z
    .object({
      sceneId: z.string().optional(),
      roomId: z.string().optional(),
      anchorId: z.string().optional(),
      // Real transform data, trusted as-is from the scene file (see
      // scene-import.ts) -- only present for scene-imported physical
      // objects. Hand-authored entities (agents, food-as-IoT-simulated-data,
      // skills, tools, digital_artifact) correctly have none of this, since
      // they aren't rendered scene objects.
      position: z.tuple([z.number(), z.number(), z.number()]).optional(),
      quaternion: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
      scale: z.tuple([z.number(), z.number(), z.number()]).optional(),
    })
    .optional(),
  properties: z.record(z.string(), z.unknown()).default({}),
  retrieval: z
    .object({
      keywords: z.array(z.string()).default([]),
    })
    .optional(),
  schemaVersion: z.string().min(1),
});
export type Entity = z.infer<typeof EntitySchema>;

export const RELATION_PREDICATES = [
  "located_in",
  "contains",
  "assigned_to",
  "responsible_for",
  "has_profile",
  "has_skill",
  "has_tool",
  "has_access_to",
  "produced_by",
  "derived_from",
  "relevant_to",
  "attached_to",
] as const;
export type RelationPredicate = (typeof RELATION_PREDICATES)[number];

export const RelationSchema = z.object({
  id: z.string().min(1),
  subjectId: z.string().min(1),
  predicate: z.enum(RELATION_PREDICATES),
  objectId: z.string().min(1),
  confidence: z.number().min(0).max(1).default(1),
  provenance: z.object({ source: z.string().min(1) }).optional(),
});
export type Relation = z.infer<typeof RelationSchema>;

export const ObservationSchema = z.object({
  id: z.string().min(1),
  objectId: z.string().min(1),
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
  unit: z.string().optional(),
  observedAt: z.string().min(1),
  confidence: z.number().min(0).max(1).default(1),
  source: z
    .object({
      type: z.string().min(1),
      sourceId: z.string().min(1),
    })
    .optional(),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const CapabilitySchema = z.object({
  id: z.string().min(1),
  subjectId: z.string().min(1),
  operation: z.string().min(1),
  executor: z.object({
    type: z.enum(["skill", "tool"]),
    ref: z.string().min(1),
  }),
  permissions: z.object({
    readScope: z.array(z.string()).default([]),
    writeScope: z.array(z.string()).default([]),
    actScope: z.array(z.string()).default([]),
    approval: z.enum(["none", "confirm_before_execution"]).default("none"),
  }),
});
export type Capability = z.infer<typeof CapabilitySchema>;

export const POLICY_EFFECTS = ["allow", "deny", "allow_with_confirmation"] as const;
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

export const AccessPolicyRuleSchema = z.object({
  operation: z.string().min(1),
  resources: z.array(z.string()),
  effect: z.enum(POLICY_EFFECTS),
});
export type AccessPolicyRule = z.infer<typeof AccessPolicyRuleSchema>;

export const AccessPolicySchema = z.object({
  id: z.string().min(1),
  subjectId: z.string().min(1),
  rules: z.array(AccessPolicyRuleSchema),
});
export type AccessPolicy = z.infer<typeof AccessPolicySchema>;

// Raw shape of a pack's data/ directory, before cross-file referential
// integrity is checked by world-loader.ts (zod alone can't express "objectId
// must reference an existing entity" across independently-parsed arrays).
export const WorldDataSchema = z.object({
  entities: z.array(EntitySchema),
  relations: z.array(RelationSchema),
  observations: z.array(ObservationSchema),
  capabilities: z.array(CapabilitySchema),
  accessPolicies: z.array(AccessPolicySchema),
});
export type WorldData = z.infer<typeof WorldDataSchema>;
