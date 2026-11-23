import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

/**
 * The persisted inference settings file is written through the admin API and
 * loaded over the process environment at startup. Only these keys may be read
 * from or written to it, so it can never replace secrets, database targets or
 * the runtime mode.
 */
export const INFERENCE_SETTINGS_KEYS = [
  'INFERENCE_BACKEND',
  'OLLAMA_BASE_URL',
  'OLLAMA_HOST',
  'INFERENCE_HOST',
  'VLLM_BASE_URL',
  'OLLAMA_MODEL',
  'VLLM_MODEL',
] as const;

const allowedKeys: ReadonlySet<string> = new Set(INFERENCE_SETTINGS_KEYS);

export function inferenceSettingsFilePath(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.OLLAMA_SETTINGS_FILE || path.resolve(process.cwd(), 'data/ollama-settings.env');
}

export function isSafeInferenceSettingValue(value: string): boolean {
  // One printable line: no control characters, quotes, comments or expansions.
  return value.length <= 2048 && /^[^\u0000-\u001f\u007f"'`#$\\]*$/.test(value);
}

/** Apply only the allow-listed inference keys from the settings file. */
export function loadInferenceSettingsFile(environment: NodeJS.ProcessEnv = process.env): void {
  let parsed: Record<string, string>;
  try {
    parsed = dotenv.parse(fs.readFileSync(inferenceSettingsFilePath(environment)));
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (allowedKeys.has(key) && isSafeInferenceSettingValue(value)) environment[key] = value;
  }
}
