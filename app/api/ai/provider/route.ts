import { getAiProviderHealth, requestAi } from "@/lib/ai-client";

export const runtime = "edge";

export async function GET() {
  return Response.json(getAiProviderHealth(), {
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    if (payload.action !== "test_provider") {
      return Response.json({ ok: false, error: "需要管理员明确确认后才会测试 AI Provider。" }, { status: 400 });
    }
    const result = await requestAi({
      task: "default",
      system: "Reply with one short Chinese greeting.",
      prompt: "测试连接。",
      maxTokens: 40,
    });
    return Response.json({ ok: true, provider: result.provider, model: result.model, usage: result.usage });
  } catch {
    return Response.json({ ok: false, error: "AI Provider 测试失败，请检查服务器端配置。" }, { status: 502 });
  }
}
