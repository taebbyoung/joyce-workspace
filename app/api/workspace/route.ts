import { ensureWorkspace, getD1 } from "@/db/runtime";
import { seedExistingOrderRisks } from "@/lib/order-risk";
import {
  buildAttributedCustomerContribution,
  buildAttributedSalesTrend,
  getSalesBusinessDate,
  sumAttributedVehicleSales,
} from "@/lib/order-sales-attribution";
import { buildCustomerFollowUpAttention } from "@/lib/customer-attention";

export const runtime = "edge";

function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function workspacePostResponse(
  body: Record<string, unknown>,
  requestStartedAt: number,
  databaseStartedAt: number,
  status = 200,
) {
  const databaseDuration = Math.max(0, performance.now() - databaseStartedAt);
  const totalDuration = Math.max(0, performance.now() - requestStartedAt);
  return Response.json(body, {
    status,
    headers: {
      "server-timing": `db;dur=${databaseDuration.toFixed(1)}, total;dur=${totalDuration.toFixed(1)}`,
    },
  });
}

function asText(value: unknown, max = 5000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function asNullableText(value: unknown, max = 5000) {
  const text = asText(value, max);
  return text || null;
}

type NewCustomerContact = {
  name: string;
  position: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  wechat: string | null;
  linkedin: string | null;
  notes: string | null;
  isPrimary: boolean;
};

function parseNewCustomerContacts(value: unknown):
  | { contacts: NewCustomerContact[] }
  | { error: string } {
  if (!value) return { contacts: [] };
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return { error: "联系人数据格式无效。" };
  }
  if (!Array.isArray(parsed)) return { error: "联系人数据格式无效。" };

  let primaryAssigned = false;
  const contacts: NewCustomerContact[] = [];
  for (const item of parsed.slice(0, 20)) {
    if (!item || typeof item !== "object") return { error: "联系人数据格式无效。" };
    const row = item as Record<string, unknown>;
    const name = asText(row.name, 300);
    if (!name) return { error: "请填写联系人姓名。" };
    const isPrimary = row.isPrimary === true && !primaryAssigned;
    if (isPrimary) primaryAssigned = true;
    contacts.push({
      name,
      position: asNullableText(row.position, 300),
      email: asNullableText(row.email, 300),
      phone: asNullableText(row.phone, 100),
      whatsapp: asNullableText(row.whatsapp, 100),
      wechat: asNullableText(row.wechat, 100),
      linkedin: asNullableText(row.linkedin, 500),
      notes: asNullableText(row.notes, 5000),
      isPrimary,
    });
  }
  return { contacts };
}

async function all<T>(sql: string, ...bindings: unknown[]) {
  const result = await getD1().prepare(sql).bind(...bindings).all<T>();
  return result.results;
}

