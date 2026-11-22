# Images API

Image generation and private asset-management endpoints backed by Stable Diffusion WebUI Forge.

Endpoints:

- `GET /api/images/health`
- `GET /api/images/list`
- `GET /api/images/:id/content`
- `POST /api/images/suggest-prompt`
- `POST /api/images/generate` compatible with OpenAI-style `images.generate`
- `POST /api/images/generate/flux` for advanced Forge controls (legacy route name; Qwen Image 2.1 default)
- `DELETE /api/images/:id`

Request body:

- model: string (optional checkpoint override)
- prompt: string (required)
- n: number (1-4)
- size: string like "1024x1024"
- quality: "standard" | "hd"
- response_format: "url" | "b64_json"

All routes require bearer authentication. Nova image-health requests additionally require the distinct signed `capabilities.read` grant. Listing is scoped to the authenticated user; a `bookId` filter is accepted only when that user owns the book. Generation with `bookId` performs the same ownership check.

Response shape:
{ success: true, data: { created: <epoch_ms>, data: [ { url }, ... ] } }

Each returned URL is a protected `/api/images/:id/content` URL. Clients must load it through an authenticated request or through ProserAuthor's authenticated `/api` proxy. Another tenant receives `404`, avoiding asset-existence disclosure.

Environment:

- `WEBUI_FORGE_URL` (default `http://127.0.0.1:7861`)
- `FORGE_MODEL` (default `qwen-image-2.1`)
- `FORGE_SAMPLER` (default `Euler`)
- `FORGE_SCHEDULER` (default `Simple`)
- `FORGE_STEPS` (default `5`)

Storage:

- Generated files are stored under `public/images` as a runtime detail, but `/images/*` is not publicly served.
- Only database-recorded assets owned by the requesting user are listable/readable. Untracked filesystem files are ignored.

Quick test:

- `tsx scripts/test-image-generate.ts`
- `curl -fsS http://127.0.0.1:3001/api/images/health`

Use `transparent_background: true` on either generation route to request an RGBA cutout. Output stays PNG. Configured Qwen defaults also apply through the legacy `/generate/flux` route; no automatic fallback repeats an uncertain request.

The model family setting follows Nova’s active checkpoint, including `qwen_image_2.1_int8_convrot.safetensors`. Sampling defaults are unchanged by the precision switch; new generation receipts record the selected filename.
