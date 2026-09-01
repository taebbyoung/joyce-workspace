import { ensureWorkspace, getD1 } from "@/db/runtime";

export const runtime = "edge";

type LegacyModule = {
  id?: string;
  name?: string;
  fields?: Array<{ id?: string; label?: string; type?: string }>;
};

type LegacyState = {
  modules?: LegacyModule[];
  records?: Record<string, Array<Record<string, unknown>>>;
};

const knownFields: Record<string, Set<string>> = {
  tasks: new Set([
    "id",
    "title",
    "date",
    "status",
    "priority",
    "customer",
    "order",
    "next",
    "notes",
    "createdAt",
    "updatedAt",
    "calendarSourceId",
    "importedFrom",
  ]),
  orders: new Set([
    "id",
    "orderNo",
    "customerCode",
    "customer",
    "model",
    "amount",
    "currency",
    "payment",
    "production",
    "shipping",
    "due",
    "risk",
    "next",
    "createdAt",
    "updatedAt",
  ]),
  customers: new Set([
    "id",
    "customerCode",
    "company",
    "grade",
    "country",
    "customerType",
    "contact",
    "email",
    "phone",
    "cooperation",
    "paymentHabit",
    "growth",
    "products",
    "lastFollow",
    "nextFollow",
    "strategy",
    "profile",
    "createdAt",
    "updatedAt",
    "importedFrom",
  ]),
  leads: new Set([
    "id",
    "company",
    "country",
    "source",
    "type",
    "target",
    "website",
    "linkedin",
    "maps",
    "contact",
    "verified",
    "fit",
    "score",
    "grade",
    "notPeer",
    "business",
    "whyBuy",
    "products",
    "angle",
    "selling",
    "next",
    "createdAt",
    "updatedAt",
    "importedFrom",
    "convertedToProspect",
  ]),
  prospects: new Set([
    "id",
    "company",
    "stage",
    "grade",
    "priority",
    "country",
    "customerType",
    "source",
    "website",
    "social",
    "contact",
    "contactStatus",
    "productInterest",
    "demand",
    "pitch",
    "quote",
    "lastFollow",
    "nextFollow",
    "next",
    "notes",
    "sourceLeadId",
    "createdAt",
    "updatedAt",
  ]),
  complaints: new Set([
    "id",
    "code",
    "date",
    "customer",
    "model",
    "type",
    "severity",
    "status",
    "symptom",
    "cause",
    "solution",
    "reply",
    "createdAt",
    "updatedAt",
  ]),
  content: new Set([
    "id",
    "topic",
    "platform",
    "date",
    "status",
    "product",
    "audience",
    "selling",
    "copy",
    "result",
    "createdAt",
    "updatedAt",
  ]),
};

