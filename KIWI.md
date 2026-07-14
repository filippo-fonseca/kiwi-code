# Kiwi Code

Kiwi Code is a full-identity fork of [t3code](https://github.com/pingdotgg/t3code)
that doubles as the living GUI for **bgsd** (the "Kiwi" Conductor, an autonomous,
self-verifying orchestration layer on top of GSD).

## What Kiwi Code is

- A rebrand of t3code carrying its own product identity (name, app id, update
  feed, bundle identifiers). Stock t3code behavior is fully preserved: every
  feature upstream ships continues to work unchanged.
- The desktop client for the Kiwi Conductor. bgsd-specific features light up
  only when the open workspace contains a `.bgsd/` directory. In any other
  workspace, Kiwi Code behaves exactly like t3code, so the fork stays useful as
  a general coding client.

## Fork-sync model

- `upstream` points at `pingdotgg/t3code` (the source project).
- `origin` points at `filippo-fonseca/kiwi-code` (this fork).
- We track upstream weekly:

  ```sh
  git fetch upstream
  git merge upstream/main
  ```

- Every file Kiwi Code diverges from upstream on is enumerated in
  `WHAT_CHANGED_FROM_T3.md`. Keeping that table small and current is what keeps the
  weekly merge cheap. When a merge conflicts, the divergence table is the map of
  where and why we differ.

## Where the plan lives

The Kiwi Code build is planned across a set of GitHub issues:

- **kiwi-code#1**: master plan (the umbrella tracking issue).
- **kiwi-code#2 through kiwi-code#5**: the phased build (Phase 0 is repo
  identity and rebrand; later phases wire the bgsd GUI surfaces).
- **better-gsd#12**: the bgsd-side API that Kiwi Code talks to (the Conductor
  bridge the GUI drives).

## bgsd context

This fork is developed alongside bgsd itself (the `better-gsd` repo). When you
need history on what the Conductor built or changed, that context lives under
`.bgsd/` in a bgsd-orchestrated workspace (the ledger, per-session records, and
aggregated planning markdown). Kiwi Code is the front end that will eventually
observe and drive those sessions.
