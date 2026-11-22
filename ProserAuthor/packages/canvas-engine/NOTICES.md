# Rebuilt Canvas notices

The maintained Canvas source is MIT licensed. Retain the upstream Hufe license
and copyright in LICENSE. The rebuilt ES module has no external runtime imports.
Its build graph includes a Rolldown runtime helper, and the CSS insertion helper
from vite-plugin-css-injected-by-js is injected into the final bytes. Their MIT
notices are retained in notices/, including Rolldown's supplied third-party
notice file. Do not infer the absence of embedded code from package.json having
no runtime dependencies.

The owned build manifest records all emitted module identities and the SHA-256
of the final bytes after CSS injection. The release ledger/SBOM covers these
embedded helpers, actual tool versions, archive integrity and the full source
file digests. This package contains no bundled font or image files.
