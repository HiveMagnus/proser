# Contributing to Proser

Thank you for your interest in contributing to Proser! This guide covers the development workflow and conventions.

---

## Getting started

1. Follow the [Development Setup Guide](docs/DEVELOPMENT.md) to configure your environment
2. Create a feature branch from `main`
3. Make your changes
4. Run tests and linting
5. Submit a pull request

---

## Branch conventions

- `main` — stable, deployable code
- `feat/description` — new features
- `fix/description` — bug fixes
- `docs/description` — documentation changes
- `refactor/description` — code refactoring

---

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add character relationship graph to story bible
fix: prevent duplicate codex entries on rapid save
docs: update API documentation for export endpoints
refactor: extract prompt builder into ai-runtime package
test: add workflow reconnect coverage
```

Scope is optional but helpful:

```
feat(api): add batch export endpoint
fix(web): keyboard shortcut conflict with editor
```

---

## Code style

- **TypeScript** — strict mode, no `any` unless unavoidable
- **Formatting** — Prettier handles all formatting (`pnpm format`)
- **Linting** — ESLint enforces code quality (`pnpm lint`)
- **Imports** — use workspace package names for shared packages and `@/*` for `apps/web/src/*`
- **Path aliases** — use `@/` for intra-app imports (e.g., `@/components/ui`)

---

## Testing

Run the full test suite before submitting:

```bash
pnpm test         # All Vitest tests
pnpm typecheck    # TypeScript validation
pnpm lint         # ESLint
pnpm format:check # Prettier check
```

### Writing tests

- Place tests in `__tests__/` directories adjacent to source code
- Use Vitest (`describe`, `it`, `expect`)
- Mock external dependencies (database, AI, Redis)
- Name test files `*.test.ts` or `*.test.tsx`

### E2E tests

```bash
cd apps/web
corepack pnpm exec playwright test --project=smoke --project=factory-proxy
```

---

Use the [E2E setup guide](docs/DEVELOPMENT.md#playwright-e2e) for browser installation,
disposable credentials and mobile projects.

## Project structure rules

- **Reusable browser/domain types** go in `packages/contracts`
- **Factory API schemas and model calls** belong in the sibling `ProserFactory/` component; ProserAuthor keeps only client/proxy helpers
- **Inference configuration and execution** belong to ProserFactory; Author retains only typed browser context and review controls
- **UI components** go in `apps/web/src/components`; reusable document controls belong in `packages/editor`
- **Backend runtime** (API + workers) lives in `ProserFactory/`, not in the Author workspace

---

## Pull request checklist

- [ ] Code compiles without errors (`pnpm typecheck`)
- [ ] Tests pass (`pnpm test`)
- [ ] New features have tests
- [ ] No linting warnings (`pnpm lint`)
- [ ] Documentation updated if applicable
- [ ] Commit messages follow conventional format
