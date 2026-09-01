import { ensureWorkspace, getD1 } from "@/db/runtime";
import { normalizeCustomerGrade } from "@/lib/customer-priority";

export const runtime = "edge";

const FOLLOW_UP_INITIAL_LIMIT = 6;
const FOLLOW_UP_MAX_PAGE_SIZE = 20;

function text(value: unknown, max = 5000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function nullable(value: unknown, max = 5000) {
  return text(value, max) || null;
}

function errorResponse(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function dateOnly(value: unknown) {
  const candidate = text(value, 10);
  if (!candidate) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return undefined;
  const [year, month, day] = candidate.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? candidate
    : undefined;
}

function pageNumber(value: string | null, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}

async function audit(
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
) {
  await getD1()
    .prepare(
      `INSERT INTO audit_logs
        (id, action, entity_type, entity_id, before_data, after_data, source)
       VALUES (?, ?, ?, ?, ?, ?, 'user')`,
    )
    .bind(
      crypto.randomUUID(),
      action,
      entityType,
      entityId,
      JSON.stringify(before ?? null),
      JSON.stringify(after ?? null),
    )
    .run();
}

async function customerSnapshot(customerId: string) {
  const db = getD1();
  const [customer, contacts, followUps, followUpCount] = await Promise.all([
    db
      .prepare("SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL")
      .bind(customerId)
      .first<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT * FROM contacts
         WHERE customer_id = ? AND deleted_at IS NULL
         ORDER BY is_primary DESC, created_at`,
      )
      .bind(customerId)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT * FROM customer_follow_ups
         WHERE customer_id = ?
         ORDER BY follow_up_at DESC, created_at DESC LIMIT ?`,
      )
      .bind(customerId, FOLLOW_UP_INITIAL_LIMIT)
      .all<Record<string, unknown>>(),
    db.prepare("SELECT COUNT(*) AS count FROM customer_follow_ups WHERE customer_id = ?")
      .bind(customerId).first<{ count: number }>(),
  ]);
  return {
    customer,
    contacts: contacts.results,
    followUps: followUps.results,
    followUpCount: Number(followUpCount?.count ?? 0),
  };
}

async function recomputeLastFollow(
  customerId: string,
  now: string,
) {
  const db = getD1();
  const latest = await db
    .prepare(
      `SELECT MAX(follow_up_at) AS follow_up_at
       FROM customer_follow_ups WHERE customer_id = ?`,
    )
    .bind(customerId)
    .first<{ follow_up_at: string | null }>();
  const lastFollow = String(latest?.follow_up_at || "").slice(0, 10) || null;
  await db
    .prepare(
      `UPDATE customers
       SET last_follow = ?, last_contact_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(lastFollow, lastFollow, now, customerId)
    .run();
  return lastFollow;
}

async function recomputeNextFollow(customerId: string, now: string) {
  const db = getD1();
  const latest = await db
    .prepare(
      `SELECT next_follow_up_date
       FROM customer_follow_ups
       WHERE customer_id = ?
       ORDER BY follow_up_at DESC, created_at DESC
       LIMIT 1`,
    )
    .bind(customerId)
    .first<{ next_follow_up_date: string | null }>();
  const nextFollow = String(latest?.next_follow_up_date || "").slice(0, 10) || null;
  await db
    .prepare("UPDATE customers SET next_follow = ?, updated_at = ? WHERE id = ?")
    .bind(nextFollow, now, customerId)
    .run();
  return nextFollow;
}

export async function GET(request: Request) {
  try {
    await ensureWorkspace();
    const url = new URL(request.url);
    const customerId = text(url.searchParams.get("customerId"), 100);
    if (!customerId) return errorResponse("缺少客户 ID。");
    const limit = pageNumber(url.searchParams.get("limit"), FOLLOW_UP_INITIAL_LIMIT, FOLLOW_UP_MAX_PAGE_SIZE) || FOLLOW_UP_INITIAL_LIMIT;
    const offset = pageNumber(url.searchParams.get("offset"), 0, 10_000);
    const db = getD1();
    const [followUps, count] = await Promise.all([
      db.prepare(
        `SELECT * FROM customer_follow_ups WHERE customer_id = ?
         ORDER BY follow_up_at DESC, created_at DESC LIMIT ? OFFSET ?`,
      ).bind(customerId, limit, offset).all<Record<string, unknown>>(),
      db.prepare("SELECT COUNT(*) AS count FROM customer_follow_ups WHERE customer_id = ?")
        .bind(customerId).first<{ count: number }>(),
    ]);
    const total = Number(count?.count ?? 0);
    const nextOffset = offset + followUps.results.length;
    return Response.json({
      ok: true,
      followUps: followUps.results,
      total,
      hasMore: nextOffset < total,
      nextOffset,
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "跟进记录读取失败。", 500);
  }
}

async function success(customerId: string, extra: Record<string, unknown> = {}) {
  return Response.json({
    ok: true,
    customerId,
    ...extra,
    snapshot: await customerSnapshot(customerId),
  });
}

type CustomerDeleteDependencies = {
  orders: number;
  afterSales: number;
  tasks: number;
  timelineEvents: number;
};

const customerDeleteGuard = `
  AND NOT EXISTS (SELECT 1 FROM orders WHERE customer_id = ?)
  AND NOT EXISTS (SELECT 1 FROM after_sales_cases WHERE customer_id = ?)
  AND NOT EXISTS (SELECT 1 FROM tasks WHERE customer_id = ?)
  AND NOT EXISTS (SELECT 1 FROM timeline_events WHERE customer_id = ?)`;

function deleteGuardBindings(customerId: string) {
  return [customerId, customerId, customerId, customerId];
}

function countFromResult(result: { results?: unknown[] } | undefined) {
  const row = result?.results?.[0] as { count?: number | string } | undefined;
  return Number(row?.count ?? 0);
}

async function customerDeleteDependencies(customerId: string): Promise<CustomerDeleteDependencies> {
  const db = getD1();
  const results = await db.batch([
    db.prepare("SELECT COUNT(*) AS count FROM orders WHERE customer_id = ?").bind(customerId),
    db.prepare("SELECT COUNT(*) AS count FROM after_sales_cases WHERE customer_id = ?").bind(customerId),
    db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE customer_id = ?").bind(customerId),
    db.prepare("SELECT COUNT(*) AS count FROM timeline_events WHERE customer_id = ?").bind(customerId),
  ]);
  return {
    orders: countFromResult(results[0]),
    afterSales: countFromResult(results[1]),
    tasks: countFromResult(results[2]),
    timelineEvents: countFromResult(results[3]),
  };
}

function customerDeleteBlocked(dependencies: CustomerDeleteDependencies) {
  return Object.values(dependencies).some((count) => count > 0);
}

function customerDeleteMessage(dependencies: CustomerDeleteDependencies) {
  const counts = [
    ["关联订单", dependencies.orders],
    ["关联售后", dependencies.afterSales],
    ["关联工作", dependencies.tasks],
    ["业务时间线", dependencies.timelineEvents],
  ].filter(([, count]) => count > 0).map(([label, count]) => `${label}：${count}`);
  return counts.length
    ? `无法删除该客户。该客户存在关联的正式业务记录，请先处理关联关系。${counts.join("；")}`
    : "该客户可以删除。";
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    const action = text(payload.action, 40);
    const customerId = text(payload.customerId, 100);
    if (!customerId) return errorResponse("缺少客户 ID。");

    const db = getD1();
    const now = new Date().toISOString();
    const customer = await db
      .prepare("SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL")
      .bind(customerId)
      .first<Record<string, unknown>>();
    if (!customer) return errorResponse("客户不存在。", 404);

    if (action === "check_delete") {
      const dependencies = await customerDeleteDependencies(customerId);
      return Response.json({
        ok: true,
        customerId,
        eligible: !customerDeleteBlocked(dependencies),
        dependencies,
        message: customerDeleteMessage(dependencies),
      });
    }

    if (action === "delete_customer") {
      const dependencies = await customerDeleteDependencies(customerId);
      if (customerDeleteBlocked(dependencies)) {
        return Response.json({
          error: customerDeleteMessage(dependencies),
          dependencies,
        }, { status: 409 });
      }

      const auditId = crypto.randomUUID();
      const statements = [
        db.prepare(`DELETE FROM contacts WHERE customer_id = ? ${customerDeleteGuard}`)
          .bind(customerId, ...deleteGuardBindings(customerId)),
        db.prepare(`DELETE FROM customer_follow_ups WHERE customer_id = ? ${customerDeleteGuard}`)
          .bind(customerId, ...deleteGuardBindings(customerId)),
        db.prepare(`DELETE FROM customer_memory WHERE customer_id = ? ${customerDeleteGuard}`)
          .bind(customerId, ...deleteGuardBindings(customerId)),
        db.prepare(`DELETE FROM customer_custom_fields WHERE customer_id = ? ${customerDeleteGuard}`)
          .bind(customerId, ...deleteGuardBindings(customerId)),
        db.prepare(`DELETE FROM customer_status_history WHERE customer_id = ? ${customerDeleteGuard}`)
          .bind(customerId, ...deleteGuardBindings(customerId)),
        db.prepare(`DELETE FROM legacy_records
          WHERE target_type = 'customer' AND target_id = ? ${customerDeleteGuard}`)
          .bind(customerId, ...deleteGuardBindings(customerId)),
        db.prepare(`INSERT INTO audit_logs
          (id, action, entity_type, entity_id, before_data, after_data, source)
          SELECT ?, 'customer_deleted', 'customer', ?, ?, NULL, 'user'
          WHERE EXISTS (SELECT 1 FROM customers WHERE id = ? AND deleted_at IS NULL)
          ${customerDeleteGuard}`)
          .bind(
            auditId,
            customerId,
            JSON.stringify(customer),
            customerId,
            ...deleteGuardBindings(customerId),
          ),
        db.prepare(`DELETE FROM customers
          WHERE id = ? AND deleted_at IS NULL ${customerDeleteGuard}`)
          .bind(customerId, ...deleteGuardBindings(customerId)),
      ];
      const results = await db.batch(statements);
      const customerDeleteResult = results[results.length - 1] as {
        meta?: { changes?: number };
      } | undefined;
      if (Number(customerDeleteResult?.meta?.changes ?? 0) !== 1) {
        const latestDependencies = await customerDeleteDependencies(customerId);
        if (customerDeleteBlocked(latestDependencies)) {
          return Response.json({
            error: customerDeleteMessage(latestDependencies),
            dependencies: latestDependencies,
          }, { status: 409 });
        }
        return errorResponse("客户删除失败，请稍后重试。", 409);
      }
      return Response.json({ ok: true, customerId, deleted: true });
    }

    if (action === "update_profile") {
      const company = text(payload.company, 300);
      if (!company) return errorResponse("公司名称不能为空。");
      const customerCode = text(payload.customerCode, 40).toUpperCase();
      const lifecycle = text(payload.lifecycle, 40);
      if (!["existing", "potential_customer", "potential_lead"].includes(lifecycle)) {
        return errorResponse("客户生命周期无效。");
      }
      const preservedCode = String(customer.customer_code || "").trim().toUpperCase();
      const nextCustomerCode = customerCode ||
        (lifecycle === "existing" ? "" : preservedCode);
      if (lifecycle === "existing" && !nextCustomerCode) {
        return errorResponse("老客户必须填写客户代码。");
      }
      if (nextCustomerCode && (customerCode || lifecycle === "existing")) {
        const duplicate = await db
          .prepare(
            `SELECT id FROM customers
             WHERE upper(trim(customer_code)) = ? AND id <> ? AND deleted_at IS NULL
             LIMIT 1`,
          )
          .bind(nextCustomerCode, customerId)
          .first<{ id: string }>();
        if (duplicate) {
          return errorResponse(`客户代码 ${nextCustomerCode} 已存在。`, 409);
        }
      }
      const lifecycleChanged = lifecycle !== String(customer.lifecycle || "");
      await db
        .prepare(
          `UPDATE customers SET
            customer_code = ?, company = ?, lifecycle = ?,
            country = ?, city = ?, website = ?, address = ?, customer_type = ?,
            source = ?, next_action = ?, strategy = ?, profile = ?, company_background_notes = ?,
            grade = CASE WHEN ? = 1 THEN NULL ELSE grade END,
            purchase_intent = CASE WHEN ? = 1 THEN NULL ELSE purchase_intent END,
            purchase_ability = CASE WHEN ? = 1 THEN NULL ELSE purchase_ability END,
            rating_reason = CASE WHEN ? = 1 THEN NULL ELSE rating_reason END,
            last_reviewed_at = CASE WHEN ? = 1 THEN NULL ELSE last_reviewed_at END,
            next_follow = CASE WHEN ? = 1 THEN NULL ELSE next_follow END,
            updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          nextCustomerCode || null,
          company,
          lifecycle,
          nullable(payload.country, 100),
          nullable(payload.city, 100),
          nullable(payload.website, 500),
          nullable(payload.address, 1000),
          nullable(payload.customerType, 100),
          nullable(payload.source, 300),
          nullable(payload.nextAction),
          nullable(payload.strategy),
          nullable(payload.profile),
          nullable(payload.companyBackgroundNotes, 20000),
          lifecycleChanged ? 1 : 0,
          lifecycleChanged ? 1 : 0,
          lifecycleChanged ? 1 : 0,
          lifecycleChanged ? 1 : 0,
          lifecycleChanged ? 1 : 0,
          lifecycleChanged ? 1 : 0,
          now,
          customerId,
        )
        .run();
      await audit("customer_updated", "customer", customerId, customer, payload);
      return success(customerId);
    }

    if (action === "update_rating") {
      const lifecycle = String(customer.lifecycle || "");
      if (!["potential_customer", "existing"].includes(lifecycle)) {
        return errorResponse("潜在线索不参与客户评级。", 409);
      }
      const grade = normalizeCustomerGrade(lifecycle, payload.grade) || null;
      const ratingReason = nullable(payload.ratingReason, 3000);
      if (lifecycle === "potential_customer") {
        const purchaseIntent = ["high", "medium", "low", "unconfirmed"].includes(
          text(payload.purchaseIntent, 30),
        )
          ? text(payload.purchaseIntent, 30)
          : null;
        const purchaseAbility = ["strong", "limited", "weak", "unconfirmed"].includes(
          text(payload.purchaseAbility, 30),
        )
          ? text(payload.purchaseAbility, 30)
          : null;
        const nextFollow = dateOnly(payload.nextFollow);
        if (nextFollow === undefined) return errorResponse("下次跟进日期无效。");
        const gradeChanged = String(customer.grade || "") !== String(grade || "");
        const ratingReasonChanged =
          String(customer.rating_reason || "") !== String(ratingReason || "");
        const reviewChanged = gradeChanged || ratingReasonChanged;
        await db
          .prepare(
            `UPDATE customers SET
              grade = ?, purchase_intent = ?, purchase_ability = ?, rating_reason = ?,
              next_follow = ?, last_reviewed_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .bind(
            grade,
            purchaseIntent,
            purchaseAbility,
            ratingReason,
            nextFollow,
            reviewChanged ? now : customer.last_reviewed_at || null,
            now,
            customerId,
          )
          .run();
      } else {
        const gradeChanged = String(customer.grade || "") !== String(grade || "");
        const ratingReasonChanged =
          String(customer.rating_reason || "") !== String(ratingReason || "");
        const reviewChanged = gradeChanged || ratingReasonChanged;
        await db
          .prepare(
            `UPDATE customers SET
              grade = ?, rating_reason = ?, last_reviewed_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .bind(
            grade,
            ratingReason,
            reviewChanged ? now : customer.last_reviewed_at || null,
            now,
            customerId,
          )
          .run();
      }
      await audit("customer_rating_updated", "customer", customerId, customer, payload);
      return success(customerId);
    }

    if (action === "record_follow_up") {
      const followUpDate = dateOnly(
        payload.followUpDate ?? String(payload.followUpAt ?? "").slice(0, 10),
      );
      const content = nullable(payload.content, 20000);
      const nextFollowUpDate = dateOnly(payload.nextFollowUpDate);
      if (!followUpDate) return errorResponse("跟进日期无效。");
      if (!content) return errorResponse("请填写跟进内容。");
      if (nextFollowUpDate === undefined) return errorResponse("下次跟进日期无效。");
      const followUpId = crypto.randomUUID();
      const statements = [
        db.prepare(`INSERT INTO customer_follow_ups
          (id, customer_id, follow_up_at, content, next_follow_up_date, channel, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(followUpId, customerId, followUpDate, content, nextFollowUpDate || null, nullable(payload.channel, 40), now, now),
      ];
      await db.batch(statements);
      await recomputeLastFollow(customerId, now);
      await recomputeNextFollow(customerId, now);
      const followUp = await db
        .prepare("SELECT * FROM customer_follow_ups WHERE id = ? AND customer_id = ?")
        .bind(followUpId, customerId)
        .first<Record<string, unknown>>();
      await audit("customer_follow_up_recorded", "customer_follow_up", followUpId, null, { customerId, followUpDate, content, nextFollowUpDate });
      return success(customerId, { followUpId, followUp });
    }

    if (action === "update_follow_up") {
      const followUpId = text(payload.followUpId, 100);
      const followUpDate = dateOnly(payload.followUpDate);
      const content = nullable(payload.content, 20000);
      const nextFollowUpDate = dateOnly(payload.nextFollowUpDate);
      if (!followUpId) return errorResponse("缺少跟进记录 ID。");
      if (!followUpDate) return errorResponse("跟进日期无效。");
      if (!content) return errorResponse("请填写跟进内容。");
      if (nextFollowUpDate === undefined) return errorResponse("下次跟进日期无效。");
      const before = await db
        .prepare("SELECT * FROM customer_follow_ups WHERE id = ? AND customer_id = ?")
        .bind(followUpId, customerId)
        .first<Record<string, unknown>>();
      if (!before) return errorResponse("跟进记录不存在。", 404);
      await db
        .prepare(
          `UPDATE customer_follow_ups
           SET follow_up_at = ?, content = ?, next_follow_up_date = ?, updated_at = ?
           WHERE id = ? AND customer_id = ?`,
        )
        .bind(followUpDate, content, nextFollowUpDate || null, now, followUpId, customerId)
        .run();
      await recomputeLastFollow(customerId, now);
      await recomputeNextFollow(customerId, now);
      const followUp = await db
        .prepare("SELECT * FROM customer_follow_ups WHERE id = ? AND customer_id = ?")
        .bind(followUpId, customerId)
        .first<Record<string, unknown>>();
      await audit("customer_follow_up_updated", "customer_follow_up", followUpId, before, {
        followUpDate,
        content,
        nextFollowUpDate,
      });
      return success(customerId, { followUp });
    }

    if (action === "delete_follow_up") {
      const followUpId = text(payload.followUpId, 100);
      if (!followUpId) return errorResponse("缺少跟进记录 ID。");
      const before = await db
        .prepare("SELECT * FROM customer_follow_ups WHERE id = ? AND customer_id = ?")
        .bind(followUpId, customerId)
        .first<Record<string, unknown>>();
      if (!before) return errorResponse("跟进记录不存在。", 404);
      await db
        .prepare("DELETE FROM customer_follow_ups WHERE id = ? AND customer_id = ?")
        .bind(followUpId, customerId)
        .run();
      await recomputeLastFollow(customerId, now);
      await recomputeNextFollow(customerId, now);
      await audit("customer_follow_up_deleted", "customer_follow_up", followUpId, before, null);
      return success(customerId, { followUpId });
    }

    if (action === "save_contact") {
      const contactId = text(payload.contactId, 100) || crypto.randomUUID();
      const before = await db
        .prepare("SELECT * FROM contacts WHERE id = ? AND customer_id = ?")
        .bind(contactId, customerId)
        .first<Record<string, unknown>>();
      const isPrimary = payload.isPrimary === true ? 1 : 0;
      const statements = [];
      if (isPrimary) {
        statements.push(
          db
            .prepare(
              "UPDATE contacts SET is_primary = 0, updated_at = ? WHERE customer_id = ?",
            )
            .bind(now, customerId),
        );
      }
      statements.push(
        db
          .prepare(
            `INSERT INTO contacts
              (id, customer_id, name, position, role, email, phone, whatsapp, wechat,
               linkedin, notes, is_primary, deleted_at, legacy_metadata,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}', ?, ?)
             ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              position = excluded.position,
              role = excluded.role,
              email = excluded.email,
              phone = excluded.phone,
              whatsapp = excluded.whatsapp,
              wechat = excluded.wechat,
              linkedin = excluded.linkedin,
              notes = excluded.notes,
              is_primary = excluded.is_primary,
              deleted_at = NULL,
              updated_at = excluded.updated_at`,
          )
          .bind(
            contactId,
            customerId,
            nullable(payload.name, 300),
            nullable(payload.position, 300),
            nullable(payload.position, 300),
            nullable(payload.email, 300),
            nullable(payload.phone, 100),
            nullable(payload.whatsapp, 100),
            nullable(payload.wechat, 100),
            nullable(payload.linkedin, 500),
            nullable(payload.notes, 5000),
            isPrimary,
            now,
            now,
          ),
      );
      await db.batch(statements);
      await audit("contact_saved", "contact", contactId, before, payload);
      return success(customerId, { contactId });
    }

    if (action === "archive_contact") {
      const contactId = text(payload.contactId, 100);
      if (!contactId) return errorResponse("缺少联系人 ID。");
      const before = await db
        .prepare("SELECT * FROM contacts WHERE id = ? AND customer_id = ?")
        .bind(contactId, customerId)
        .first<Record<string, unknown>>();
      await db
        .prepare(
          `UPDATE contacts
           SET deleted_at = ?, is_primary = 0, updated_at = ?
           WHERE id = ? AND customer_id = ?`,
        )
        .bind(now, now, contactId, customerId)
        .run();
      await audit("contact_archived", "contact", contactId, before, {
        archivedAt: now,
      });
      return success(customerId, { contactId });
    }

    return errorResponse("未知客户操作。");
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "客户保存失败。",
      500,
    );
  }
}
