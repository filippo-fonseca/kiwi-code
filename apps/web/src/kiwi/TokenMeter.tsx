/**
 * kiwi-ui: the token meter — run totals (input/output/cost) plus a per-agent
 * mini table derived from BgsdTokensSummary.byAgent. Everything is optional in
 * the contract, so absent fields degrade gracefully.
 */
import { forwardRef } from "react";
import type { BgsdTokensSummary } from "@t3tools/contracts";

import { compactNumber, formatCost } from "./kiwiTheme";

interface AgentTokenRow {
  agent: string;
  input: number | null;
  output: number | null;
  cost: number | null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" ? value : null;
}

function agentRows(tokens: BgsdTokensSummary | null | undefined): AgentTokenRow[] {
  const byAgent = tokens?.byAgent;
  if (!byAgent || typeof byAgent !== "object") return [];
  return Object.entries(byAgent).map(([agent, raw]) => {
    const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return {
      agent,
      input: readNumber(record, "input"),
      output: readNumber(record, "output"),
      cost: readNumber(record, "cost"),
    };
  });
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col rounded-md bg-muted/50 px-2.5 py-1.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold text-foreground">{value}</span>
    </div>
  );
}

export const TokenMeter = forwardRef<
  HTMLDivElement,
  { tokens: BgsdTokensSummary | null | undefined }
>(function TokenMeter({ tokens }, ref) {
  const totals = tokens?.totals ?? {};
  const rows = agentRows(tokens);
  const costKnown = totals.costKnown ?? totals.cost != null;

  return (
    <div
      ref={ref}
      className="scroll-mt-2 rounded-lg border border-border/80 bg-card/40 p-3"
      data-kiwi-token-meter
    >
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Tokens
      </h4>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Input" value={compactNumber(totals.input)} />
        <Stat label="Output" value={compactNumber(totals.output)} />
        <Stat label="Cost" value={formatCost(totals.cost, costKnown)} />
      </div>
      {rows.length > 0 ? (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Agent</th>
                <th className="py-1 pr-2 text-right font-medium">In</th>
                <th className="py-1 pr-2 text-right font-medium">Out</th>
                <th className="py-1 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.agent} className="border-t border-border/50">
                  <td className="truncate py-1 pr-2 font-mono text-[11px] text-foreground">
                    {row.agent}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">
                    {compactNumber(row.input)}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">
                    {compactNumber(row.output)}
                  </td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground">
                    {row.cost != null ? `$${row.cost.toFixed(2)}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
});
