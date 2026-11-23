# Deploy ProserAuthor

The [root Compose setup](../../docs/COMPOSE.md) is the installation path for
Author, Factory, the worker, PostgreSQL, and Redis. The released image includes
all three Proser processes. The `author` service listens on container port 3000
and uses `http://factory:3001` on the Compose network.

For HTTPS deployments, configure the reverse proxy and set `PROSER_ORIGIN` to
the browser origin. See [access from another machine](../../docs/COMPOSE.md#access-from-another-machine)
and [Author environment settings](ENVIRONMENT.md). Verify `/api/readiness`,
interactive sign-in, desktop and phone routes, and an authenticated disposable
book operation after a change. Check `/api/images/health` through Author if a
Forge provider is configured.

## Existing split or native installations

`ProserAuthor/docker-compose.yml` is a component-only deployment definition.
It builds the web shell and expects an existing Factory endpoint accessible
from the container. Its environment mapping differs from the released stack.
Use the root Compose image and guide for new installations.

The [native systemd runbook](../deploy/README.md) covers existing installations
using `proser-v2-web`, including its host-owned `.env.web`, TLS, and upgrades.
