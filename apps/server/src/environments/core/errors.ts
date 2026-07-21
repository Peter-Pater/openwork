// Generic structured error type (notes §13), shared by every environment
// pack. Only the environment-agnostic codes live here -- a pack (e.g.
// kitchen) defines its own additional code strings for domain-specific
// failures (RECIPE_OUTPUT_INVALID, CART_PROVIDER_UNAVAILABLE, ...) and
// throws the same EnvironmentError class with those codes.
export interface EnvironmentErrorOptions {
  recoverable?: boolean;
  stage?: string;
  details?: Record<string, unknown>;
}

export class EnvironmentError extends Error {
  code: string;
  recoverable: boolean;
  stage?: string;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, options: EnvironmentErrorOptions = {}) {
    super(message);
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.stage = options.stage;
    this.details = options.details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        recoverable: this.recoverable,
        stage: this.stage,
        details: this.details,
      },
    };
  }
}

// Environment-agnostic error codes (world loading + scope resolution).
export const CORE_ERROR_CODES = {
  INVALID_WORLD_DATA: "INVALID_WORLD_DATA",
  ADDRESSED_AGENT_NOT_FOUND: "ADDRESSED_AGENT_NOT_FOUND",
  REQUIRED_CAPABILITY_MISSING: "REQUIRED_CAPABILITY_MISSING",
  ACCESS_DENIED: "ACCESS_DENIED",
} as const;
