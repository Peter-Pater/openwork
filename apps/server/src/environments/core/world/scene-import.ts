import type { Entity, Relation } from "../schemas/world.js";

// Raw shape produced by the xrblocks scene editor's export (see
// playground/spatial-agent/simulated-kitchen/Scenes/kitchen-scene.json).
// Position/quaternion/scale are trusted as-is and carried straight into each
// entity's `spatial` field -- see SpatialTeammates.md's "Objects and the
// scene graph" section. This mirrors xrblocks' current Simulator Environment
// Manifest object shape (assetPath/id), not the older SceneManager format
// (fileName/customName/locked) this scene file used before the xrblocks
// scene-editor addon was rewritten upstream.
export interface SceneObject {
  assetPath: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  id?: string | null;
}

export interface SceneFile {
  objects: SceneObject[];
}

interface ModelRegistryEntry {
  type: string;
  label: string;
}

// Small, hardcoded model -> semantics mapping for the known models in this
// scene. Not a general model catalog -- a real registry mechanism is future
// work if more environments need one. Unknown models fall back to a generic
// type rather than failing the whole import.
const MODEL_REGISTRY: Record<string, ModelRegistryEntry> = {
  table_model: { type: "furniture.table", label: "Table" },
  chair_model: { type: "furniture.chair", label: "Chair" },
  fridge_model: { type: "appliance.refrigerator", label: "Kitchen Fridge" },
  dishwasher_model: { type: "appliance.dishwasher", label: "Dishwasher" },
  oven_model: { type: "appliance.oven", label: "Oven" },
};

function modelKey(fileName: string): string {
  return fileName.replace(/\.glb$/i, "");
}

function slugFromFileName(fileName: string): string {
  return fileName.replace(/\.glb$/i, "").replace(/_model$/i, "").toLowerCase();
}

function disambiguate(baseId: string, usedIds: Set<string>): string {
  if (!usedIds.has(baseId)) return baseId;
  let suffix = 2;
  while (usedIds.has(`${baseId}_${suffix}`)) suffix++;
  return `${baseId}_${suffix}`;
}

export interface ImportSceneOptions {
  roomEntityId: string;
  sceneId: string;
}

// Converts a scene file's spawned objects into physical_object Entities +
// one `located_in` relation per object to the given room. Generic across any
// environment's scene file -- kitchen is just the first consumer.
export function importScene(scene: SceneFile, opts: ImportSceneOptions): { entities: Entity[]; relations: Relation[] } {
  const entities: Entity[] = [];
  const relations: Relation[] = [];
  const usedIds = new Set<string>();

  for (const object of scene.objects) {
    // assetPath is a full (possibly relative) URL to the .glb -- the
    // registry/slug logic below has always operated on the bare filename, so
    // recover that from the last path segment.
    const fileName = object.assetPath.split("/").pop() ?? object.assetPath;
    const baseId = object.id?.trim() || slugFromFileName(fileName);
    const id = disambiguate(baseId, usedIds);
    usedIds.add(id);

    const registryEntry = MODEL_REGISTRY[modelKey(fileName)];
    const type = registryEntry?.type ?? "physical_object.unknown";
    const label = registryEntry?.label ?? object.id ?? id;

    entities.push({
      id,
      kind: "physical_object",
      type,
      label,
      aliases: [],
      properties: {},
      spatial: {
        sceneId: opts.sceneId,
        roomId: opts.roomEntityId,
        anchorId: id,
        position: object.position,
        quaternion: object.quaternion,
        scale: object.scale,
      },
      schemaVersion: "0.1",
    });

    relations.push({
      id: `relation_scene_${id}_located_in_${opts.roomEntityId}`,
      subjectId: id,
      predicate: "located_in",
      objectId: opts.roomEntityId,
      confidence: 1,
      provenance: { source: "scene_import" },
    });
  }

  return { entities, relations };
}
