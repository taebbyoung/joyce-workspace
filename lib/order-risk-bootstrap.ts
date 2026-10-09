import type { getD1 } from "@/db/runtime";
import { seedExistingOrderRisks } from "./order-risk";

type WorkspaceDatabase = ReturnType<typeof getD1>;

export async function ensureOrderRiskSeeded(db: WorkspaceDatabase) {
  const seeded = await db
    .prepare("SELECT value FROM settings WHERE key = 'order_final_risks_seeded'")
    .first<{ value: string }>();
  if (seeded) return;

  const orderIds = await db
    .prepare("SELECT id FROM orders WHERE deleted_at IS NULL")
    .all<{ id: string }>();
  await seedExistingOrderRisks(db);
  await db
    .prepare(
      `INSERT OR REPLACE INTO settings (key, value, updated_at)
       VALUES ('order_final_risks_seeded', ?, ?)`,
    )
    .bind(String(orderIds.results.length), new Date().toISOString())
    .run();
}