function text(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(record: Record<string, unknown>, key: string) {
  const raw = record[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const match = String(raw ?? "")
    .replace(/,/g, "")
    .match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function v1CompanyNotes(parts: string[]) {
  const content = parts.filter(Boolean).join("\n").trim();
  return content ? `【V1 原备注】\n${content}` : null;
}

async function sha256(value: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function analyze(state: LegacyState) {
  const modules = Array.isArray(state.modules) ? state.modules : [];
  const records =
    state.records && typeof state.records === "object" ? state.records : {};
  const recordCounts = Object.fromEntries(
    Object.entries(records).map(([key, rows]) => [
      key,
      Array.isArray(rows) ? rows.length : 0,
    ]),
  );
  const unmappedFields: Record<string, string[]> = {};
  for (const [moduleId, rows] of Object.entries(records)) {
    if (!Array.isArray(rows)) continue;
    const union = new Set(rows.flatMap((row) => Object.keys(row ?? {})));
    const known = knownFields[moduleId] ?? new Set<string>();
    unmappedFields[moduleId] = [...union].filter((key) => !known.has(key));
  }
  const customerRows = Array.isArray(records.customers)
    ? records.customers
    : [];
  const orderRows = Array.isArray(records.orders) ? records.orders : [];
  return {
    moduleCount: modules.length,
    modules: modules.map((module) => ({
      id: module.id ?? "",
      name: module.name ?? "",
      fieldCount: Array.isArray(module.fields) ? module.fields.length : 0,
    })),
    recordCounts,
    totalRecords: Object.values(recordCounts).reduce(
      (sum, count) => sum + count,
      0,
    ),
    customModules: modules
      .map((module) => module.id ?? "")
      .filter((id) => id && !knownFields[id]),
    unmappedFields,
    missingCustomerCodes: customerRows.filter(
      (row) => !text(row, "customerCode"),
    ).length,
    currencyReviewCount: orderRows.filter((row) => {
      const currency = text(row, "currency").toUpperCase();
      return currency !== "CNY" && currency !== "RMB";
    }).length,
  };
}

async function findCustomerId(record: Record<string, unknown>) {
  const db = getD1();
  const code = text(record, "customerCode");
  const company =
    text(record, "company") || text(record, "customer") || text(record, "customerName");
  const website = text(record, "website");
  if (code) {
    const row = await db
      .prepare(
        "SELECT id FROM customers WHERE upper(customer_code) = upper(?) LIMIT 1",
      )
      .bind(code)
      .first<{ id: string }>();
    if (row?.id) return row.id;
  }
  if (website) {
    const row = await db
      .prepare(
        "SELECT id FROM customers WHERE lower(website) = lower(?) LIMIT 1",
      )
      .bind(website)
      .first<{ id: string }>();
    if (row?.id) return row.id;
  }
  if (company) {
    const row = await db
      .prepare(
        "SELECT id FROM customers WHERE lower(trim(company)) = lower(trim(?)) LIMIT 1",
      )
      .bind(company)
      .first<{ id: string }>();
    if (row?.id) return row.id;
  }
  return null;
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as {
      action?: string;
      state?: LegacyState;
    };
    const state = payload.state ?? {};
    if (!state.modules || !state.records) {
      return Response.json(
        { error: "V1 备份格式不正确：缺少 modules 或 records。" },
        { status: 400 },
      );
    }
    const report = analyze(state);
    if (payload.action !== "import") {
      return Response.json({ preview: report });
    }

    const db = getD1();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const importedCounts: Record<string, number> = {};

    for (const [moduleId, rawRows] of Object.entries(state.records)) {
      if (!Array.isArray(rawRows)) continue;
      importedCounts[moduleId] = 0;
      for (const [index, record] of rawRows.entries()) {
        if (!record || typeof record !== "object") continue;
        const sourceId = text(record, "id") || `${moduleId}_${index}`;
        const legacyId = `browser_${moduleId}_${sourceId}`;
        const raw = JSON.stringify(record);
        const existingLegacy = await db
          .prepare("SELECT id FROM legacy_records WHERE id = ?")
          .bind(legacyId)
          .first();
        if (existingLegacy) continue;

        let targetType: string | null = null;
        let targetId: string | null = null;
        let reviewReason: string | null = null;

        if (moduleId === "customers") {
          targetId =
            (await findCustomerId(record)) ?? `customer_browser_${sourceId}`;
          targetType = "customer";
          await db
            .prepare(
              `INSERT INTO customers (
                id, customer_code, company, lifecycle, grade, country, customer_type,
                contact, email, phone, next_action, last_follow, next_follow, strategy,
                profile, source, legacy_metadata, company_background_notes, created_at, updated_at
              ) VALUES (?, ?, ?, 'existing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'v1_browser_backup', ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                customer_code = COALESCE(NULLIF(excluded.customer_code, ''), customers.customer_code),
                grade = COALESCE(NULLIF(excluded.grade, ''), customers.grade),
                contact = COALESCE(NULLIF(excluded.contact, ''), customers.contact),
                email = COALESCE(NULLIF(excluded.email, ''), customers.email),
                phone = COALESCE(NULLIF(excluded.phone, ''), customers.phone),
                strategy = COALESCE(NULLIF(excluded.strategy, ''), customers.strategy),
                profile = COALESCE(NULLIF(excluded.profile, ''), customers.profile),
                legacy_metadata = excluded.legacy_metadata,
                company_background_notes = CASE
                  WHEN TRIM(COALESCE(customers.company_background_notes, '')) = ''
                    THEN excluded.company_background_notes
                  ELSE customers.company_background_notes
                END,
                updated_at = excluded.updated_at`,
            )
            .bind(
              targetId,
              text(record, "customerCode") || null,
              text(record, "company") || "未命名客户",
              text(record, "grade") || null,
              text(record, "country") || null,
              text(record, "customerType") || null,
              text(record, "contact") || null,
              text(record, "email") || null,
              text(record, "phone") || null,
              text(record, "strategy") || null,
              text(record, "lastFollow") || null,
              text(record, "nextFollow") || null,
              text(record, "strategy") || null,
              text(record, "profile") || null,
              raw,
              v1CompanyNotes([text(record, "strategy"), text(record, "profile")]),
              text(record, "createdAt") || now,
              text(record, "updatedAt") || now,
            )
            .run();
          if (!text(record, "customerCode")) {
            reviewReason = "Missing customer code.";
          }
        } else if (moduleId === "leads" || moduleId === "prospects") {
          const lifecycle =
            moduleId === "prospects" ? "potential_customer" : "potential_lead";
          const sourceLeadId = text(record, "sourceLeadId");
          targetId = sourceLeadId
            ? ((await db
                .prepare(
                  "SELECT target_id FROM legacy_records WHERE source_id = ? AND source_type IN ('v1_lead', 'browser_leads') LIMIT 1",
                )
                .bind(sourceLeadId)
                .first<{ target_id: string }>())?.target_id ?? null)
            : null;
          targetId =
            targetId ??
            (await findCustomerId(record)) ??
            `customer_browser_${moduleId}_${sourceId}`;
          targetType = "customer";
          await db
            .prepare(
              `INSERT INTO customers (
                id, company, lifecycle, grade, country, customer_type, contact,
                website, source, next_action, strategy, profile, legacy_metadata,
                company_background_notes, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                lifecycle = CASE
                  WHEN customers.lifecycle = 'existing' THEN 'existing'
                  WHEN excluded.lifecycle = 'potential_customer' THEN 'potential_customer'
                  ELSE customers.lifecycle
                END,
                grade = COALESCE(NULLIF(excluded.grade, ''), customers.grade),
                next_action = COALESCE(NULLIF(excluded.next_action, ''), customers.next_action),
                legacy_metadata = excluded.legacy_metadata,
                company_background_notes = CASE
                  WHEN TRIM(COALESCE(customers.company_background_notes, '')) = ''
                    THEN excluded.company_background_notes
                  ELSE customers.company_background_notes
                END,
                updated_at = excluded.updated_at`,
            )
            .bind(
              targetId,
              text(record, "company") || "未命名线索",
              lifecycle,
              text(record, "grade") || null,
              text(record, "country") || null,
              text(record, "customerType") || text(record, "type") || null,
              text(record, "contact") || null,
              text(record, "website") || null,
              text(record, "source") || "v1_browser_backup",
              text(record, "next") || null,
              text(record, "pitch") || text(record, "angle") || null,
              text(record, "demand") || text(record, "business") || null,
              raw,
              v1CompanyNotes([
                text(record, "notes"),
                text(record, "whyBuy"),
                text(record, "selling"),
              ]),
              text(record, "createdAt") || now,
              text(record, "updatedAt") || now,
            )
            .run();
          await db
            .prepare(
              `INSERT OR IGNORE INTO customer_status_history
                (id, customer_id, to_status, reason, source, created_at)
               VALUES (?, ?, ?, 'V1 browser backup import', 'v1_import', ?)`,
            )
            .bind(
              `status_browser_${moduleId}_${sourceId}`,
              targetId,
              lifecycle,
              now,
            )
            .run();
        } else if (moduleId === "tasks") {
          targetType = "task";
          targetId = `task_browser_${sourceId}`;
          await db
            .prepare(
              `INSERT OR IGNORE INTO tasks (
                id, title, status, priority, due_date, next_action, notes,
                source_type, source_id, legacy_metadata, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'v1_browser_backup', ?, ?, ?, ?)`,
            )
            .bind(
              targetId,
              text(record, "title") || "未命名任务",
              text(record, "status") || "待处理",
              text(record, "priority") || "中",
              text(record, "date") || null,
              text(record, "next") || null,
              text(record, "notes") || null,
              text(record, "calendarSourceId") || sourceId,
              raw,
              text(record, "createdAt") || now,
              text(record, "updatedAt") || now,
            )
            .run();
        } else if (moduleId === "orders") {
          targetType = "order";
          targetId = `order_browser_${sourceId}`;
          const currency = text(record, "currency").toUpperCase();
          const amount = numberValue(record, "amount");
          const isCny = currency === "CNY" || currency === "RMB";
          await db
            .prepare(
              `INSERT OR IGNORE INTO orders (
                id, customer_id, customer_code, customer_name, order_no, model,
                original_currency, original_amount, fixed_exchange_rate_to_cny,
                cny_amount, currency_status, payment_status, production_status,
                shipment_status, due_date, risk, notes, legacy_metadata,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              targetId,
              await findCustomerId(record),
              text(record, "customerCode") || null,
              text(record, "customer") || null,
              text(record, "orderNo") || null,
              text(record, "model") || null,
              currency || null,
              amount,
              isCny ? 1 : null,
              isCny && amount !== null ? amount : null,
              isCny && amount !== null ? "confirmed" : "needs_confirmation",
              text(record, "payment") || null,
              text(record, "production") || null,
              text(record, "shipping") || null,
              text(record, "due") || null,
              text(record, "risk") || null,
              text(record, "next") || null,
              raw,
              text(record, "createdAt") || now,
              text(record, "updatedAt") || now,
            )
            .run();
          if (!isCny) reviewReason = "Currency / exchange rate needs confirmation.";
        } else if (moduleId === "complaints") {
          targetType = "after_sales_case";
          targetId = `after_sales_browser_${sourceId}`;
          await db
            .prepare(
              `INSERT OR IGNORE INTO after_sales_cases (
                id, customer_id, code, vehicle_model, issue_description, category,
                priority, status, original_customer_description, diagnosis,
                actions_taken, resolution, legacy_metadata, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              targetId,
              await findCustomerId(record),
              text(record, "code") || null,
              text(record, "model") || null,
              text(record, "symptom") || null,
              text(record, "type") || null,
              text(record, "severity") || null,
              text(record, "status") || "待处理",
              text(record, "symptom") || null,
              text(record, "cause") || null,
              text(record, "solution") || null,
              text(record, "reply") || null,
              raw,
              text(record, "createdAt") || text(record, "date") || now,
              text(record, "updatedAt") || now,
            )
            .run();
        } else if (moduleId === "content") {
          targetType = "content_item";
          targetId = `content_browser_${sourceId}`;
          await db
            .prepare(
              `INSERT OR IGNORE INTO content_items (
                id, topic, platform, status, draft, published_date, source_material,
                legacy_metadata, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              targetId,
              text(record, "topic") || "未命名内容",
              text(record, "platform") || null,
              text(record, "status") || "想法",
              text(record, "copy") || null,
              text(record, "date") || null,
              text(record, "selling") || null,
              raw,
              text(record, "createdAt") || now,
              text(record, "updatedAt") || now,
            )
            .run();
        } else {
          reviewReason = `Custom module "${moduleId}" preserved for mapping review.`;
        }

        await db
          .prepare(
            `INSERT INTO legacy_records (
              id, source_type, source_id, target_type, target_id, raw_payload,
              payload_hash, migration_status, review_reason, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            legacyId,
            `browser_${moduleId}`,
            sourceId,
            targetType,
            targetId,
            raw,
            await sha256(raw),
            targetId ? "migrated" : "preserved_for_review",
            reviewReason,
            now,
          )
          .run();
        importedCounts[moduleId] += 1;
      }
    }

    await db
      .prepare(
        `INSERT INTO audit_logs
          (id, action, entity_type, entity_id, after_data, source, created_at)
         VALUES (?, 'v1_browser_backup_imported', 'migration', ?, ?, 'user_confirmed', ?)`,
      )
      .bind(runId, runId, JSON.stringify({ importedCounts, preview: report }), now)
      .run();

    return Response.json({
      imported: true,
      runId,
      importedCounts,
      preview: report,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "V1 backup import failed.",
      },
      { status: 500 },
    );
  }
}
