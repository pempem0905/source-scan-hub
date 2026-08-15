import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4 border-b border-border pb-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {subtitle ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      {right}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: number | string | null | undefined;
  hint?: string;
  tone?: "default" | "ok" | "warn" | "danger";
}) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 font-mono text-2xl tabular-nums",
          tone === "ok" && "text-ok",
          tone === "warn" && "text-warn",
          tone === "danger" && "text-danger",
        )}
      >
        {empty ? "0" : value}
      </div>
      {hint ? <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function Metric({
  label,
  value,
  unit,
  tone = "default",
  hasData = true,
}: {
  label: string;
  value: number;
  unit?: string;
  tone?: "default" | "ok" | "warn" | "danger";
  hasData?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-2 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      {hasData ? (
        <span
          className={cn(
            "font-mono text-sm tabular-nums",
            tone === "ok" && "text-ok",
            tone === "warn" && "text-warn",
            tone === "danger" && "text-danger",
          )}
        >
          {Number.isFinite(value) ? value.toFixed(2).replace(/\.00$/, "") : "0"}
          {unit ? <span className="ml-1 text-muted-foreground">{unit}</span> : null}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">No data yet</span>
      )}
    </div>
  );
}

export function Panel({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-md border border-border bg-card", className)}>
      {title ? (
        <header className="border-b border-border px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          {title}
        </header>
      ) : null}
      <div className="p-3">{children}</div>
    </section>
  );
}

const TONES: Record<string, string> = {
  ok: "border-ok/40 bg-ok/10 text-ok",
  warn: "border-warn/40 bg-warn/10 text-warn",
  danger: "border-danger/40 bg-danger/10 text-danger",
  info: "border-info/40 bg-info/10 text-info",
  muted: "border-border bg-muted text-muted-foreground",
};

export function statusTone(status?: string | null): keyof typeof TONES {
  const s = (status ?? "").toLowerCase();
  if (["active", "resolved", "completed", "verified", "official", "done", "running"].includes(s))
    return "ok";
  if (["pending", "new", "candidate", "retry", "queued", "idle"].includes(s)) return "warn";
  if (["error", "failed", "blocked", "dead", "duplicate", "rejected"].includes(s)) return "danger";
  return "muted";
}

export function Tag({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: keyof typeof TONES;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Bar({ value, tone = "ok" }: { value: number; tone?: "ok" | "warn" | "danger" }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
      <div
        className={cn(
          "h-full rounded",
          tone === "ok" && "bg-ok",
          tone === "warn" && "bg-warn",
          tone === "danger" && "bg-danger",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Empty({ label = "No data yet" }: { label?: string }) {
  return (
    <div className="px-3 py-10 text-center text-xs text-muted-foreground">{label}</div>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border text-left">
            {head.map((h) => (
              <th
                key={h}
                className="whitespace-nowrap px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return (
    <td className={cn("whitespace-nowrap px-2 py-1.5 align-middle", mono && "font-mono")}>
      {children}
    </td>
  );
}

export function fmtDate(v?: string | null) {
  if (!v) return "—";
  return new Date(v).toISOString().slice(0, 16).replace("T", " ");
}
