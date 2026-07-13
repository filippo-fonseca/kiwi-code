/**
 * kiwi-ui: the collapsible "bgsd" sidebar section listing Kiwi sessions.
 *
 * Renders nothing when no bgsd workspace is available (snapshot absent or
 * `available === false`). Each row shows the session title, scale, a state
 * pill, and a relative updated-at. Clicking a session asks the host (ChatView)
 * to open/activate the Kiwi surface on the active thread via the store's
 * openSurface request; the sidebar is thread-agnostic so it does not itself
 * hold a thread ref.
 */
import type { BgsdSessionSummary } from "@t3tools/contracts";
import { Bot, ChevronDown } from "lucide-react";
import { useState } from "react";

import { useBgsdStore } from "./bgsdStore";
import { cn } from "~/lib/utils";
import { relativeTime } from "./kiwiTheme";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/components/ui/sidebar";

function statePillClasses(state: string | undefined): string {
  const value = (state ?? "").toLowerCase();
  if (value === "done") return "bg-muted text-muted-foreground";
  if (value === "review" || value === "checkpoint" || value === "paused") {
    return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  }
  if (value === "aborted") return "bg-destructive/15 text-destructive";
  return "bg-[#7cb342]/15 text-[#5b8c2f] dark:text-[#a5d66b]";
}

function SessionRow({ session, onOpen }: { session: BgsdSessionSummary; onOpen: () => void }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        className="h-auto flex-col items-start gap-0.5 py-1.5"
        onClick={onOpen}
      >
        <span className="flex w-full items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">
            {session.title ?? session.run_id}
          </span>
          {session.updated_at ? (
            <span className="shrink-0 text-[10px] text-muted-foreground/70">
              {relativeTime(session.updated_at)}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5">
          {session.state ? (
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[9px] font-medium",
                statePillClasses(session.state),
              )}
            >
              {session.state}
            </span>
          ) : null}
          {session.scale ? (
            <span className="text-[10px] text-muted-foreground/70">{session.scale}</span>
          ) : null}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function KiwiSidebarSection() {
  const snapshot = useBgsdStore((state) => state.snapshot);
  const requestOpenSurface = useBgsdStore((state) => state.requestOpenSurface);
  const [collapsed, setCollapsed] = useState(false);

  // Hide the section entirely when no bgsd workspace is available.
  if (!snapshot?.available) return null;

  const sessions = snapshot.sessions?.sessions ?? [];
  if (sessions.length === 0) return null;

  return (
    <SidebarGroup className="px-2 pt-2 pb-1">
      <SidebarGroupLabel
        render={
          <button type="button" onClick={() => setCollapsed((value) => !value)}>
            <Bot className="text-[#7cb342]" />
            <span className="flex-1 text-left">bgsd</span>
            <ChevronDown
              className={cn("size-3.5 transition-transform", collapsed && "-rotate-90")}
            />
          </button>
        }
      />
      {!collapsed ? (
        <SidebarGroupContent>
          <SidebarMenu>
            {sessions.map((session) => (
              <SessionRow key={session.run_id} session={session} onOpen={requestOpenSurface} />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      ) : null}
    </SidebarGroup>
  );
}
