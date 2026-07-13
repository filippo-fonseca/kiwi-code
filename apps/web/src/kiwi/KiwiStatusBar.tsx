/**
 * kiwi-ui: the one-line status strip mounted under the chat composer.
 *
 * Layout: Model <m> | Ctx <n>k (<pct>%) | ⎇ <branch> | (+a,-d) | <stage · n agents>
 *
 * bgsd data (model/stage/agents/tokens) comes from the bgsdStore; branch and
 * diff-stat come from the app's existing git status, passed in as props (the
 * component owns no data fetching). Segments are buttons: the stage segment
 * opens the Kiwi surface; the ctx/cost segment reveals the dashboard token
 * section. Renders nothing when there is neither bgsd nor git data, so
 * non-bgsd users see zero visual change unless they have git status to show.
 */
import { useMemo } from "react";

import { selectCurrentStage, selectTotals, useBgsdStore } from "./bgsdStore";
import { cn } from "~/lib/utils";
import { compactNumber, formatCost, KIWI_ACCENT_TEXT, STAGE_LABELS } from "./kiwiTheme";

export interface KiwiStatusBarProps {
  /** Current thread branch, if the app knows it. */
  branch?: string | null;
  /** Working-tree insertions/deletions, if a git repo. */
  additions?: number | null;
  deletions?: number | null;
  /** Optional context-window usage for the active model. */
  contextTokens?: number | null;
  contextWindow?: number | null;
  /** Open the Kiwi dashboard surface (wired by the host). */
  onOpenKiwi?: () => void;
  className?: string;
}

function Segment({
  onClick,
  title,
  children,
}: {
  onClick?: (() => void) | undefined;
  title?: string | undefined;
  children: React.ReactNode;
}) {
  const classes =
    "flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-muted-foreground";
  if (!onClick) {
    return (
      <span className={classes} title={title}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(classes, "hover:bg-accent hover:text-foreground")}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="text-border">|</span>;
}

export function KiwiStatusBar(props: KiwiStatusBarProps) {
  const snapshot = useBgsdStore((state) => state.snapshot);
  const requestTokenFocus = useBgsdStore((state) => state.requestTokenFocus);

  const stage = useMemo(() => selectCurrentStage(snapshot), [snapshot]);
  const totals = useMemo(() => selectTotals(snapshot), [snapshot]);

  const bgsdAvailable = Boolean(snapshot?.available);
  const model =
    snapshot?.agents?.find((agent) => agent.model)?.model ??
    snapshot?.health?.conductor?.name ??
    null;

  const hasDiff =
    (props.additions != null && props.additions > 0) ||
    (props.deletions != null && props.deletions > 0);
  const hasGit = Boolean(props.branch) || hasDiff;

  // Zero visual change for non-bgsd users unless there's git data to show.
  if (!bgsdAvailable && !hasGit) return null;

  const contextPct =
    props.contextTokens != null && props.contextWindow && props.contextWindow > 0
      ? Math.round((props.contextTokens / props.contextWindow) * 100)
      : null;

  const openTokenSection = () => {
    requestTokenFocus();
    props.onOpenKiwi?.();
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1 overflow-x-auto px-2 py-1 text-[11px] leading-none",
        props.className,
      )}
      data-kiwi-status-bar
    >
      {bgsdAvailable && model ? (
        <>
          <Segment title="Active model">
            <span className={KIWI_ACCENT_TEXT}>Model</span>
            <span className="text-foreground">{model}</span>
          </Segment>
          {props.contextTokens != null ? (
            <>
              <Divider />
              <Segment title="Context window usage" onClick={openTokenSection}>
                Ctx {compactNumber(props.contextTokens)}
                {contextPct != null ? ` (${contextPct}%)` : ""}
              </Segment>
            </>
          ) : totals.cost != null || totals.costKnown ? (
            <>
              <Divider />
              <Segment title="Run token cost" onClick={openTokenSection}>
                {formatCost(totals.cost, totals.costKnown)}
              </Segment>
            </>
          ) : null}
        </>
      ) : null}

      {props.branch ? (
        <>
          {bgsdAvailable && model ? <Divider /> : null}
          <Segment title="Current branch">
            <span aria-hidden>⎇</span>
            <span className="font-mono text-foreground">{props.branch}</span>
          </Segment>
        </>
      ) : null}

      {hasDiff ? (
        <>
          {props.branch || (bgsdAvailable && model) ? <Divider /> : null}
          <Segment title="Working-tree changes">
            <span className="text-[#5b8c2f] dark:text-[#a5d66b]">+{props.additions ?? 0}</span>
            <span className="text-destructive">-{props.deletions ?? 0}</span>
          </Segment>
        </>
      ) : null}

      {bgsdAvailable && stage ? (
        <>
          <Divider />
          <Segment title="Open Kiwi dashboard" onClick={props.onOpenKiwi}>
            <span className={KIWI_ACCENT_TEXT}>{STAGE_LABELS[stage] ?? stage}</span>
            <span>
              · {totals.agentCount} agent{totals.agentCount === 1 ? "" : "s"}
            </span>
          </Segment>
        </>
      ) : null}
    </div>
  );
}
