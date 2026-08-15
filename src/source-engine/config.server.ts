export type PowerMode = "ECO" | "AUTO" | "MAX_SPEED";

export interface SourceEngineRuntimeConfig {
  phase: 1;
  powerMode: PowerMode;
  globalConcurrency: number;
  perDomainConcurrency: number;
  retryLimit: number;
  requestTimeoutMs: number;
  braveRequestsPerSecond: number;
  apifyMaxActorRuns: number;
  dailyBudgetUsd: number;
  projectBudgetUsd: number;
}

const DEFAULT_CONFIG: SourceEngineRuntimeConfig = {
  phase: 1,
  powerMode: "AUTO",
  globalConcurrency: 64,
  perDomainConcurrency: 2,
  retryLimit: 3,
  requestTimeoutMs: 15_000,
  braveRequestsPerSecond: 5,
  apifyMaxActorRuns: 32,
  dailyBudgetUsd: 1,
  projectBudgetUsd: 50,
};

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function moneyEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function getSourceEngineRuntimeConfig(): SourceEngineRuntimeConfig {
  const mode = (process.env['SOURCE_ENGINE_POWER_MODE'] ?? DEFAULT_CONFIG.powerMode).toUpperCase();
  const powerMode: PowerMode = mode === "ECO" || mode === "MAX_SPEED" ? mode : "AUTO";

  const modeConcurrency = powerMode === "MAX_SPEED" ? 256 : powerMode === "ECO" ? 16 : 64;

  return {
    ...DEFAULT_CONFIG,
    powerMode,
    globalConcurrency: intEnv("SOURCE_ENGINE_GLOBAL_CONCURRENCY", modeConcurrency, 1, 512),
    perDomainConcurrency: intEnv("SOURCE_ENGINE_PER_DOMAIN_CONCURRENCY", 2, 1, 8),
    retryLimit: intEnv("SOURCE_ENGINE_RETRY_LIMIT", 3, 0, 8),
    requestTimeoutMs: intEnv("SOURCE_ENGINE_TIMEOUT_MS", 15_000, 2_000, 60_000),
    braveRequestsPerSecond: intEnv("BRAVE_REQUESTS_PER_SECOND", 5, 1, 50),
    apifyMaxActorRuns: intEnv("APIFY_MAX_ACTOR_RUNS", 32, 1, 32),
    dailyBudgetUsd: moneyEnv("SOURCE_ENGINE_DAILY_BUDGET_USD", 1),
    projectBudgetUsd: moneyEnv("SOURCE_ENGINE_PROJECT_BUDGET_USD", 50),
  };
}

export function getRequiredServerSecrets() {
  return {
    apifyTokenPresent: Boolean(process.env['APIFY_TOKEN']),
    braveSearchKeyPresent: Boolean(process.env['BRAVE_SEARCH_API_KEY']),
  };
}
