import { ensureWorkspace, getD1 } from "@/db/runtime";
import {
  saveManualWorkOrder,
  type WorkPriorityKind,
  type WorkPrioritySection,
} from "@/lib/work-priority";

export const runtime = "edge";

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    const kind = String(payload.kind ?? "") as WorkPriorityKind;
    const section = String(payload.section ?? "") as WorkPrioritySection;
    const ids = Array.isArray(payload.ids)
      ? payload.ids.map(String).slice(0, 300)
      : [];
    if (!["tasks", "projects"].includes(kind)) {
      return Response.json({ error: "排序类型无效。" }, { status: 400 });
    }
    if (!["today", "upcoming", "projects"].includes(section)) {
      return Response.json({ error: "排序区域无效。" }, { status: 400 });
    }
    await saveManualWorkOrder(getD1(), kind, section, ids);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "排序暂时无法保存。",
      },
      { status: 409 },
    );
  }
}
