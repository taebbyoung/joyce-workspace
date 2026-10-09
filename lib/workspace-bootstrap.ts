export const WORKSPACE_BOOTSTRAP_TIMEOUT_MS = 12_000;

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
  let timedOut = false;
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const promise = (async () => {
    try {
      const response = await fetchImpl(path, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (timedOut) throw new WorkspaceBootstrapTimeoutError();

      const result = await response.json();
      if (timedOut) throw new WorkspaceBootstrapTimeoutError();
      if (!response.ok) {
        throw new Error(result.error || "工作区加载失败。");
      }
      return result as T;
    } catch (error) {
      if (timedOut) throw new WorkspaceBootstrapTimeoutError();
      throw error;
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  })();

  return {
    abort: () => controller.abort(),
    promise,
    signal: controller.signal,
  };
}
