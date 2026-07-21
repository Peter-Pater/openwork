import { describe, expect, test } from "bun:test";

import type { Recipe } from "../schemas/kitchen.js";
import type { InventoryItem } from "./inventory-service.js";
import { computeGroceryList } from "./grocery-list-service.js";

function inventoryItem(overrides: Partial<InventoryItem>): InventoryItem {
  return {
    entityId: "ingredient_test_01",
    name: "Test Item",
    quantity: 0,
    unit: "g",
    condition: "good",
    confidence: 1,
    lowConfidence: false,
    ...overrides,
  };
}

function recipe(overrides: Partial<Recipe>): Recipe {
  return {
    title: "Test Recipe",
    servings: 2,
    rationale: "test",
    requiredIngredients: [],
    instructions: [{ step: 1, text: "Cook." }],
    estimatedMinutes: 10,
    ...overrides,
  };
}

describe("grocery-list-service: computeGroceryList", () => {
  test("reports a fully missing ingredient (not in the fridge at all)", () => {
    const list = computeGroceryList(
      recipe({ requiredIngredients: [{ name: "garlic", quantity: 4, unit: "count", required: true }] }),
      [],
    );
    expect(list.items).toEqual([
      {
        ingredientName: "garlic",
        requiredQuantity: 4,
        availableQuantity: 0,
        missingQuantity: 4,
        unit: "count",
        reason: "Recipe requires 4 count; not found in fridge.",
      },
    ]);
  });

  test("reports an insufficient quantity as the difference, never negative", () => {
    const list = computeGroceryList(
      recipe({ requiredIngredients: [{ name: "beef", quantity: 300, unit: "g", required: true }] }),
      [inventoryItem({ name: "Beef", quantity: 200, unit: "g" })],
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0].missingQuantity).toBe(100);
    expect(list.items[0].availableQuantity).toBe(200);
  });

  test("omits an ingredient the fridge already fully covers", () => {
    const list = computeGroceryList(
      recipe({ requiredIngredients: [{ name: "beef", quantity: 100, unit: "g", required: true }] }),
      [inventoryItem({ name: "Beef", quantity: 200, unit: "g" })],
    );
    expect(list.items).toEqual([]);
  });

  test("never reports a negative missing quantity when the fridge has more than enough", () => {
    const list = computeGroceryList(
      recipe({ requiredIngredients: [{ name: "beef", quantity: 50, unit: "g", required: true }] }),
      [inventoryItem({ name: "Beef", quantity: 5000, unit: "g" })],
    );
    expect(list.items).toEqual([]);
  });

  test("puts a non-required ingredient in optionalItems, not items", () => {
    const list = computeGroceryList(
      recipe({ requiredIngredients: [{ name: "parsley", quantity: 1, unit: "count", required: false }] }),
      [],
    );
    expect(list.items).toEqual([]);
    expect(list.optionalItems).toEqual(["parsley"]);
  });

  test("flags a unit mismatch as unresolved instead of guessing a conversion", () => {
    const list = computeGroceryList(
      recipe({ requiredIngredients: [{ name: "beef", quantity: 1, unit: "lb", required: true }] }),
      [inventoryItem({ name: "Beef", quantity: 200, unit: "g" })],
    );
    expect(list.items).toEqual([]);
    expect(list.unresolvedItems).toHaveLength(1);
    expect(list.unresolvedItems[0]).toContain("unit mismatch");
  });

  test("an empty fridge reports every required ingredient as fully missing", () => {
    const list = computeGroceryList(
      recipe({
        requiredIngredients: [
          { name: "beef", quantity: 300, unit: "g", required: true },
          { name: "broccoli", quantity: 150, unit: "g", required: true },
        ],
      }),
      [],
    );
    expect(list.items).toHaveLength(2);
    expect(list.items.every((item) => item.availableQuantity === 0)).toBe(true);
    expect(list.items.map((item) => item.missingQuantity)).toEqual([300, 150]);
  });
});
