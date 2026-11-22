const assert = require('node:assert/strict');
const codec = require('@hivemagnus/canvas-word-codec');
const manifest = require('@hivemagnus/canvas-word-codec/package.json');

assert.equal(manifest.name, '@hivemagnus/canvas-word-codec');
assert.equal(manifest.version, require('../package.json').dependencies[manifest.name]);
assert.equal(codec.CODEC_VERSION, manifest.version);
for (const entry of ['importDocx', 'exportDocx', 'exportDocxSections', 'validateDocxPackage']) {
  assert.equal(typeof codec[entry], 'function', `Missing shared codec API: ${entry}`);
}
console.log(`Verified installed ${manifest.name}@${manifest.version}`);
