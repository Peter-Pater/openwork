import type { Entity, Relation } from "../schemas/world.js";

// Raw shape produced by either of the two room sources:
//   - the xrblocks scene editor's export (see playground/spatial-agent/
//     simulated-kitchen/Scenes/kitchen-scene.json): assetPath-driven, with
//     semantics recovered from the .glb basename via MODEL_REGISTRY below;
//   - the XR client's room-understanding JSON (captured with the objects3d
//     detector; see openwork-xr-client/room-understanding.js): no assets
//     exist, so each object carries its `label` (raw detector label) and
//     `type` (canonical entity type) directly, which win over the registry.
// Position/quaternion/scale are trusted as-is and carried straight into each
// entity's `spatial` field -- see SpatialTeammates.md's "Objects and the
// scene graph" section.
export interface SceneObject {
  assetPath?: string | null;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  id?: string | null;
  label?: string | null;
  type?: string | null;
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
    // recover that from the last path segment. Detector-produced objects
    // have no asset at all; their ids/semantics come from the object itself.
    const fileName = object.assetPath
      ? (object.assetPath.split("/").pop() ?? object.assetPath)
      : null;
    const baseId = object.id?.trim() || (fileName ? slugFromFileName(fileName) : "object");
    const id = disambiguate(baseId, usedIds);
    usedIds.add(id);

    // Explicit type/label (room-understanding source) win; the .glb-basename
    // registry stays the fallback for scene-editor exports.
    const registryEntry = fileName ? MODEL_REGISTRY[modelKey(fileName)] : undefined;
    const type = object.type?.trim() || registryEntry?.type || "physical_object.unknown";
    const label = object.label?.trim() || registryEntry?.label || object.id || id;

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
