import { z } from "zod";

// Kitchen-domain schemas -- deliberately not in core/, since "recipe" and
// "grocery list" are vocabulary specific to this environment pack, per
// notes §4/§5.

export const RecipeIngredientSchema = z.object({
  name: z.string().min(1),
  quantity: z.number(),
  unit: z.string().min(1),
  required: z.boolean(),
});
export type RecipeIngredient = z.infer<typeof RecipeIngredientSchema>;

export const RecipeInstructionSchema = z.object({
  step: z.number().int().positive(),
  text: z.string().min(1),
});
export type RecipeInstruction = z.infer<typeof RecipeInstructionSchema>;

export const RecipeSchema = z.object({
  title: z.string().min(1),
  servings: z.number().positive(),
  rationale: z.string().min(1),
  requiredIngredients: z.array(RecipeIngredientSchema).min(1),
  instructions: z.array(RecipeInstructionSchema).min(1),
  estimatedMinutes: z.number().positive(),
});
export type Recipe = z.infer<typeof RecipeSchema>;

export const GroceryListItemSchema = z.object({
  ingredientName: z.string().min(1),
  requiredQuantity: z.number(),
  availableQuantity: z.number(),
  missingQuantity: z.number().min(0),
  unit: z.string().min(1),
  reason: z.string().min(1),
});
export type GroceryListItem = z.infer<typeof GroceryListItemSchema>;

export const GroceryListSchema = z.object({
  items: z.array(GroceryListItemSchema),
  optionalItems: z.array(z.string()).default([]),
  unresolvedItems: z.array(z.string()).default([]),
});
export type GroceryList = z.infer<typeof GroceryListSchema>;
