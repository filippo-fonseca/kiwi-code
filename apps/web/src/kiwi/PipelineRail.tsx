/**
 * kiwi-ui: the pipeline rail — Conductor > Loop 1 > Merge > Loop 2 > Review Gate.
 * The current stage is highlighted with the kiwi accent and a pulse; earlier
 * stages read as dimmed-complete; later stages are muted.
 */
import type { BgsdStage } from "@t3tools/contracts";

import { KIWI_STAGE_ORDER } from "./bgsdStore";
import { cn } from "~/lib/utils";
import { STAGE_LABELS } from "./kiwiTheme";

const RAIL_STAGES = KIWI_STAGE_ORDER.filter((stage) => stage !== "done");

export function PipelineRail({ stage }: { stage: BgsdStage | null }) {
  const activeIndex = stage ? (RAIL_STAGES as readonly string[]).indexOf(stage) : -1;

  return (
    <div className="flex items-center gap-1 overflow-x-auto px-1 py-2" data-kiwi-pipeline-rail>
      {RAIL_STAGES.map((railStage, index) => {
        const isActive = index === activeIndex;
        const isComplete = activeIndex >= 0 && index < activeIndex;
        return (
          <div key={railStage} className="flex min-w-0 items-center gap-1">
            <div
              className={cn(
                "relative flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                isActive &&
                  "bg-[#7cb342]/15 text-[#5b8c2f] ring-1 ring-inset ring-[#7cb342]/40 dark:text-[#a5d66b]",
                isComplete && "bg-muted/60 text-muted-foreground",
                !isActive && !isComplete && "text-muted-foreground/50",
              )}
              aria-current={isActive ? "step" : undefined}
            >
              {isActive ? (
                <span className="relative flex size-2 shrink-0">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#7cb342] opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-[#7cb342]" />
                </span>
              ) : (
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    isComplete ? "bg-muted-foreground/60" : "bg-muted-foreground/25",
                  )}
                />
              )}
              <span className="truncate">{STAGE_LABELS[railStage] ?? railStage}</span>
            </div>
            {index < RAIL_STAGES.length - 1 ? (
              <span
                className={cn(
                  "h-px w-4 shrink-0",
                  isComplete ? "bg-muted-foreground/40" : "bg-border",
                )}
                aria-hidden
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
