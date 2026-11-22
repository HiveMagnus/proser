# inference-host inference profile

This directory versions the llama.cpp service and Qwen chat template used by Proser. Vision remains enabled through `mmproj`; the service keeps eight continuously batched slots with approximately 150K tokens per slot. The non-loopback API is authenticated by llama.cpp using `/etc/proser-inference-api-keys`; the file is root-owned, group-readable by the service account, and never placed in the unit or process arguments.

Deploy from `ProserFactory` with:

```bash
scripts/deploy-inference.sh
```

The script reads `INFERENCE_HOST`, `INFERENCE_USER`, `INFERENCE_SSH_KEY`, `INFERENCE_API_KEY`, and a pinned OpenSSH known-hosts line from `INFERENCE_SSH_HOST_KEY`. The API key must be at least 32 characters and is staged through a private temporary file. The scoped deployment key must have passwordless sudo access only to the reviewed semantic deployment helper. The script backs up the existing unit and key file, installs the versioned template, restarts `llama-qwen3.6.service`, waits for authenticated `/health`, rejects an unauthenticated `/v1/chat/completions` request, and verifies the template checksum. Any failure after activation invokes rollback through an `EXIT` trap; successful finalization alone clears that rollback obligation. On a failed first deployment it disables and removes the new unit; otherwise it restores the verified backup. The existing host-specific GPU preflight drop-in remains authoritative. For an existing host with a separately reviewed account or unit, set `INFERENCE_UNIT_FILE` to its private reviewed unit file. The installed privilege helper must already pin the exact same bytes.

Root access is mediated by the root-owned
`/usr/local/sbin/proser-inference-deploy-sudo` semantic helper. Sudoers grants
the deployment account only that executable; the helper accepts a strict UTC
deployment stamp, atomically captures staged entries into a root-only directory
before validation, rejects symlinks and unsafe modes, pins the reviewed systemd
unit hash, creates private rollback state, and exposes only
`ping`, `activate`, `rollback`, and `finalize`. Installing or updating the helper
is an explicit administrator bootstrap action, separate from ordinary releases.

Before and after changes, run `npm run benchmark:inference -- --iterations=5`. Promote changes only when tool and JSON validity remain complete, no thinking mode produces empty or leaked output, and quality/performance gates in `docs/INFERENCE_OPTIMIZATION.md` pass.
