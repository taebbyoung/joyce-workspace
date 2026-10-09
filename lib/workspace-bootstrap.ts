import type { HomeBootstrapData } from "./home-bootstrap.ts";

export const WORKSPACE_BOOTSTRAP_TIMEOUT_MS = 20_000;

export class WorkspaceBootstrapTimeoutError extends Error {
  constructor() {
    super("工作台加载超时。");
    this.name = "WorkspaceBootstrapTimeoutError";
  }
}

type WorkspaceBootstrapRequest<T> = {
  abort: () => void;
  promise: Promise<T>;
  signal: AbortSignal;
};

export function createWorkspaceBootstrapRequest<T>(
  path: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = WORKSPACE_BOOTSTRAP_TIMEOUT_MS,
): WorkspaceBootstrapRequest<T> {
  const controller = new AbortController();
  let stopped = false;
  let rejectInterruption!: (error: Error) => void;
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectInterruption = reject;
  });
  const timeoutId = globalThis.setTimeout(() => {
    if (stopped) return;
    stopped = true;
    rejectInterruption(new WorkspaceBootstrapTimeoutError());
    controller.abort();
  }, timeoutMs);

  const request = (async () => {
    const response = await fetchImpl(path, {
      cache: "no-store",
      signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result?.error || "工作区加载失败。");
    }
    return result as T;
  })();
  const promise = Promise.race([request, interruption]).finally(() => {
    stopped = true;
    globalThis.clearTimeout(timeoutId);
  });

  return {
    abort: () => {
      if (stopped) return;
      stopped = true;
      const error = new Error("Request aborted");
      error.name = "AbortError";
      rejectInterruption(error);
      controller.abort();
    },
    promise,
    signal: controller.signal,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isValidHomeBootstrapResponse(value: unknown): value is HomeBootstrapData {
  if (!isRecord(value) || !isRecord(value.metrics)) return false;
  const metricKeys = [
    "currentYearSales", "currentYearVehicleSales", "currentYearAccessorySales",
    "activeOrderValue", "existingCustomers", "aPotentialCustomers",
    "potentialLeads", "currencyReviewCount",
  ];
  return typeof value.generatedAt === "string" &&
    metricKeys.every((key) => typeof value.metrics[key] === "number") &&
    Array.isArray(value.salesTrend) && value.salesTrend.every(isRecord) &&
    Array.isArray(value.contribution) && value.contribution.every(isRecord) &&
    Array.isArray(value.todayTasks) && value.todayTasks.every(isRecord) &&
    typeof value.todayTaskTotal === "number" &&
    Array.isArray(value.attention) && value.attention.every(isRecord);
}
