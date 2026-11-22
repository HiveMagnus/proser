#!/usr/bin/env node
/*
  Build a Gradio data array for a given api_name (default txt2img) by parsing /config.
  - Loads config JSON from a URL or local file.
  - Finds the dependency block with matching api_name among [txt2img, txt2img_1, txt2img_upscale] unless overridden.
  - Maps dependency.inputs (component ids) to component default values.
  - Applies overrides for common fields by matching component labels: prompt, negative prompt, width, height, steps, cfg scale, sampler.

  Usage:
    node scripts-root/forge/config-to-data.mjs --base http://127.0.0.1:7861 --api txt2img \
      --prompt "a scenic landscape" --neg "lowres, blurry" --width 512 --height 512 \
      --steps 20 --cfg 7 --sampler "Euler"

  Output: writes JSON array to stdout
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = (() => {
  const out = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = process.argv[i + 1];
      if (!next || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
})();

const base = args.base || process.env.FORGE_BASE || 'http://127.0.0.1:7861';
const apiName = args.api || process.env.API_NAME || 'txt2img';
const candidates = [apiName, `${apiName}_1`, `${apiName}_upscale`];
const configPath = args.config || process.env.CONFIG_PATH || '';
const timeoutMs = Number(args.timeout || 10000);

async function fetchJson(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function loadConfig() {
  if (configPath) {
    const p = path.resolve(configPath);
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
  return await fetchJson(`${base.replace(/\/$/, '')}/config`);
}

function indexComponentsById(components) {
  const map = new Map();
  for (const c of components) {
    map.set(c.id, c);
  }
  return map;
}

function findDependencyForApi(config, apiNames) {
  const deps = config?.dependencies || config?.deps || [];
  for (const name of apiNames) {
    const dep = deps.find(d => d?.api_name === name);
    if (dep) return { dep, name };
  }
  return { dep: null, name: null };
}

function toDefaultValue(component) {
  // Prefer props.value, then value, then null
  const props = component?.props || {};
  let v = undefined;
  if (Object.prototype.hasOwnProperty.call(props, 'value')) v = props.value;
  if (v === undefined && Object.prototype.hasOwnProperty.call(component, 'value')) v = component.value;
  if (v === undefined) v = null;

  // Some components have complex values; normalize common ones
  // Dropdowns often carry { label, value } — use value or label string
  if (v && typeof v === 'object' && ('value' in v || 'label' in v)) {
    v = v.value ?? v.label ?? null;
  }
  return v;
}

function maybeApplyOverride(label, current, overrides) {
  if (!label || typeof label !== 'string') return current;
  const L = label.toLowerCase();
  if (L.includes('prompt') && !L.includes('negative')) {
    return overrides.prompt ?? current;
  }
  if (L.includes('negative') && L.includes('prompt')) {
    return overrides.neg ?? overrides.negative ?? current;
  }
  if (L === 'width' || L.includes('image width')) {
    return overrides.width ?? current;
  }
  if (L === 'height' || L.includes('image height')) {
    return overrides.height ?? current;
  }
  if (L === 'steps' || L.includes('sampling steps')) {
    return overrides.steps ?? current;
  }
  if (L.includes('cfg') || L.includes('guidance')) {
    return overrides.cfg ?? overrides.cfg_scale ?? current;
  }
  if (L.includes('sampler')) {
    return overrides.sampler ?? current;
  }
  return current;
}

function applyOverridesByHeuristics(inputs, compIndex, overrides) {
  return inputs.map((id) => {
    const comp = compIndex.get(id) || {};
    const label = comp?.props?.label || comp?.props?.name || comp?.label || '';
    const cur = toDefaultValue(comp);
    return maybeApplyOverride(label, cur, overrides);
  });
}

function coerceOverridesFromArgs(argsIn) {
  const toNum = (v) => v === undefined ? undefined : Number(v);
  return {
    prompt: argsIn.prompt ?? process.env.PROMPT,
    neg: argsIn.neg ?? argsIn.negative ?? process.env.NEGATIVE,
    width: argsIn.width ? toNum(argsIn.width) : (process.env.WIDTH ? toNum(process.env.WIDTH) : undefined),
    height: argsIn.height ? toNum(argsIn.height) : (process.env.HEIGHT ? toNum(process.env.HEIGHT) : undefined),
    steps: argsIn.steps ? toNum(argsIn.steps) : (process.env.STEPS ? toNum(process.env.STEPS) : undefined),
    cfg: argsIn.cfg ? toNum(argsIn.cfg) : (process.env.CFG ? toNum(process.env.CFG) : undefined),
    sampler: argsIn.sampler ?? process.env.SAMPLER,
  };
}

async function main() {
  const config = await loadConfig();
  const compIndex = indexComponentsById(config?.components || []);
  const { dep, name } = findDependencyForApi(config, candidates);
  if (!dep) {
    console.error(`No dependency found for api_name among: ${candidates.join(', ')}`);
    process.exit(2);
  }
  const overrides = coerceOverridesFromArgs(args);
  const inputs = dep.inputs || [];
  const dataArray = applyOverridesByHeuristics(inputs, compIndex, overrides);
  // Emit JSON array to stdout
  process.stdout.write(JSON.stringify({ api_name: name, data: dataArray }));
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
