import { describe, expect, test } from "bun:test";

import { importScene, type SceneFile } from "./scene-import.js";

function sceneObject(overrides: Partial<SceneFile["objects"][number]>): SceneFile["objects"][number] {
  return {
    assetPath: "../Models/table_model.glb",
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    id: null,
    ...overrides,
  };
}

const OPTS = { roomEntityId: "kitchen_01", sceneId: "kitchen_scene_01" };

describe("scene-import: importScene", () => {
  test("derives entity ids from id when present", () => {
    const scene: SceneFile = {
      objects: [sceneObject({ assetPath: "../Models/fridge_model.glb", id: "fridge" })],
    };
    const { entities } = importScene(scene, OPTS);
    expect(entities).toHaveLength(1);
    expect(entities[0].id).toBe("fridge");
    expect(entities[0].kind).toBe("physical_object");
    expect(entities[0].type).toBe("appliance.refrigerator");
    expect(entities[0].label).toBe("Kitchen Fridge");
  });

  test("carries the scene's real transform into spatial.position/quaternion/scale", () => {
    const scene: SceneFile = {
      objects: [
        sceneObject({
          assetPath: "../Models/fridge_model.glb",
          id: "fridge",
          position: [-1.35, 0.31, 2.99],
          quaternion: [0, 1, 0, 6.12e-17],
          scale: [1.49, 1.49, 1.65],
        }),
      ],
    };
    const { entities } = importScene(scene, OPTS);
    expect(entities[0].spatial?.position).toEqual([-1.35, 0.31, 2.99]);
    expect(entities[0].spatial?.quaternion).toEqual([0, 1, 0, 6.12e-17]);
    expect(entities[0].spatial?.scale).toEqual([1.49, 1.49, 1.65]);
  });

  test("falls back to an assetPath-derived slug when id is null", () => {
    const scene: SceneFile = {
      objects: [sceneObject({ assetPath: "../Models/oven_model.glb", id: null })],
    };
    const { entities } = importScene(scene, OPTS);
    expect(entities[0].id).toBe("oven");
    expect(entities[0].type).toBe("appliance.oven");
    expect(entities[0].label).toBe("Oven");
  });

  test("disambiguates colliding fallback ids with a numeric suffix", () => {
    const scene: SceneFile = {
      objects: [
        sceneObject({ assetPath: "../Models/oven_model.glb", id: null }),
        sceneObject({ assetPath: "../Models/oven_model.glb", id: null }),
      ],
    };
    const { entities } = importScene(scene, OPTS);
    expect(entities.map((entity) => entity.id).sort()).toEqual(["oven", "oven_2"]);
  });

  test("unknown model assetPaths get a generic fallback type instead of failing", () => {
    const scene: SceneFile = {
      objects: [sceneObject({ assetPath: "../Models/toaster_model.glb", id: "toaster" })],
    };
    const { entities } = importScene(scene, OPTS);
    expect(entities[0].type).toBe("physical_object.unknown");
    expect(entities[0].label).toBe("toaster");
  });

  test("emits one located_in relation per object, pointing at the room", () => {
    const scene: SceneFile = {
      objects: [
        sceneObject({ assetPath: "../Models/table_model.glb", id: "table_left" }),
        sceneObject({ assetPath: "../Models/chair_model.glb", id: "chair_right" }),
        sceneObject({ assetPath: "../Models/fridge_model.glb", id: "fridge" }),
        sceneObject({ assetPath: "../Models/dishwasher_model.glb", id: null }),
        sceneObject({ assetPath: "../Models/oven_model.glb", id: null }),
      ],
    };
    const { entities, relations } = importScene(scene, OPTS);
    expect(entities).toHaveLength(5);
    expect(relations).toHaveLength(5);
    for (const relation of relations) {
      expect(relation.predicate).toBe("located_in");
      expect(relation.objectId).toBe("kitchen_01");
    }
    expect(relations.map((relation) => relation.subjectId).sort()).toEqual(
      ["chair_right", "dishwasher", "fridge", "oven", "table_left"].sort(),
    );
  });
});
