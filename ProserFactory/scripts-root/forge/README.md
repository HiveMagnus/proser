# Forge helper

`config-to-data.mjs` converts a Stable Diffusion WebUI Forge Gradio `/config` document into the positional data array for a named API operation. It is a low-level diagnostic helper; normal application image generation uses `/api/images/*` and `WEBUI_FORGE_URL`.

The active default is `http://127.0.0.1:7861`. Override it with `--base` or `FORGE_BASE`.

```bash
node scripts-root/forge/config-to-data.mjs \
  --base http://127.0.0.1:7861 \
  --api txt2img \
  --prompt "a scenic landscape" \
  --neg "lowres, blurry" \
  --width 1024 \
  --height 1024 \
  --steps 5 \
  --sampler Euler
```

Use `--config <file>` to inspect a saved config without network access. The script writes the resulting JSON array to stdout; it does not submit a generation request or write image files.
