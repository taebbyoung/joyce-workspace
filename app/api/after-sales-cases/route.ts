import { requestJson } from "@/lib/ai-client";
import {
  normalizeTechnicalCaseExtraction,
  parseTechnicalCaseTags,
} from "@/lib/after-sales-case";
import { ensureWorkspace, getD1 } from "@/db/runtime";

export const runtime = "edge";

function response(
  body: Record<string, unknown>,
  status = 200,
  extraHeaders: Record<string, string> = {},
) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function text(value: unknown, max = 20_000) {
  return String(value ?? "").trim().slice(0, max);
}

function nullable(value: unknown, max = 20_000) {
  const result = text(value, max);
  return result || null;
}

function normalizePayload(payload: Record<string, unknown>) {
  return {
    caseTitle: text(payload.caseTitle, 180),
    customerCode: nullable(payload.customerCode, 40),
    vehicleModel: nullable(payload.vehicleModel, 120),
    orderNo: nullable(payload.orderNo, 100),
    vin: nullable(payload.vin, 100),
    faultDate: /^\d{4}-\d{2}-\d{2}$/.test(text(payload.faultDate, 10))
      ? text(payload.faultDate, 10)
      : null,
    tags: parseTechnicalCaseTags(payload.tags),
    faultSymptoms: nullable(payload.faultSymptoms),
    troubleshootingProcess: nullable(payload.troubleshootingProcess),
    confirmedCause: nullable(payload.confirmedCause),
    reuseSolution: nullable(payload.reuseSolution),
    fullTechnicalReport: nullable(payload.fullTechnicalReport, 100_000),
  };
}

const detailFields = `id, customer_id, customer_code, code, case_title,
  vehicle_model, order_no, vin, fault_date, tags, issue_description,
  troubleshooting_process, confirmed_cause, reuse_solution,
  full_technical_report, legacy_metadata, created_at, updated_at`;

const listFields = `id, case_title, customer_code, vehicle_model, fault_date, tags,
  substr(COALESCE(issue_description, ''), 1, 220) AS fault_symptoms_summary,
  substr(COALESCE(confirmed_cause, ''), 1, 180) AS confirmed_cause_summary,
  updated_at`;

const searchableFields = [
  "case_title",
  "customer_code",
  "vehicle_model",
  "order_no",
  "vin",
  "tags",
  "issue_description",
  "troubleshooting_process",
  "confirmed_cause",
  "reuse_solution",
  "full_technical_report",
];

function searchSnippet(query: string) {
  if (!query) {
    return {
      sql: "substr(COALESCE(issue_description, confirmed_cause, ''), 1, 180) AS match_snippet",
      bindings: [] as string[],
    };
  }
  const branches = searchableFields.map(
    (field) =>
      `WHEN instr(lower(COALESCE(${field}, '')), lower(?)) > 0
       THEN substr(COALESCE(${field}, ''),
         MAX(1, instr(lower(COALESCE(${field}, '')), lower(?)) - 50), 180)`,
  );
  return {
    sql: `CASE ${branches.join(" ")}
      ELSE substr(COALESCE(issue_description, confirmed_cause, ''), 1, 180)
      END AS match_snippet`,
    bindings: searchableFields.flatMap(() => [query, query]),
  };
}

