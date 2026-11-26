#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ─── Colors ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[  OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }

echo ""
echo -e "${CYAN}  ╔═══════════════════════════════╗${NC}"
echo -e "${CYAN}  ║      Proser V2 Setup           ║${NC}"
echo -e "${CYAN}  ╚═══════════════════════════════╝${NC}"
echo ""

# ─── 1. Check prerequisites ─────────────────────────────
info "Checking prerequisites..."

command -v node >/dev/null 2>&1 || fail "Node.js is required. Install from https://nodejs.org/"
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 22 ]]; then
  fail "Node.js >= 22.13 required (found v${NODE_VERSION})"
fi
ok "Node.js v$(node -v | sed 's/v//')"

command -v pnpm >/dev/null 2>&1 || {
  warn "pnpm not found. Installing via corepack..."
  corepack enable
  corepack prepare pnpm@12.16.1 --activate
}
ok "pnpm $(pnpm -v)"

# ─── 2. Environment file ────────────────────────────────
if [[ ! -f .env ]]; then
  info "Copying .env.example to .env..."
  cp .env.example .env
  ok "Created .env — edit it to configure your setup"
else
  ok ".env already exists"
fi

# ─── 3. Install dependencies ────────────────────────────
info "Installing dependencies..."
pnpm install
ok "Dependencies installed"

# ─── 4. Build ───────────────────────────────────────────
info "Building active web workspace..."
pnpm --filter @hivemagnus/proser-web... build
ok "Build complete"

# ─── Done ────────────────────────────────────────────────
echo ""
echo -e "${GREEN}  ╔═══════════════════════════════╗${NC}"
echo -e "${GREEN}  ║      Setup Complete!           ║${NC}"
echo -e "${GREEN}  ╚═══════════════════════════════╝${NC}"
echo ""
echo -e "  Start development:  ${CYAN}pnpm --filter @hivemagnus/proser-web dev${NC}"
echo -e "  Web UI:             ${CYAN}http://localhost:3000${NC}"
echo ""
echo -e "  ${YELLOW}Don't forget to:${NC}"
echo -e "  • Point ${CYAN}FACTORY_URL${NC} at ProserFactory, for example ${CYAN}https://factory.example.com${NC}"
echo -e "  • Edit ${CYAN}.env${NC} with your auth settings"
echo ""
