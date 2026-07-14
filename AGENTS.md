# AGENTS.md

## Kiwi Code fork context

Kiwi Code is a bgsd-native fork of upstream `pingdotgg/t3code`. It follows an
additive-only architecture: Kiwi-specific code lives in dedicated modules
(`apps/web/src/kiwi/`, `apps/server/src/bgsd/`, `packages/contracts/src/bgsd.ts`)
and touches upstream-owned files as little as possible, so the fork can sync with
upstream weekly via `git merge upstream/main` with a small, well-documented
conflict surface.

## Divergence-log rule (required on every PR)

Every PR that changes anything relative to upstream t3code MUST update
`WHAT_CHANGED_FROM_T3.md` in the same PR: add a row for a newly diverging file,
update the row when the change moves, and remove the row when the file stops
diverging (for example, upstream adopts our change). A PR that touches an
upstream-owned file without updating `WHAT_CHANGED_FROM_T3.md` is incomplete.
That document is the canonical, exhaustive record of everything Kiwi Code changed
from upstream, and the map used during each weekly upstream sync.

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `vp run lint:mobile` must also pass.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.

## Project Snapshot

Kiwi Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `bun run sync:repos`; use `bun run sync:repos --repo <id>` to sync one
  configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.
