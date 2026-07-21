#!/usr/bin/env bun

// Manual verification helper: bun run describe.ts <entityId>
// Prints a human-readable join of one entity + everything referencing it,
// so the graph can be spot-checked against the intended design without
// reading the normalized JSON arrays directly.
import { join } from "node:path";

import { describeEntity } from "../core/world/describe-entity.js";
import { buildWorldIndex } from "../core/world/world-index.js";
import { loadKitchenWorld } from "./world/load-kitchen-world.js";

const KITCHEN_DATA_DIR = join(import.meta.dir, "data");

async function main() {
  const entityId = process.argv[2];
  if (!entityId) {
    console.error("Usage: bun run describe.ts <entityId>");
    process.exit(1);
  }

  const world = await loadKitchenWorld(KITCHEN_DATA_DIR);
  const index = buildWorldIndex(world);
  const description = describeEntity(index, entityId);

  if (!description) {
    console.error(`No entity found with id "${entityId}"`);
    process.exit(1);
  }

  console.log(JSON.stringify(description, null, 2));
}

main();
