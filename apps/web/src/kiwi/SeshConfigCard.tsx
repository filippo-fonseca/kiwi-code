/**
 * kiwi-ui: the session config card — scale, model contract, verification depth.
 * Every field is optional in the contract, so each row renders only when its
 * data is present; if nothing is available, the whole card renders nothing.
 */
import type { BgsdWorkspaceSnapshot } from "@t3tools/contracts";

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-right text-xs font-medium text-foreground">{value}</span>
    </div>
  );
}

function readString(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function SeshConfigCard({ snapshot }: { snapshot: BgsdWorkspaceSnapshot }) {
  const scale = snapshot.plan?.scale ?? null;
  const capabilities = snapshot.health?.capabilities ?? {};
  const health = snapshot.health as Record<string, unknown> | null | undefined;

  // Model contract / verification depth are additive fields that may live under
  // health config; read defensively so absent fields simply don't render.
  const healthConfig =
    health && typeof health.config === "object" && health.config
      ? (health.config as Record<string, unknown>)
      : undefined;
  const modelContract =
    readString(healthConfig, "model_contract") ??
    readString(healthConfig, "modelContract") ??
    readString(healthConfig, "model_posture");
  const verificationDepth =
    readString(healthConfig, "verification_depth") ?? readString(healthConfig, "verificationDepth");

  const capabilityKeys = Object.entries(capabilities)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key);

  const rows: { label: string; value: string }[] = [];
  if (scale) rows.push({ label: "Scale", value: scale });
  if (modelContract) rows.push({ label: "Model contract", value: modelContract });
  if (verificationDepth) rows.push({ label: "Verification depth", value: verificationDepth });
  if (snapshot.health?.bgsd_version) {
    rows.push({ label: "bgsd", value: `v${snapshot.health.bgsd_version}` });
  }
  if (snapshot.source) rows.push({ label: "Source", value: snapshot.source });

  if (rows.length === 0 && capabilityKeys.length === 0) return null;

  return (
    <div className="rounded-lg border border-border/80 bg-card/40 p-3" data-kiwi-sesh-config>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Session
      </h4>
      {rows.map((row) => (
        <ConfigRow key={row.label} label={row.label} value={row.value} />
      ))}
      {capabilityKeys.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {capabilityKeys.map((key) => (
            <span
              key={key}
              className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              {key}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