export async function GET() {
  try {
    await ensureWorkspace();
    const db = getD1();
    const today = getSalesBusinessDate();
    const year = today.slice(0, 4);
    const seeded = await db
      .prepare("SELECT value FROM settings WHERE key = 'order_final_risks_seeded'")
      .first<{ value: string }>();
    if (!seeded) {
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

    const [
      metrics,
      accessorySales,
      customerCounts,
      salesAttributionOrders,
      tasks,
      customers,
      contacts,
      orders,
      orderItems,
      orderPayments,
      orderRisks,
      orderStatusHistory,
      projects,
      sourceDocuments,
      knowledge,
      playbook,
      content,
      migrationCounts,
      reviewCounts,
    ] = await Promise.all([
      db
        .prepare(
          `SELECT
            COALESCE(SUM(CASE WHEN currency_status = 'confirmed' AND deleted_at IS NULL AND COALESCE(order_status, 'active') <> 'completed' THEN cny_amount ELSE 0 END), 0) AS active_order_value,
            SUM(CASE WHEN currency_status = 'needs_confirmation' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS currency_review_count
           FROM orders`,
        )
        .first<Record<string, number>>(),
      all<Record<string, unknown>>(
        "SELECT * FROM accessory_sales_totals ORDER BY sales_year DESC",
      ),
      db
        .prepare(
          `SELECT
            SUM(CASE WHEN lifecycle = 'existing' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS existing_count,
            SUM(CASE WHEN lifecycle = 'potential_customer' AND grade = '1' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS a_potential_count,
            SUM(CASE WHEN lifecycle = 'potential_lead' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS lead_count
           FROM customers`,
        )
        .first<Record<string, number>>(),
      all<Record<string, unknown>>(
        `SELECT customer_code, expected_shipping_date, shipment_status,
                balance_received_date, cny_amount, currency_status, deleted_at
         FROM orders
         WHERE currency_status = 'confirmed' AND deleted_at IS NULL`,
      ),
      all<Record<string, unknown>>(
        `SELECT * FROM tasks
         WHERE deleted_at IS NOT NULL
            OR (completed_at IS NULL
                AND status NOT IN ('completed', '已完成', 'Completed'))
         ORDER BY
          CASE WHEN deleted_at IS NULL THEN 1 ELSE 2 END,
          CASE WHEN COALESCE(work_sort_order, 0) > 0 THEN 0 ELSE 1 END,
          work_sort_order,
          CASE status WHEN '待处理' THEN 1 WHEN '进行中' THEN 2 ELSE 3 END,
          COALESCE(reminder_date, next_action_date, due_date, '9999-12-31'),
          updated_at DESC LIMIT 300`,
      ),
      all<Record<string, unknown>>(
        `SELECT c.*,
          COALESCE(SUM(COALESCE(o.cny_amount, 0)), 0) AS total_sales_cny,
          COUNT(o.id) AS order_count,
          MAX(COALESCE(NULLIF(o.order_date, ''), o.created_at)) AS latest_order_date
         FROM customers c
         LEFT JOIN orders o ON o.customer_id = c.id AND o.deleted_at IS NULL
         WHERE c.deleted_at IS NULL
         GROUP BY c.id
         ORDER BY
          CASE c.lifecycle WHEN 'existing' THEN 1 WHEN 'potential_customer' THEN 2 ELSE 3 END,
          c.customer_code, c.company
         LIMIT 300`,
      ),
      all<Record<string, unknown>>(
        `SELECT * FROM contacts
         WHERE deleted_at IS NULL
         ORDER BY customer_id, is_primary DESC, created_at`,
      ),
      all<Record<string, unknown>>(
        `SELECT * FROM orders
         WHERE deleted_at IS NULL
         ORDER BY COALESCE(order_date, created_at) DESC LIMIT 300`,
      ),
      all<Record<string, unknown>>(
        "SELECT * FROM order_items ORDER BY order_id, rowid",
      ),
      all<Record<string, unknown>>(
        "SELECT * FROM order_payments ORDER BY order_id, payment_type, payment_date, sort_order, created_at",
      ),
      all<Record<string, unknown>>(
        `SELECT * FROM order_risks
         WHERE status = 'active' AND trigger_type <> 'shipment_delay'
         ORDER BY CASE risk_level WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
           detected_at DESC LIMIT 500`,
      ),
      all<Record<string, unknown>>(
        `SELECT * FROM order_status_history
         ORDER BY created_at DESC LIMIT 500`,
      ),
      all<Record<string, unknown>>(
        `SELECT * FROM projects ORDER BY
          CASE WHEN COALESCE(work_sort_order, 0) > 0 THEN 0 ELSE 1 END,
          work_sort_order,
          updated_at DESC LIMIT 100`,
      ),
      all<Record<string, unknown>>(
        `SELECT * FROM source_documents
         WHERE document_type = 'sales_playbook_source'
         ORDER BY updated_at DESC LIMIT 100`,
      ),
      all<Record<string, unknown>>(
        "SELECT * FROM knowledge_items ORDER BY updated_at DESC LIMIT 100",
      ),
      all<Record<string, unknown>>(
        `SELECT * FROM sales_playbook_items
         ORDER BY joyce_approved DESC, updated_at DESC LIMIT 100`,
      ),
      all<Record<string, unknown>>(
        "SELECT * FROM content_items ORDER BY updated_at DESC LIMIT 100",
      ),
      all<{ source_type: string; count: number }>(
        "SELECT source_type, COUNT(*) AS count FROM legacy_records GROUP BY source_type ORDER BY source_type",
      ),
      db
        .prepare(
          `SELECT
            SUM(CASE WHEN customer_code IS NULL OR trim(customer_code) = '' THEN 1 ELSE 0 END) AS missing_customer_codes,
            (SELECT COUNT(*) FROM orders WHERE currency_status = 'needs_confirmation' AND deleted_at IS NULL) AS currency_inconsistencies,
            (SELECT COUNT(*) FROM source_documents WHERE document_type = 'sales_playbook_source' AND review_status = 'needs_review') AS documents_needing_review,
            (SELECT COUNT(*) FROM sales_playbook_items WHERE joyce_approved = 1 AND review_status = 'current') AS approved_playbook_items,
            (SELECT COUNT(*) FROM customers) AS phase12_current_customers,
            (SELECT COUNT(*) FROM backup_v21_customers_20260723) AS phase12_backup_customers,
            (SELECT COUNT(*) FROM tasks) AS phase12_current_tasks,
            (SELECT COUNT(*) FROM backup_v21_tasks_20260723) AS phase12_backup_tasks,
            (SELECT COUNT(*) FROM tasks) AS task_cleanup_current_tasks,
            (SELECT COUNT(*) FROM backup_v21_tasks_cleanup_20260723) AS task_cleanup_backup_tasks,
            (SELECT COUNT(*) FROM tasks WHERE deleted_at IS NOT NULL) AS task_trash_count,
            (SELECT COUNT(*) FROM backup_v21_tasks_priority_20260724) AS priority_backup_tasks,
            (SELECT COUNT(*) FROM backup_v21_projects_priority_20260724) AS priority_backup_projects,
            (SELECT COUNT(*) FROM contacts) AS phase12_current_contacts,
            (SELECT COUNT(*) FROM backup_v21_contacts_20260723) AS phase12_backup_contacts,
            (SELECT COUNT(*) FROM orders) AS phase4_current_orders,
            (SELECT COUNT(*) FROM backup_v21_orders_phase4_20260723) AS phase4_backup_orders
           FROM customers WHERE lifecycle = 'existing'`,
        )
        .first<Record<string, number>>(),
    ]);

    const currentYearVehicleSales = sumAttributedVehicleSales(
      salesAttributionOrders,
      year,
      today,
    );
    const salesTrend = buildAttributedSalesTrend(
      salesAttributionOrders,
      year,
      today,
    );
    const contribution = buildAttributedCustomerContribution(
      salesAttributionOrders,
      year,
      today,
    ).slice(0, 8);

    const nonCustomerAttention = await all<Record<string, unknown>>(
      `SELECT kind, id, order_id, source_type, source_id, title, message, risk_level, evidence_source, attention_date FROM (
       SELECT 'order' AS kind, r.id, r.order_id, 'order' AS source_type, r.order_id AS source_id,
         COALESCE(o.order_no, o.pi_no, o.customer_code, '订单') AS title,
         r.title || '：' || r.reason AS message,
         r.risk_level, r.evidence_source, r.detected_at AS attention_date
       FROM order_risks r
       JOIN orders o ON o.id = r.order_id
        WHERE r.status = 'active' AND o.deleted_at IS NULL
          AND COALESCE(o.order_status, 'active') <> 'completed'
       UNION ALL
       SELECT 'task', id, NULL, 'task', id, title,
         '任务提醒日期已到：' || COALESCE(NULLIF(reminder_date, ''), NULLIF(next_action_date, ''), NULLIF(due_date, '')),
         'High',
         CASE
           WHEN NULLIF(reminder_date, '') IS NOT NULL THEN 'tasks.reminder_date'
           WHEN NULLIF(next_action_date, '') IS NOT NULL THEN 'tasks.next_action_date'
           ELSE 'tasks.due_date'
         END,
         COALESCE(NULLIF(reminder_date, ''), NULLIF(next_action_date, ''), NULLIF(due_date, ''))
       FROM tasks
       WHERE deleted_at IS NULL AND archived_at IS NULL AND completed_at IS NULL
         AND status IN ('pending', 'in_progress', 'Pending', 'In Progress', '待处理', '进行中', 'snoozed', 'Snoozed', '延期')
          AND COALESCE(NULLIF(reminder_date, ''), NULLIF(next_action_date, ''), NULLIF(due_date, '')) < ?
       )
       ORDER BY CASE risk_level WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
         CASE WHEN source_type = 'task' THEN attention_date ELSE '9999-12-31' END,
         attention_date,
         source_type,
         source_id`,
      today,
    );
    const customerAttention = customers
      .map((customer) => buildCustomerFollowUpAttention(customer, today))
      .filter((item): item is Record<string, unknown> => Boolean(item));
    const attention = [...nonCustomerAttention, ...customerAttention].sort((left, right) =>
      String(left.risk_level || "").localeCompare(String(right.risk_level || "")) ||
      String(left.attention_date || "").localeCompare(String(right.attention_date || "")) ||
      String(left.source_type || "").localeCompare(String(right.source_type || "")) ||
      String(left.source_id || "").localeCompare(String(right.source_id || "")),
    );

    const normalizedTasks = tasks.map((task) => {
      const snoozedUntil = String(task.snoozed_until ?? "");
      if (
        ["snoozed", "Snoozed"].includes(String(task.status)) &&
        snoozedUntil &&
        snoozedUntil <= today
      ) {
        return { ...task, status: "pending", effective_status: "pending" };
      }
      return { ...task, effective_status: task.status };
    });

    const todayTasks = normalizedTasks.filter((task) => {
      const due = String(
        task.reminder_date ?? task.next_action_date ?? task.due_date ?? "",
      );
      const status = String(task.effective_status ?? task.status);
      return (
        !["已完成", "completed", "Completed", "cancelled", "Cancelled"].includes(
          status,
        ) &&
        !task.archived_at &&
        !task.deleted_at &&
        ["待处理", "进行中", "pending", "in_progress", "Pending", "In Progress"].includes(
          status,
        ) &&
        Boolean(due && due <= today)
      );
    });

    return Response.json({
      generatedAt: new Date().toISOString(),
      metrics: {
        currentYearVehicleSales,
        currentYearAccessorySales: Number(
          accessorySales.find((entry) => String(entry.sales_year) === year)?.amount_cny ?? 0,
        ),
        currentYearSales:
          currentYearVehicleSales +
          Number(accessorySales.find((entry) => String(entry.sales_year) === year)?.amount_cny ?? 0),
        activeOrderValue: Number(metrics?.active_order_value ?? 0),
        existingCustomers: Number(customerCounts?.existing_count ?? 0),
        aPotentialCustomers: Number(customerCounts?.a_potential_count ?? 0),
        potentialLeads: Number(customerCounts?.lead_count ?? 0),
        currencyReviewCount: Number(metrics?.currency_review_count ?? 0),
      },
      salesTrend,
      contribution,
      todayTasks,
      attention,
      tasks: normalizedTasks,
      customers,
      contacts,
      orders,
      orderItems,
      orderPayments,
      orderRisks,
      orderStatusHistory,
      accessorySales,
      projects,
      sourceDocuments,
      knowledge,
      playbook,
      content,
      integrity: {
        migrationCounts,
        ...reviewCounts,
      },
    });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Workspace could not be loaded.",
      500,
    );
  }
}

