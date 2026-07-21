import type { ScopedContainer } from "../../core/schemas/io.js";
import type { Entity, Observation } from "../../core/schemas/world.js";
import type { WorldIndex } from "../../core/world/world-index.js";

// Below this confidence, an item's quantity is flagged rather than treated
// as certain (notes §17 test case 7: "uncertain inventory").
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

export interface InventoryItem {
  entityId: string;
  name: string;
  quantity: number | string | boolean | null;
  unit: string | null;
  condition: string | null;
  confidence: number | null;
  lowConfidence: boolean;
}

function findByKey(observations: Observation[], key: string): Observation | undefined {
  return observations.find((observation) => observation.key === key);
}

function normalizeIngredient(index: WorldIndex, entity: Entity): InventoryItem {
  const observations = index.observationsByObject.get(entity.id) ?? [];
  const quantityObservation = findByKey(observations, "quantity");
  const conditionObservation = findByKey(observations, "condition");
  const confidence = quantityObservation?.confidence ?? null;

  return {
    entityId: entity.id,
    name: entity.label,
    quantity: quantityObservation?.value ?? null,
    unit: quantityObservation?.unit ?? null,
    condition: conditionObservation ? String(conditionObservation.value) : null,
    confidence,
    lowConfidence: confidence !== null && confidence < LOW_CONFIDENCE_THRESHOLD,
  };
}

// Pure, deterministic normalization of a container's contents into inventory
// records -- no inference, no unit conversion (that's grocery-list-service's
// job), no LLM involved.
export function buildInventorySummary(index: WorldIndex, container: ScopedContainer): InventoryItem[] {
  return container.contents.map((entity) => normalizeIngredient(index, entity));
}
