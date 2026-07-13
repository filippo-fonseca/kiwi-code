/**
 * kiwi-ui: the agent grid — one card per bgsd subagent. Shows the unit title,
 * phase, a status pill, a heartbeat freshness dot, model + assignment reason,
 * iteration progress, and a copyable worktree path.
 */
import type { BgsdAgent } from "@t3tools/contracts";
import { Check, Copy } from "lucide-react";

import { bucketForAgent } from "./bgsdStore";
import { cn } from "~/lib/utils";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  heartbeatDotClasses,
  relativeTime,
  STATUS_PILL_LABELS,
  statusPillClasses,
} from "./kiwiTheme";

function WorktreePath({ path }: { path: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "worktree path" });
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-md bg-muted/50 px-2 py-1">
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
        {path}
      </code>
      <button
        type="button"
        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Copy worktree path"
        onClick={() => copyToClipboard(path, undefined)}
      >
        {isCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </div>
  );
}

function AgentCard({ agent }: { agent: BgsdAgent }) {
  const bucket = bucketForAgent(agent);
  const title = agent.unit_id ? `${agent.unit_id}` : agent.agent_id;
  const iteration = agent.progress?.iteration;
  const maxIterations = agent.progress?.max_iterations;
  const reason = agent.model_assignment?.reason;

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border/80 bg-card/40 p-3"
      data-kiwi-agent-card={agent.agent_id}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    heartbeatDotClasses(agent.heartbeat),
                  )}
                />
              }
            />
            <TooltipPopup>
              heartbeat: {agent.heartbeat ?? "unknown"}
              {agent.heartbeat_at ? ` · ${relativeTime(agent.heartbeat_at)} ago` : ""}
            </TooltipPopup>
          </Tooltip>
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
            statusPillClasses(bucket),
          )}
        >
          {STATUS_PILL_LABELS[bucket]}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {agent.phase ? (
          <span>
            phase <span className="text-foreground">{agent.phase}</span>
          </span>
        ) : null}
        {agent.model ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="cursor-default">
                  model <span className="text-foreground">{agent.model}</span>
                </span>
              }
            />
            <TooltipPopup>
              {reason ?? "model assignment"}
              {agent.model_assignment?.tier ? ` (tier: ${agent.model_assignment.tier})` : ""}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {typeof iteration === "number" ? (
          <span>
            iter{" "}
            <span className="text-foreground">
              {iteration}
              {typeof maxIterations === "number" ? `/${maxIterations}` : ""}
            </span>
          </span>
        ) : null}
      </div>

      {agent.worktree ? <WorktreePath path={agent.worktree} /> : null}
    </div>
  );
}

export function AgentGrid({ agents }: { agents: readonly BgsdAgent[] }) {
  if (agents.length === 0) {
    return (
      <p className="px-1 py-4 text-center text-xs text-muted-foreground">No agents spawned yet.</p>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-kiwi-agent-grid>
      {agents.map((agent) => (
        <AgentCard key={agent.agent_id} agent={agent} />
      ))}
    </div>
  );
}