export async function POST(request: Request) {
  const requestStartedAt = performance.now();
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    const kind = asText(payload.kind, 40);
    const action = asText(payload.action, 60) || "create";
    const db = getD1();
    const databaseStartedAt = performance.now();
    const id = asText(payload.id, 100) || crypto.randomUUID();
    const now = new Date().toISOString();

    if (action === "update_task_status") {
      const taskId = asText(payload.id, 100);
      const status = asText(payload.status, 40);
      if (!taskId || !["待处理", "进行中", "已完成", "延期"].includes(status)) {
        return jsonError("Invalid task status update.");
      }
      await db.batch([
        db
          .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
          .bind(status, now, taskId),
        db
          .prepare(
            `INSERT INTO audit_logs(id, action, entity_type, entity_id, after_data, source)
             VALUES (?, 'task_status_updated', 'task', ?, ?, 'user')`,
          )
          .bind(crypto.randomUUID(), taskId, JSON.stringify({ status })),
      ]);
      return workspacePostResponse(
        { ok: true, id: taskId },
        requestStartedAt,
        databaseStartedAt,
      );
    }

    if (kind === "task") {
      const title = asText(payload.title, 200);
      if (!title) return jsonError("工作内容不能为空。");
      await db
        .prepare(
          `INSERT INTO tasks
            (id, title, status, priority, due_date, next_action_date,
             reminder_date, recurrence_rule, customer_id, next_action, notes,
             source_type, source_id, work_sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?,
                   (SELECT COALESCE(MAX(work_sort_order), 0) + 100 FROM tasks), ?, ?)`,
        )
        .bind(
          id,
          title,
          asText(payload.status, 40) || "pending",
          "中",
          null,
          null,
          asNullableText(payload.reminderDate, 10),
          ["daily", "weekly", "monthly", "yearly"].includes(
            asText(payload.recurrenceRule, 20),
          )
            ? asText(payload.recurrenceRule, 20)
            : "none",
          null,
          asNullableText(payload.nextAction),
          asNullableText(payload.notes),
          null,
          now,
          now,
        )
        .run();
    } else if (kind === "customer") {
      const company = asText(payload.company, 300);
      const lifecycle = asText(payload.lifecycle, 40);
      const customerCode = asText(payload.customerCode, 40).toUpperCase();
      if (!company) return jsonError("公司名不能为空。");
      if (!["potential_lead", "potential_customer", "existing"].includes(lifecycle)) {
        return jsonError("Invalid customer lifecycle.");
      }
      if (lifecycle === "existing" && !customerCode) {
        return jsonError("老客户必须填写客户代码。");
      }
      if (customerCode) {
        const duplicate = await db
          .prepare(
            `SELECT id FROM customers
             WHERE upper(trim(customer_code)) = ? AND deleted_at IS NULL
             LIMIT 1`,
          )
          .bind(customerCode)
          .first<{ id: string }>();
        if (duplicate) return jsonError(`客户代码 ${customerCode} 已存在。`, 409);
      }
      const parsedContacts = parseNewCustomerContacts(payload.contacts);
      if ("error" in parsedContacts) return jsonError(parsedContacts.error);
      await db.batch([
        db
          .prepare(
            `INSERT INTO customers
              (id, customer_code, company, lifecycle, grade, country, city,
               address, customer_type, website, source, next_action,
               company_background_notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            customerCode || null,
            company,
            lifecycle,
            null,
            asNullableText(payload.country, 100),
            asNullableText(payload.city, 100),
            asNullableText(payload.address, 1000),
            asNullableText(payload.customerType, 100),
            asNullableText(payload.website, 500),
            asNullableText(payload.source, 300) || "manual",
            asNullableText(payload.nextAction),
            asNullableText(payload.companyBackgroundNotes, 20000),
            now,
            now,
          ),
        ...parsedContacts.contacts.map((contact) =>
          db
            .prepare(
              `INSERT INTO contacts
                (id, customer_id, name, position, role, email, phone, whatsapp, wechat,
                 linkedin, notes, is_primary, deleted_at, legacy_metadata,
                 created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}', ?, ?)`,
            )
            .bind(
              crypto.randomUUID(),
              id,
              contact.name,
              contact.position,
              contact.position,
              contact.email,
              contact.phone,
              contact.whatsapp,
              contact.wechat,
              contact.linkedin,
              contact.notes,
              contact.isPrimary ? 1 : 0,
              now,
              now,
            ),
        ),
        db
          .prepare(
            `INSERT INTO customer_status_history
              (id, customer_id, to_status, reason, source, created_at)
             VALUES (?, ?, ?, 'Manual creation', 'user', ?)`,
          )
          .bind(crypto.randomUUID(), id, lifecycle, now),
      ]);
    } else if (kind === "order") {
      if (payload.confirmFinancialRisk !== true) {
        return jsonError("订单金额属于 Level 3 操作，必须明确确认。", 409);
      }
      const currency = asText(payload.originalCurrency, 10).toUpperCase();
      const originalAmount = Number(payload.originalAmount);
      const rawRate =
        currency === "CNY" || currency === "RMB"
          ? 1
          : Number(payload.fixedExchangeRateToCny);
      const confirmed =
        Boolean(currency) &&
        Number.isFinite(originalAmount) &&
        originalAmount >= 0 &&
        Number.isFinite(rawRate) &&
        rawRate > 0;
      await db
        .prepare(
          `INSERT INTO orders (
            id, customer_id, customer_code, customer_name, order_no, order_date, model,
            original_currency, original_amount, fixed_exchange_rate_to_cny, cny_amount,
            currency_status, payment_status, production_status, shipment_status,
            etd, eta, due_date, risk, notes, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          asNullableText(payload.customerId, 100),
          asNullableText(payload.customerCode, 40),
          asNullableText(payload.customerName, 300),
          asNullableText(payload.orderNo, 100),
          asNullableText(payload.orderDate, 10),
          asNullableText(payload.model, 300),
          currency || null,
          Number.isFinite(originalAmount) ? originalAmount : null,
          confirmed ? rawRate : null,
          confirmed ? originalAmount * rawRate : null,
          confirmed ? "confirmed" : "needs_confirmation",
          asNullableText(payload.paymentStatus, 100),
          asNullableText(payload.productionStatus, 100),
          asNullableText(payload.shipmentStatus, 100),
          asNullableText(payload.etd, 10),
          asNullableText(payload.eta, 10),
          asNullableText(payload.dueDate, 10),
          asNullableText(payload.risk),
          asNullableText(payload.notes),
          now,
          now,
        )
        .run();
    } else if (kind === "project") {
      const title = asText(payload.title, 300);
      if (!title) return jsonError("项目标题不能为空。");
      await db
        .prepare(
          `INSERT INTO projects(id, title, status, progress, next_step, notes, work_sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?,
                   (SELECT COALESCE(MAX(work_sort_order), 0) + 100 FROM projects), ?, ?)`,
        )
        .bind(
          id,
          title,
          asText(payload.status, 40) || "进行中",
          Math.max(0, Math.min(100, Number(payload.progress) || 0)),
          asNullableText(payload.nextStep),
          asNullableText(payload.notes),
          now,
          now,
        )
        .run();
    } else if (kind === "knowledge") {
      const originalText = asText(payload.originalText, 20000);
      if (!originalText) return jsonError("原始内容不能为空。");
      await db
        .prepare(
          `INSERT INTO knowledge_items
            (id, title, category, categories, tags, source, source_name, summary,
             applicable_situations, applicable_scenarios, original_text,
             original_source_type, ai_processing_status, human_review_status, reviewed_at,
             review_status, joyce_approved, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual',
                   'source_only', 'approved', ?, 'approved', 1, ?, ?)`,
        )
        .bind(
          id,
          asText(payload.title, 300) || originalText.slice(0, 60),
          asNullableText(payload.category, 100),
          JSON.stringify(
            asNullableText(payload.category, 100)
              ? [asText(payload.category, 100)]
              : [],
          ),
          JSON.stringify(Array.isArray(payload.tags) ? payload.tags.slice(0, 12) : []),
          asNullableText(payload.source, 500),
          asNullableText(payload.source, 500),
          asNullableText(payload.summary),
          asNullableText(payload.applicableSituations),
          JSON.stringify(
            asNullableText(payload.applicableSituations)
              ? [asText(payload.applicableSituations)]
              : [],
          ),
          originalText,
          now,
          now,
          now,
        )
        .run();
    } else {
      return jsonError("Unsupported record kind.");
    }

    await db
      .prepare(
        `INSERT INTO audit_logs(id, action, entity_type, entity_id, after_data, source)
         VALUES (?, 'record_created', ?, ?, ?, 'user')`,
      )
      .bind(crypto.randomUUID(), kind, id, JSON.stringify(payload))
      .run();

    const record =
      kind === "task"
        ? await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first()
        : kind === "project"
          ? await db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first()
          : null;
    return workspacePostResponse(
      { ok: true, id, record },
      requestStartedAt,
      databaseStartedAt,
      201,
    );
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Record could not be saved.",
      500,
    );
  }
}
