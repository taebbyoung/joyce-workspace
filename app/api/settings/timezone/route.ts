import { ensureWorkspace, getD1 } from "@/db/runtime";
import {
  DEFAULT_TIMEZONE_PREFERENCE,
  isValidIanaTimezone,
  normalizeTimezonePreference,
} from "@/lib/workspace-time";

export const runtime = "edge";

const SETTING_KEY = "workspace_timezone_preference";

async function readPreference() {
  const row = await getD1()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(SETTING_KEY)
    .first<{ value: string }>();
  if (!row?.value) return DEFAULT_TIMEZONE_PREFERENCE;
  try {
    return normalizeTimezonePreference(JSON.parse(row.value));
  } catch {
    return DEFAULT_TIMEZONE_PREFERENCE;
  }
}

export async function GET() {
  try {
    await ensureWorkspace();
    return Response.json({ preference: await readPreference() }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "时区设置读取失败。" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const body = await request.json() as Record<string, unknown>;
    const preference = normalizeTimezonePreference(body.preference);
    if (preference.mode === "manual" && !isValidIanaTimezone(preference.timezone)) {
      return Response.json({ error: "请选择有效的 IANA 时区。" }, { status: 400 });
    }
    await getD1()
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(SETTING_KEY, JSON.stringify(preference), new Date().toISOString())
      .run();
    return Response.json({ preference });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "时区设置保存失败，请重试" },
      { status: 500 },
    );
  }
}
