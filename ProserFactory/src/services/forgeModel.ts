import { z } from 'zod';
const checkpoint = z.string().regex(/^qwen_image_2\.1_[a-z0-9_]+\.safetensors$/u);
export async function resolveForgeModel(baseUrl: string, configured: string): Promise<string> {
  if (configured !== 'qwen-image-2.1') return configured;
  const imported = await import('ky'); const ky = imported.default;
  const response = await ky.get(`${baseUrl}/sdapi/v1/options`, {timeout:10_000,retry:0});
  const body = await response.text();
  if (Buffer.byteLength(body) > 131072) throw new Error("Forge checkpoint response exceeds its byte limit");
  const options: unknown = JSON.parse(body);
  return z.object({sd_model_checkpoint:checkpoint}).parse(options).sd_model_checkpoint;
}
