# ADR 003 — Provider-Agnostic AI Gateway

**Status:** Superseded
**Date:** 2025-01-15

> Model routing now lives in ProserFactory. ProserAuthor uses `/api/models/*` through the web proxy and does not connect to model providers directly.

## Context

Proser relies heavily on LLM inference for prose generation, summarization, brainstorming, and quality analysis. Users may want to use different AI providers (local Ollama, OpenAI, Anthropic, OpenRouter) depending on their setup and budget.

## Decision

Implement a **provider-agnostic AI gateway** in `packages/ai-runtime` that abstracts model calls behind a common interface.

## Rationale

- **Local-first by default** — Ollama enables fully offline, private writing with no API costs or data leaving the machine.
- **Provider flexibility** — the gateway pattern lets users swap providers via environment variables without code changes.
- **Streaming-first** — all providers implement a common streaming interface, enabling consistent SSE delivery to the front-end.
- **Cost control** — users can run cheap local models for drafting and use premium APIs for final polishing.
- **Alternative considered:** Direct Ollama SDK calls — simpler but locks out cloud providers. LangChain — too heavy for our needs and adds abstraction we don't benefit from.

## Consequences

- `packages/ai-runtime` exports a `ModelGateway` with `generate()`, `chat()`, and `embed()` methods
- Provider selection is config-driven (`OLLAMA_HOST`, `OPENAI_API_KEY`, etc.)
- Prompt templates live in `packages/ai-runtime/src/prompts/`
- Token usage and latency are tracked per call for observability
