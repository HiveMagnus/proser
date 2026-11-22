/**
 * CLI config override — maps CLI flags to process.env BEFORE CONFIG loads.
 * Must be called in yargs middleware before any command handler runs.
 * @module cli/config
 */

export interface CliOverrides {
  model?: string;
  temperature?: number;
  inferenceHost?: string;
}

/**
 * Apply CLI flag overrides to process.env so that CONFIG picks them up
 * during its lazy Zod parse.
 */
export function applyCliOverrides(flags: CliOverrides): void {
  if (flags.model) {
    process.env.OLLAMA_MODEL = flags.model;
    process.env.VLLM_MODEL = flags.model;
  }
  if (flags.temperature !== undefined) {
    process.env.AI_TEMP_PROSE = String(flags.temperature);
  }
  if (flags.inferenceHost) {
    process.env.OLLAMA_BASE_URL = flags.inferenceHost;
    process.env.OLLAMA_HOST = flags.inferenceHost;
    process.env.INFERENCE_HOST = flags.inferenceHost;
    process.env.VLLM_BASE_URL = flags.inferenceHost;
  }
}
