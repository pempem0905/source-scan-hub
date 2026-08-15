const APIFY_API_BASE = "https://api.apify.com/v2";

export interface ApifyRunRequest {
  actorId: string;
  input: Record<string, unknown>;
  memoryMb?: number;
  timeoutSeconds?: number;
  build?: string;
}

export interface ApifyRunInfo {
  id: string;
  status: string;
  defaultDatasetId?: string;
  startedAt?: string;
  finishedAt?: string;
}

function token(): string {
  const value = process.env.APIFY_TOKEN;
  if (!value) throw new Error("Missing APIFY_TOKEN server secret");
  return value;
}

async function apifyFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = new URL(`${APIFY_API_BASE}${path}`);
  url.searchParams.set("token", token());

  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Apify API failed: ${response.status} ${body.slice(0, 400)}`);
  }

  return (await response.json()) as T;
}

export async function startActorRun(request: ApifyRunRequest): Promise<ApifyRunInfo> {
  const actorId = encodeURIComponent(request.actorId);
  const params = new URLSearchParams();
  if (request.memoryMb) params.set("memory", String(request.memoryMb));
  if (request.timeoutSeconds) params.set("timeout", String(request.timeoutSeconds));
  if (request.build) params.set("build", request.build);

  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const payload = await apifyFetch<{ data: ApifyRunInfo }>(
    `/acts/${actorId}/runs${suffix}`,
    { method: "POST", body: JSON.stringify(request.input) },
  );
  return payload.data;
}

export async function getActorRun(runId: string): Promise<ApifyRunInfo> {
  const payload = await apifyFetch<{ data: ApifyRunInfo }>(`/actor-runs/${encodeURIComponent(runId)}`);
  return payload.data;
}

export async function getDatasetItems<T = Record<string, unknown>>(
  datasetId: string,
  options: { limit?: number; offset?: number; clean?: boolean } = {},
): Promise<T[]> {
  const url = new URL(`${APIFY_API_BASE}/datasets/${encodeURIComponent(datasetId)}/items`);
  url.searchParams.set("token", token());
  url.searchParams.set("format", "json");
  url.searchParams.set("clean", String(options.clean ?? true));
  url.searchParams.set("limit", String(options.limit ?? 1000));
  url.searchParams.set("offset", String(options.offset ?? 0));

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Apify dataset read failed: ${response.status} ${body.slice(0, 400)}`);
  }
  return (await response.json()) as T[];
}
