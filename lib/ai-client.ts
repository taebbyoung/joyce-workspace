import { getAiEnvironment } from "@/db/runtime";

export type AiProvider = "deepseek" | "gemini";
export type AiTask =
  | "default"
  | "work_priority"
  | "sales_brief"
  | "knowledge_distillation"
  | "knowledge_quality_rewrite"
  | "complex_customer_analysis"
  | "complaint_analysis";

export const AI_TASK_MODELS = {
  default: "deepseek-v4-flash",
  work_priority: "deepseek-v4-flash",
  sales_brief: "deepseek-v4-flash",
  knowledge_distillation: "deepseek-v4-pro",
  knowledge_quality_rewrite: "deepseek-v4-pro",
  complex_customer_analysis: "deepseek-v4-pro",
  complaint_analysis: "deepseek-v4-pro",
} as const satisfies Record<AiTask, string>;

export type AiUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type AiResult = {
  content: string;
  model: string;
  provider: AiProvider;
  usage: AiUsage;
  attempts: number;
};

type AiRequest = {
  task: AiTask;
  system: string;
  prompt: string;
  json?: boolean;
  maxTokens?: number;
  maxAttempts?: number;
};

export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly category: "configuration" | "http" | "empty_content" | "invalid_json" | "network",
  ) {
    super(message);
  }
}

function configured(provider: AiProvider) {
  const env = getAiEnvironment();
  return provider === "deepseek" ? Boolean(env.deepseek.apiKey) : Boolean(env.gemini.apiKey);
}

function modelFor(provider: AiProvider, task: AiTask) {
  const env = getAiEnvironment();
  const deepseekReasoning = AI_TASK_MODELS[task].includes("-pro");
  if (provider === "deepseek") {
    return deepseekReasoning ? env.deepseek.reasoningModel : env.deepseek.defaultModel;
  }
  return deepseekReasoning ? env.gemini.reasoningModel : env.gemini.defaultModel;
}

function usage(value: Record<string, unknown> | undefined): AiUsage {
  return {
    prompt_tokens: Number(value?.prompt_tokens ?? 0),
    completion_tokens: Number(value?.completion_tokens ?? 0),
    total_tokens: Number(value?.total_tokens ?? 0),
  };
}

async function invoke(provider: AiProvider, request: AiRequest): Promise<Omit<AiResult, "attempts">> {
  const env = getAiEnvironment();
  const model = modelFor(provider, request.task);
  if (!configured(provider)) {
    throw new AiProviderError(
      provider === "deepseek" ? "DeepSeek API Key 未配置。" : "Gemini API Key 未配置。",
      "configuration",
    );
  }
  if (provider === "deepseek") {
    const endpoint = `${env.deepseek.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(25_000),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.deepseek.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.prompt },
          ],
          ...(request.json ? { response_format: { type: "json_object" } } : {}),
          max_tokens: request.maxTokens ?? 2400,
          temperature: 0.35,
        }),
      });
    } catch {
      throw new AiProviderError("DeepSeek 网络请求失败。", "network");
    }
    if (!response.ok) {
      throw new AiProviderError(`DeepSeek 请求失败（HTTP ${response.status}）。`, "http");
    }
    const result = (await response.json()) as Record<string, unknown>;
    const choices = Array.isArray(result.choices) ? result.choices : [];
    const message = choices[0] as { message?: { content?: unknown } } | undefined;
    const content = String(message?.message?.content ?? "").trim();
    if (!content) throw new AiProviderError("DeepSeek 返回了空内容。", "empty_content");
    return { content, model, provider, usage: usage(result.usage as Record<string, unknown> | undefined) };
  }
  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        signal: AbortSignal.timeout(25_000),
        headers: { "content-type": "application/json", "x-goog-api-key": env.gemini.apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `${request.system}\n\n${request.prompt}` }] }],
          generationConfig: request.json
            ? { responseMimeType: "application/json", maxOutputTokens: request.maxTokens ?? 2400, temperature: 0.35 }
            : { maxOutputTokens: request.maxTokens ?? 2400, temperature: 0.35 },
        }),
      },
    );
  } catch {
    throw new AiProviderError("Gemini 网络请求失败。", "network");
  }
  if (!response.ok) throw new AiProviderError(`Gemini 请求失败（HTTP ${response.status}）。`, "http");
  const result = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: Record<string, unknown> };
  const content = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  if (!content) throw new AiProviderError("Gemini 返回了空内容。", "empty_content");
  return { content, model, provider, usage: usage(result.usageMetadata) };
}

export async function requestAi(request: AiRequest): Promise<AiResult> {
  const env = getAiEnvironment();
  const providers: AiProvider[] = [env.provider];
  if (env.provider === "deepseek" && env.fallbackProvider === "gemini") providers.push("gemini");
  let lastError: unknown;
  for (const provider of providers) {
    for (let attempt = 1; attempt <= (request.maxAttempts ?? 2); attempt += 1) {
      try {
        return { ...(await invoke(provider, request)), attempts: attempt };
      } catch (error) {
        lastError = error;
        if (error instanceof AiProviderError && error.category === "configuration") break;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new AiProviderError("AI 服务暂时不可用。", "network");
}

export async function requestJson<T>(
  request: Omit<AiRequest, "json">,
  validate: (value: unknown) => value is T,
): Promise<{ data: T; meta: AiResult }> {
  let lastError: AiProviderError | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result: AiResult;
    try {
      result = await requestAi({ ...request, json: true, maxAttempts: 1 });
    } catch (error) {
      lastError = error instanceof AiProviderError
        ? error
        : new AiProviderError("AI 请求失败。", "network");
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.content);
    } catch {
      lastError = new AiProviderError("AI 返回的 JSON 无法解析。", "invalid_json");
      continue;
    }
    if (!validate(parsed)) {
      lastError = new AiProviderError("AI 返回的 JSON 字段不完整。", "invalid_json");
      continue;
    }
    return { data: parsed, meta: { ...result, attempts: attempt + 1 } };
  }
  throw lastError ?? new AiProviderError("AI 返回的 JSON 无法解析。", "invalid_json");
}

export function getAiProviderHealth() {
  const env = getAiEnvironment();
  const activeConfigured = configured(env.provider);
  const activeModels = env.provider === "gemini" ? env.gemini : env.deepseek;
  return {
    configured: activeConfigured,
    provider: env.provider,
    default_model: activeModels.defaultModel,
    reasoning_model: activeModels.reasoningModel,
    deepseek: env.provider === "deepseek" ? "当前启用" : configured("deepseek") ? "备用" : "未启用",
  };
}
