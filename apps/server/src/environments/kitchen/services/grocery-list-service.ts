import type { GroceryList, GroceryListItem, Recipe } from "../schemas/kitchen.js";
import type { InventoryItem } from "./inventory-service.js";

function findInventoryMatch(inventory: InventoryItem[], ingredientName: string): InventoryItem | undefined {
  const normalized = ingredientName.trim().toLowerCase();
  return inventory.find((item) => item.name.trim().toLowerCase() === normalized);
}

// Deterministic diff between what a recipe requires and what's actually in
// the fridge. The LLM is never trusted to perform this subtraction (notes
// §5/§14) -- quantities/units come straight from inventory-service's
// normalized records.
export function computeGroceryList(recipe: Recipe, inventory: InventoryItem[]): GroceryList {
  const items: GroceryListItem[] = [];
  const unresolvedItems: string[] = [];
  const optionalItems: string[] = [];

  for (const ingredient of recipe.requiredIngredients) {
    if (!ingredient.required) {
      optionalItems.push(ingredient.name);
      continue;
    }

    const match = findInventoryMatch(inventory, ingredient.name);
    const availableQuantity = typeof match?.quantity === "number" ? match.quantity : 0;
    const availableUnit = match?.unit ?? null;

    if (match && availableUnit && availableUnit !== ingredient.unit) {
      // Different units for the same ingredient -- surface it rather than
      // guess a conversion (notes §5: "surface unresolved unit conversions
      // instead of guessing").
      unresolvedItems.push(
        `${ingredient.name}: recipe requires ${ingredient.quantity} ${ingredient.unit}, fridge has ${availableQuantity} ${availableUnit} (unit mismatch)`,
      );
      continue;
    }

    const missingQuantity = Math.max(0, ingredient.quantity - availableQuantity);
    if (missingQuantity === 0) continue; // fully covered by inventory, nothing to buy

    items.push({
      ingredientName: ingredient.name,
      requiredQuantity: ingredient.quantity,
      availableQuantity,
      missingQuantity,
      unit: ingredient.unit,
      reason: match
        ? `Recipe requires ${ingredient.quantity} ${ingredient.unit}; fridge has ${availableQuantity} ${ingredient.unit}.`
        : `Recipe requires ${ingredient.quantity} ${ingredient.unit}; not found in fridge.`,
    });
  }

  return { items, optionalItems, unresolvedItems };
}
