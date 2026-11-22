# Maintained development dependency: deepmerge

Based on MIT `deepmerge@4.3.1`, https://registry.npmjs.org/deepmerge/-/deepmerge-4.3.1.tgz.
Registry integrity: `sha512-3sUqbMEc77XqpdNO7FRyRog+eW3ph+GYCbj+rK+uYyRMuwsVy0rMiVtPn+QJlKFvWP/1PYpapqYn0Me2knFn+A==`.
Original bundled CommonJS source is retained as `upstream.cjs` (SHA-256
`2e5160f84a1141bd927264afe4d15766f1e6cf07daef182b37ff53fea121de7d`), with original license and declarations.

GHSA-gcqx-w48m-w2h4 has no upstream patched version as of October 31, 2026.
Both target and source writes now define own data properties, preserving normal
merge/clone/custom-array/symbol semantics without invoking inherited setters.
The package has a distinct maintained name/version; it does not claim an upstream
fix. Factory overrides Jest's development-only `deepmerge` dependency to this
local package. No audit ignore or version downgrade is used.

Run `npm test --prefix ProserFactory/vendor/deepmerge`. Tests prove the retained
original's target/null-prototype-source poisoning and the maintained patch, then
check ordinary merge, cloning, symbols, custom hooks and `all` compatibility.
Remove the local override only after an upstream fix passes the same tests.
