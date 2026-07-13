# Kiwi Code divergence from upstream

This file is the complete, enumerated record of every upstream (`pingdotgg/t3code`)
file that Kiwi Code modifies, and why. It is the map used during the weekly
`git merge upstream/main` to know where and why we differ.

**Every future Kiwi Code PR MUST keep this table current.** If a PR touches a
file that upstream owns, add or update its row here in the same PR. If a PR stops
diverging on a file (for example, upstream adopts our change), remove its row.
A PR that changes upstream files without updating this table is incomplete.

## Modified files

| File                                         | What changed                                                                                                                                                                                                                                                                                                                                                                            | Why                                                                                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KIWI.md`                                    | New file (Kiwi-only).                                                                                                                                                                                                                                                                                                                                                                   | Documents what Kiwi Code is and the fork-sync model.                                                                                                       |
| `KIWI-DIVERGENCE.md`                         | New file (Kiwi-only).                                                                                                                                                                                                                                                                                                                                                                   | This divergence record itself.                                                                                                                             |
| `apps/web/src/branding.ts`                   | Default `APP_BASE_NAME` changed from `"T3 Code"` to `"Kiwi Code"`.                                                                                                                                                                                                                                                                                                                      | Rebrand the web app product name. The value is still injectable from the desktop bridge, so only the fallback default moved.                               |
| `apps/desktop/src/app/DesktopEnvironment.ts` | Module-level `APP_BASE_NAME` constant changed from `"T3 Code"` to `"Kiwi Code"`.                                                                                                                                                                                                                                                                                                        | Rebrand the desktop app display name (drives window title, About panel, dock name).                                                                        |
| `apps/desktop/scripts/electron-launcher.mjs` | `APP_DISPLAY_NAME` changed from `"T3 Code (Dev)"` / `"T3 Code (Alpha)"` to `"Kiwi Code (Dev)"` / `"Kiwi Code (Alpha)"`.                                                                                                                                                                                                                                                                 | Rebrand the dev/packaged launcher bundle name (macOS `.app` display name and helper bundle names).                                                         |
| `apps/desktop/package.json`                  | `productName` changed from `"T3 Code (Alpha)"` to `"Kiwi Code (Alpha)"`.                                                                                                                                                                                                                                                                                                                | Rebrand the electron-builder product name for packaged Alpha builds.                                                                                       |
| `scripts/build-desktop-artifact.ts`          | `DESKTOP_APP_ID` changed from `"com.t3tools.t3code"` to `"com.filippofonseca.kiwicode"`; `resolveDesktopProductName` nightly fallback changed from `"T3 Code (Nightly)"` to `"Kiwi Code (Nightly)"` and default fallback from `"T3 Code"` to `"Kiwi Code"`; `resolveGitHubPublishConfig` now defaults the update repository to `filippo-fonseca/kiwi-code` when no env override is set. | Give packaged Kiwi builds their own bundle identity and point the auto-update feed at the Kiwi repo so it can never resolve upstream (pingdotgg) releases. |

## Deliberately NOT changed (documented decisions)

- **App id / bundle id at runtime (`com.t3tools.t3code`).** The macOS/Windows/Linux
  runtime bundle identifiers in `apps/desktop/src/app/DesktopEnvironment.ts`
  (`appUserModelId`, `linuxDesktopEntryName`, `linuxWmClass`) and in
  `apps/desktop/scripts/electron-launcher.mjs` (`APP_BUNDLE_ID`,
  `APP_PROTOCOL_SCHEMES` such as `t3code`) were left as-is. These are protocol
  handlers, OS registration identifiers, and deep-link schemes. Changing them
  risks breaking dev-mode launch, deep links, and single-instance behavior, and
  they are internal identifiers rather than user-visible product name. Only the
  packaged build `appId` (in `build-desktop-artifact.ts`, which is what ships to
  end users) was rebranded to `com.filippofonseca.kiwicode`. Aligning the runtime
  identifiers and protocol schemes is deferred to a later phase.
- **userData directory names (`t3code`, `t3code-dev`, and legacy `T3 Code (Alpha)`).**
  `userDataDirName` / `legacyUserDataDirName` in `DesktopEnvironment.ts` were left
  unchanged. Renaming the userData directory would orphan any existing user
  settings/state and there is legacy-path migration logic keyed on these names.
  This is a state-migration concern, not a simple config change, so it is deferred.
- **Environment variable prefixes (`T3CODE_*`) and telemetry/span keys**
  (for example `desktop.appIdentity.configure`, `t3codeCommitHash`,
  `@t3tools/desktop/...` service tags). Left unchanged: these are internal
  contract keys, config env names, and observability identifiers. Renaming them
  would break configuration and telemetry continuity with no user-facing benefit.
- **In-prose product-name string literals.** There are roughly 35 occurrences of
  the literal `"T3 Code"` in `apps/web/src` (settings help text, update prompts,
  error messages, version-skew hints) and roughly 10 in `apps/desktop/src`
  (WSL/SSH error messages, application menu copy). These are hardcoded prose, not
  the authoritative name constant. They were left for a later dedicated copy pass:
  rewriting them here would be noisy, would not flow from the injectable name
  constant, and risks touching wording under active upstream churn (raising merge
  cost). The authoritative display name (`APP_BASE_NAME` in both `branding.ts` and
  `DesktopEnvironment.ts`) is rebranded, which is what titles, About, and dock use.

## Pending

- **Icons.** Kiwi Code still ships the upstream t3code icons
  (`apps/desktop/resources/`, `assets/`, `favicon.svg`, brand asset paths in
  `build-desktop-artifact.ts`). Kiwi-branded icons are pending and were
  intentionally not designed in this phase.