export async function GET(request: Request) {
  const requestStarted = performance.now();
  try {
    const db = getD1();
    const url = new URL(request.url);
    const id = text(url.searchParams.get("id"), 100);
    if (id) {
      const databaseStarted = performance.now();
      const record = await db
        .prepare(`SELECT ${detailFields} FROM after_sales_cases WHERE id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      if (!record) return response({ error: "未找到该技术案例。" }, 404);
      const databaseDuration = performance.now() - databaseStarted;
      return response(
        { record },
        200,
        {
          "server-timing": `db;dur=${databaseDuration.toFixed(1)}, total;dur=${(
            performance.now() - requestStarted
          ).toFixed(1)}`,
        },
      );
    }
    const query = text(url.searchParams.get("q"), 200);
    const model = text(url.searchParams.get("model"), 120);
    const tag = text(url.searchParams.get("tag"), 60);
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const requestedPageSize = Number.parseInt(url.searchParams.get("pageSize") || "30", 10) || 30;
    const pageSize = Math.min(50, Math.max(30, requestedPageSize));
    const clauses: string[] = [];
    const bindings: Array<string | number> = [];
    if (query) {
      const like = `%${query}%`;
      clauses.push(`(
        case_title LIKE ? OR customer_code LIKE ? OR vehicle_model LIKE ?
        OR order_no LIKE ? OR vin LIKE ? OR tags LIKE ?
        OR issue_description LIKE ? OR troubleshooting_process LIKE ?
        OR confirmed_cause LIKE ? OR reuse_solution LIKE ?
        OR full_technical_report LIKE ?
      )`);
      bindings.push(...Array(11).fill(like));
    }
    if (model) {
      clauses.push("vehicle_model = ?");
      bindings.push(model);
    }
    if (tag) {
      clauses.push("tags LIKE ?");
      bindings.push(`%${tag}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const snippet = searchSnippet(query);
    const totalStatement = bindings.length
      ? db.prepare(`SELECT COUNT(*) AS total FROM after_sales_cases ${where}`).bind(...bindings)
      : db.prepare(`SELECT COUNT(*) AS total FROM after_sales_cases ${where}`);
    const offset = (page - 1) * pageSize;
    const listStatement = db.prepare(
      `SELECT ${listFields}, ${snippet.sql}
       FROM after_sales_cases
       ${where}
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`,
    ).bind(...snippet.bindings, ...bindings, pageSize, offset);
    const modelStatement = db.prepare(
        `SELECT DISTINCT vehicle_model
         FROM after_sales_cases
         WHERE trim(COALESCE(vehicle_model, '')) <> ''
         ORDER BY vehicle_model LIMIT 100`,
      );
    const databaseStarted = performance.now();
    const [totalResult, caseResult, modelResult] = await db.batch([
      totalStatement,
      listStatement,
      modelStatement,
    ]);
    const databaseDuration = performance.now() - databaseStarted;
    const total = Number(
      (totalResult.results[0] as { total?: number } | undefined)?.total || 0,
    );
    const cases = caseResult.results as Array<Record<string, unknown>>;
    const models = modelResult.results as Array<{ vehicle_model: string }>;
    return response(
      {
        cases,
        modelSuggestions: models.map((item) => item.vehicle_model),
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / pageSize)),
          hasNext: offset + cases.length < total,
        },
      },
      200,
      {
        "server-timing": `db;dur=${databaseDuration.toFixed(1)}, total;dur=${(
          performance.now() - requestStarted
        ).toFixed(1)}`,
      },
    );
  } catch (error) {
    return response(
      {
        error:
          error instanceof Error
            ? error.message
            : "无法读取售后技术案例。",
      },
      500,
    );
  }
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    if (payload.action === "extract") {
      const report = text(payload.fullTechnicalReport, 100_000);
      if (!report) return response({ error: "请先粘贴完整技术报告。" }, 400);
      const prompt = `你是售后技术案例库的字段识别员。你的唯一任务是把用户已经整理好的技术报告内容原样分配到对应字段。

严格规则：
1. 不得重新诊断、总结、改写、删减、补充、推断或优化。
2. 不扩大、不改变技术报告的结论，不添加报告没有的信息。
3. 怀疑、推测、可能、待验证的原因不得写入 confirmed_cause。
4. 只有报告明确确认最终根因时，cause_confirmed 才能为 true。
5. 缺失的标题、客户代码、车型、订单号、VIN、日期和其他字段必须返回空字符串。
6. 保留技术术语、报警代码、测量结果、原有措辞和排查先后顺序。
7. tags 只能原样使用报告中已经明确列出的标签；不得自行生成标签。
8. reuse_solution 只能放入报告已有的解决及复用方法；不得补充新建议。
9. 只返回 JSON，不得输出解释。

JSON结构：
{
  "case_title": "",
  "customer_code": "",
  "vehicle_model": "",
  "order_no": "",
  "vin": "",
  "fault_date": "YYYY-MM-DD或空字符串",
  "tags": ["报警代码", "故障现象", "零部件"],
  "fault_symptoms": "",
  "troubleshooting_process": "",
  "cause_confirmed": false,
  "confirmed_cause": "",
  "reuse_solution": ""
}

完整技术报告：
${report}`;
      const { data, meta } = await requestJson(
        {
          task: "default",
          system:
            "你是结构化归档录入员，只做字段识别和原样分配。必须返回JSON，不做诊断、总结或改写。",
          prompt,
          maxTokens: 4000,
        },
        (value): value is Record<string, unknown> =>
          Boolean(normalizeTechnicalCaseExtraction(value, report)),
      );
      const draft = normalizeTechnicalCaseExtraction(data, report);
      if (!draft) {
        return response(
          { error: "AI未能可靠识别案例字段，原始报告仍保留在编辑框中。" },
          502,
        );
      }
      return response({
        draft,
        provider: meta.provider,
        model: meta.model,
        saved: false,
      });
    }

    const input = normalizePayload(payload);
    if (!input.caseTitle) return response({ error: "案例标题不能为空。" }, 400);
    const db = getD1();
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const customer = input.customerCode
      ? await db
          .prepare(
            `SELECT id FROM customers
             WHERE upper(trim(customer_code)) = upper(trim(?))
               AND deleted_at IS NULL LIMIT 1`,
          )
          .bind(input.customerCode)
          .first<{ id: string }>()
      : null;
    await db
      .prepare(
        `INSERT INTO after_sales_cases (
          id, customer_id, customer_code, case_title, vehicle_model, order_no,
          vin, fault_date, tags, issue_description, troubleshooting_process,
          confirmed_cause, reuse_solution, full_technical_report, status,
          legacy_metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '已关闭', '{}', ?, ?)`,
      )
      .bind(
        id,
        customer?.id ?? null,
        input.customerCode,
        input.caseTitle,
        input.vehicleModel,
        input.orderNo,
        input.vin,
        input.faultDate,
        JSON.stringify(input.tags),
        input.faultSymptoms,
        input.troubleshootingProcess,
        input.confirmedCause,
        input.reuseSolution,
        input.fullTechnicalReport,
        now,
        now,
      )
      .run();
    const record = await db
      .prepare(`SELECT ${detailFields} FROM after_sales_cases WHERE id = ?`)
      .bind(id)
      .first<Record<string, unknown>>();
    await db
      .prepare(
        `INSERT INTO audit_logs
          (id, action, entity_type, entity_id, before_data, after_data, source)
         VALUES (?, 'created', 'after_sales_case', ?, NULL, ?, 'user')`,
      )
      .bind(crypto.randomUUID(), id, JSON.stringify(record))
      .run();
    return response({ record }, 201);
  } catch (error) {
    return response(
      {
        error:
          error instanceof Error ? error.message : "售后技术案例保存失败。",
      },
      500,
    );
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    const id = text(payload.id, 100);
    if (!id) return response({ error: "缺少案例ID。" }, 400);
    const input = normalizePayload(payload);
    if (!input.caseTitle) return response({ error: "案例标题不能为空。" }, 400);
    const db = getD1();
    const before = await db
      .prepare(`SELECT ${detailFields} FROM after_sales_cases WHERE id = ?`)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!before) return response({ error: "未找到该技术案例。" }, 404);
    const customer = input.customerCode
      ? await db
          .prepare(
            `SELECT id FROM customers
             WHERE upper(trim(customer_code)) = upper(trim(?))
               AND deleted_at IS NULL LIMIT 1`,
          )
          .bind(input.customerCode)
          .first<{ id: string }>()
      : null;
    const now = new Date().toISOString();
    await db
      .prepare(
        `UPDATE after_sales_cases SET
          customer_id = ?, customer_code = ?, case_title = ?, vehicle_model = ?, order_no = ?,
          vin = ?, fault_date = ?, tags = ?, issue_description = ?,
          troubleshooting_process = ?, confirmed_cause = ?,
          reuse_solution = ?, full_technical_report = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        customer?.id ?? null,
        input.customerCode,
        input.caseTitle,
        input.vehicleModel,
        input.orderNo,
        input.vin,
        input.faultDate,
        JSON.stringify(input.tags),
        input.faultSymptoms,
        input.troubleshootingProcess,
        input.confirmedCause,
        input.reuseSolution,
        input.fullTechnicalReport,
        now,
        id,
      )
      .run();
    const record = await db
      .prepare(`SELECT ${detailFields} FROM after_sales_cases WHERE id = ?`)
      .bind(id)
      .first<Record<string, unknown>>();
    await db
      .prepare(
        `INSERT INTO audit_logs
          (id, action, entity_type, entity_id, before_data, after_data, source)
         VALUES (?, 'updated', 'after_sales_case', ?, ?, ?, 'user')`,
      )
      .bind(crypto.randomUUID(), id, JSON.stringify(before), JSON.stringify(record))
      .run();
    return response({ record });
  } catch (error) {
    return response(
      { error: error instanceof Error ? error.message : "技术案例更新失败。" },
      500,
    );
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureWorkspace();
    const payload = (await request.json()) as Record<string, unknown>;
    const id = text(payload.id, 100);
    if (!id) return response({ error: "缺少案例ID。" }, 400);
    const db = getD1();
    const before = await db
      .prepare(`SELECT ${detailFields} FROM after_sales_cases WHERE id = ?`)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!before) return response({ error: "未找到该技术案例。" }, 404);
    await db.prepare("DELETE FROM after_sales_cases WHERE id = ?").bind(id).run();
    await db
      .prepare(
        `INSERT INTO audit_logs
          (id, action, entity_type, entity_id, before_data, after_data, source)
         VALUES (?, 'deleted', 'after_sales_case', ?, ?, NULL, 'user')`,
      )
      .bind(crypto.randomUUID(), id, JSON.stringify(before))
      .run();
    return response({ ok: true, id });
  } catch (error) {
    return response(
      { error: error instanceof Error ? error.message : "技术案例删除失败。" },
      500,
    );
  }
}
