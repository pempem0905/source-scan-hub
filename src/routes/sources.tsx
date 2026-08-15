import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { getSources } from "@/lib/dashboard.functions";
import { Empty, PageHeader, Panel, Table, Tag, Td, fmtDate, statusTone } from "@/components/dash";
import { Input } from "@/components/ui/input";

const sourcesQuery = queryOptions({ queryKey: ["sources"], queryFn: () => getSources() });

export const Route = createFileRoute("/sources")({
  head: () => ({
    meta: [
      { title: "Source Explorer — Source Scan Hub" },
      {
        name: "description",
        content:
          "Search and filter discovered sources and candidates by type, domain, merchant, authority score and resolution status.",
      },
      { property: "og:title", content: "Source Explorer — Source Scan Hub" },
      {
        property: "og:description",
        content: "Browse every discovered source and candidate in the Phase 1 index.",
      },
    ],
  }),
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(sourcesQuery);
  },
  component: SourceExplorer,
  errorComponent: ({ error }) => <div role="alert" className="text-xs text-danger">{error.message}</div>,
});

function SourceExplorer() {
  const { data } = useSuspenseQuery(sourcesQuery);
  const [q, setQ] = useState("");
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");

  const types = useMemo(
    () => Array.from(new Set(data.map((r: any) => r.source_type).filter(Boolean))).sort(),
    [data],
  );
  const statuses = useMemo(
    () => Array.from(new Set(data.map((r: any) => r.status).filter(Boolean))).sort(),
    [data],
  );

  const rows = data.filter((r: any) => {
    const hay = `${r.domain ?? ""} ${r.url ?? ""} ${r.merchant ?? ""}`.toLowerCase();
    return (
      hay.includes(q.toLowerCase()) &&
      (type === "all" || r.source_type === type) &&
      (status === "all" || r.status === status)
    );
  });

  return (
    <>
      <PageHeader
        title="Source Explorer"
        subtitle="Sources + candidates across the Vietnam-serving ecosystem, any TLD."
        right={<span className="font-mono text-xs text-muted-foreground">{rows.length} rows</span>}
      />
      <Panel>
        <div className="mb-3 flex flex-wrap gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search domain, URL or merchant…"
            className="h-8 max-w-xs text-xs"
          />
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="h-8 rounded border border-input bg-background px-2 text-xs"
          >
            <option value="all">All types</option>
            {types.map((t: any) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-8 rounded border border-input bg-background px-2 text-xs"
          >
            <option value="all">All statuses</option>
            {statuses.map((s: any) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        {rows.length === 0 ? (
          <Empty label="No sources discovered yet" />
        ) : (
          <Table
            head={[
              "Kind",
              "Type",
              "Domain / URL",
              "Flags",
              "Merchant",
              "Authority",
              "Status",
              "Resolution",
              "Last scan",
            ]}
          >
            {rows.map((r: any) => (
              <tr key={`${r.kind}-${r.id}`} className="border-b border-border/50 hover:bg-accent/40">
                <Td>
                  <Tag tone={r.kind === "source" ? "info" : "muted"}>{r.kind}</Tag>
                </Td>
                <Td mono>{r.source_type ?? "—"}</Td>
                <Td>
                  <div className="max-w-[360px] truncate font-mono">{r.domain ?? r.url}</div>
                  <div className="max-w-[360px] truncate text-[10px] text-muted-foreground">
                    {r.url}
                  </div>
                </Td>
                <Td>
                  <div className="flex gap-1">
                    {r.is_official ? <Tag tone="ok">official</Tag> : null}
                    {r.is_radar ? <Tag tone="info">radar</Tag> : null}
                  </div>
                </Td>
                <Td>{r.merchant ?? "—"}</Td>
                <Td mono>{r.authority_score ?? 0}</Td>
                <Td>
                  <Tag tone={statusTone(r.status)}>{r.status}</Tag>
                </Td>
                <Td>
                  <Tag tone={statusTone(r.resolution_status)}>{r.resolution_status}</Tag>
                </Td>
                <Td mono>{fmtDate(r.last_scan_at)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
