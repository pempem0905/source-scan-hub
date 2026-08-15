import type { SearchResult } from "./types";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

export async function braveSearch(
  query: string,
  options: { count?: number; country?: string; searchLang?: string } = {},
): Promise<SearchResult[]> {
  const apiKey = process.env['BRAVE_SEARCH_API_KEY'];
  if (!apiKey) throw new Error("Missing BRAVE_SEARCH_API_KEY server secret");

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.max(1, Math.min(20, options.count ?? 20))));
  // Brave rejects country=VN; "ALL" also matches the Phase 1 definition of the
  // Vietnam market: the whole internet ecosystem serving Vietnam, any TLD.
  url.searchParams.set("country", options.country ?? "ALL");
  url.searchParams.set("search_lang", options.searchLang ?? "vi");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Brave Search failed: ${response.status} ${body.slice(0, 300)}`);
  }

  const payload = (await response.json()) as BraveResponse;
  return (payload.web?.results ?? [])
    .filter((item): item is Required<Pick<BraveWebResult, "title" | "url">> & BraveWebResult =>
      Boolean(item.title && item.url),
    )
    .map((item) => ({
      title: item.title,
      url: item.url,
      description: item.description,
      source: "brave" as const,
      query,
    }));
}
