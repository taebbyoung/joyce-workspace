import { ensureWorkspace, getD1 } from "@/db/runtime";
import {
  EDITABLE_LEAD_STATUSES,
  LEAD_COMPANY_TYPES,
  LEAD_DECISION_MAKER_FITS,
  LEAD_DEVELOPMENT_CHANNELS,
  LEAD_DEVELOPMENT_TYPES,
  LEAD_MARKET_FITS,
  LEAD_MOTO_EV_BUSINESSES,
  LEAD_PRIORITIES,
  LEAD_SOURCES,
  dateOnly,
  leadPayload,
  nextLeadTouchDate,
  normalizeLeadName,
  sortLeads,
  websiteDomain,
} from "@/lib/business-development";

export const runtime = "edge";

type Row = Record<string, unknown>;

function text(value: unknown, max = 5000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function nullable(value: unknown, max = 5000) {
  return text(value, max) || null;
}

function errorResponse(error: string, status = 400) {
  return Response.json({ error }, { status });
}

function today() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

async function audit(action: string, entityId: string, before: unknown, after: unknown) {
  await getD1().prepare(
    `INSERT INTO audit_logs
      (id, action, entity_type, entity_id, before_data, after_data, source)
     VALUES (?, ?, 'business_development_lead', ?, ?, ?, 'user')`,
  ).bind(
    crypto.randomUUID(),
    action,
    entityId,
    JSON.stringify(before ?? null),
    JSON.stringify(after ?? null),
  ).run();
}

async function leadSnapshot(leadId: string) {
  const db = getD1();
  const [lead, contacts, history] = await Promise.all([
    db.prepare("SELECT * FROM business_development_leads WHERE id = ?")
      .bind(leadId).first<Row>(),
    db.prepare(
      `SELECT * FROM lead_contacts WHERE lead_id = ?
       ORDER BY is_primary DESC, created_at, id`,
    ).bind(leadId).all<Row>(),
    db.prepare(
      `SELECT * FROM lead_development_history WHERE lead_id = ?
       ORDER BY development_at DESC, created_at DESC, id DESC`,
    ).bind(leadId).all<Row>(),
  ]);
  return { lead, contacts: contacts.results, history: history.results };
}

function allowed(value: string, values: readonly string[]) {
  return values.includes(value);
}

function leadValidationError(body: Row) {
  const checks: Array<[string, readonly string[], string]> = [
    ["status", EDITABLE_LEAD_STATUSES, "Lead 状态无效。"],
    ["priority", LEAD_PRIORITIES, "Lead Priority 无效。"],
    ["marketFit", LEAD_MARKET_FITS, "Market Fit 无效。"],
    ["motoEvBusiness", LEAD_MOTO_EV_BUSINESSES, "Motorcycle / EV 状态无效。"],
    ["source", LEAD_SOURCES, "Lead 来源无效。"],
    ["companyType", LEAD_COMPANY_TYPES, "Company Type 无效。"],
  ];
  for (const [field, values, message] of checks) {
    const value = text(body[field], 50);
    if (value && !allowed(value, values)) return message;
  }
  const nextFollowUpDate = text(body.nextFollowUpDate, 10);
  if (nextFollowUpDate && !/^\d{4}-\d{2}-\d{2}$/.test(nextFollowUpDate)) {
    return "下次跟进日期无效。";
  }
  return "";
}

function contactPayload(value: Row) {
  const decisionMakerFit = text(value.decisionMakerFit, 20);
  return {
    name: text(value.name, 300),
    title: text(value.title, 300),
    email: text(value.email, 300),
    phone: text(value.phone, 100),
    whatsapp: text(value.whatsapp, 100),
    wechat: text(value.wechat, 100),
    linkedin: text(value.linkedin, 500),
    note: text(value.note, 5000),
    isPrimary: value.isPrimary === true,
    decisionMakerFit: decisionMakerFit && allowed(decisionMakerFit, LEAD_DECISION_MAKER_FITS)
      ? decisionMakerFit
      : "",
  };
}

async function leadTouchCount(leadId: string) {
  const row = await getD1().prepare(
    `SELECT COUNT(*) AS count FROM lead_development_history
     WHERE lead_id = ? AND direction = 'outbound'`,
  ).bind(leadId).first<{ count: number }>();
  return Number(row?.count || 0);
}

async function conversionDuplicates(lead: Row) {
  const customers = await getD1().prepare(
    `SELECT id, company, country, website FROM customers
     WHERE deleted_at IS NULL`,
  ).all<Row>();
  const leadDomain = websiteDomain(lead.website);
  const leadName = String(lead.normalized_name || "");
  const leadCountry = String(lead.country || "").trim().toLowerCase();
  return customers.results.filter((customer) => {
    const sameDomain = Boolean(leadDomain && websiteDomain(customer.website) === leadDomain);
    const sameNameCountry = Boolean(
      leadName && leadCountry &&
      normalizeLeadName(customer.company) === leadName &&
      String(customer.country || "").trim().toLowerCase() === leadCountry,
    );
    return sameDomain || sameNameCountry;
  }).map((customer) => ({ id: customer.id, company: customer.company }));
}

export async function GET(request: Request) {
  await ensureWorkspace();
  const url = new URL(request.url);
  const leadId = text(url.searchParams.get("id"), 100);
  if (leadId) {
    const snapshot = await leadSnapshot(leadId);
    if (!snapshot.lead) return errorResponse("Lead 不存在。", 404);
    return Response.json(snapshot);
  }

  const db = getD1();
  const rows = await db.prepare(
    `SELECT l.*, c.id AS primary_contact_id, c.name AS primary_contact_name,
            c.title AS primary_contact_title, c.email AS primary_contact_email,
            c.linkedin AS primary_contact_linkedin, c.whatsapp AS primary_contact_whatsapp,
            c.wechat AS primary_contact_wechat,
            COALESCE(h.touch_count, 0) AS touch_count,
            h.last_development_date,
            (SELECT channel FROM lead_development_history recent
             WHERE recent.lead_id = l.id
             ORDER BY recent.development_at DESC, recent.created_at DESC, recent.id DESC
             LIMIT 1) AS last_development_channel
     FROM business_development_leads l
     LEFT JOIN lead_contacts c ON c.id = (
       SELECT id FROM lead_contacts
       WHERE lead_id = l.id
       ORDER BY is_primary DESC, created_at, id LIMIT 1
     )
     LEFT JOIN (
       SELECT lead_id,
              SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS touch_count,
              MAX(development_at) AS last_development_date
       FROM lead_development_history
       GROUP BY lead_id
     ) h ON h.lead_id = l.id`,
  ).all<Row>();
  const query = text(url.searchParams.get("query"), 300).toLowerCase();
  const status = text(url.searchParams.get("status"), 50);
  const priority = text(url.searchParams.get("priority"), 20);
  const country = text(url.searchParams.get("country"), 100);
  const source = text(url.searchParams.get("source"), 100);
  const motoEvBusiness = text(url.searchParams.get("moto_ev_business"), 20);
  const targetModel = text(url.searchParams.get("target_model"), 100).toLowerCase();
  const filtered = rows.results.filter((lead) => {
    const haystack = [lead.company_name, lead.country, lead.website, lead.website_domain, lead.primary_contact_name, lead.primary_contact_email]
      .join(" ").toLowerCase();
    return (!query || haystack.includes(query)) &&
      (!status || lead.status === status) &&
      (!priority || lead.priority === priority) &&
      (!country || lead.country === country) &&
      (!source || lead.source === source) &&
      (!motoEvBusiness || lead.moto_ev_business === motoEvBusiness) &&
      (!targetModel || String(lead.target_models || "").toLowerCase().includes(targetModel));
  });
  return Response.json({ leads: sortLeads(filtered, today()) });
}

export async function POST(request: Request) {
  await ensureWorkspace();
  let body: Row;
  try {
    body = await request.json() as Row;
  } catch {
    return errorResponse("请求内容无效。");
  }
  const action = text(body.action, 50);
  const leadId = text(body.leadId, 100);
  const db = getD1();
  const now = new Date().toISOString();

  try {
    if (action === "create") {
      const validationError = leadValidationError(body);
      if (validationError) return errorResponse(validationError);
      const payload = leadPayload(body);
      if (!payload.companyName) return errorResponse("请填写公司名称。");
      if (!payload.country) return errorResponse("请填写国家。");
      const id = crypto.randomUUID();
      await db.prepare(
        `INSERT INTO business_development_leads
          (id, company_name, normalized_name, country, city, website, website_domain,
           linkedin_company, source, company_type, moto_ev_business, existing_brands,
           relevant_products, target_models, market_fit, priority, why_worth_developing,
           risk_doubt, status, next_follow_up_date, next_step, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id, payload.companyName, payload.normalizedName, payload.country,
        nullable(payload.city, 100), nullable(payload.website, 500),
        nullable(payload.websiteDomain, 255), nullable(payload.linkedinCompany, 500),
        payload.source, nullable(payload.companyType, 100), payload.motoEvBusiness,
        nullable(payload.existingBrands, 3000), nullable(payload.relevantProducts, 3000),
        nullable(payload.targetModels, 1000), nullable(payload.marketFit, 20), payload.priority,
        nullable(payload.whyWorthDeveloping, 8000), nullable(payload.riskDoubt, 8000),
        payload.status, payload.nextFollowUpDate || null, nullable(payload.nextStep, 5000), now, now,
      ).run();
      await audit("business_development_lead_created", id, null, payload);
      return Response.json(await leadSnapshot(id));
    }

    if (!leadId) return errorResponse("缺少 Lead ID。");
    const before = await db.prepare("SELECT * FROM business_development_leads WHERE id = ?")
      .bind(leadId).first<Row>();
    if (!before) return errorResponse("Lead 不存在。", 404);

    if (action === "update") {
      const validationError = leadValidationError(body);
      if (validationError) return errorResponse(validationError);
      const payload = leadPayload({
        ...body,
        status: body.status ?? before.status,
        nextFollowUpDate: body.nextFollowUpDate ?? before.next_follow_up_date,
      });
      if (!payload.companyName) return errorResponse("请填写公司名称。");
      if (!payload.country) return errorResponse("请填写国家。");
      await db.prepare(
        `UPDATE business_development_leads SET
          company_name = ?, normalized_name = ?, country = ?, city = ?, website = ?,
          website_domain = ?, linkedin_company = ?, source = ?, company_type = ?,
          moto_ev_business = ?, existing_brands = ?, relevant_products = ?, target_models = ?,
          market_fit = ?, priority = ?, why_worth_developing = ?, risk_doubt = ?,
          status = ?, next_follow_up_date = ?, next_step = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(
        payload.companyName, payload.normalizedName, payload.country, nullable(payload.city, 100),
        nullable(payload.website, 500), nullable(payload.websiteDomain, 255),
        nullable(payload.linkedinCompany, 500), payload.source, nullable(payload.companyType, 100),
        payload.motoEvBusiness, nullable(payload.existingBrands, 3000),
        nullable(payload.relevantProducts, 3000), nullable(payload.targetModels, 1000),
        nullable(payload.marketFit, 20), payload.priority, nullable(payload.whyWorthDeveloping, 8000),
        nullable(payload.riskDoubt, 8000), payload.status, payload.nextFollowUpDate || null,
        nullable(payload.nextStep, 5000), now, leadId,
      ).run();
      await audit("business_development_lead_updated", leadId, before, payload);
      return Response.json(await leadSnapshot(leadId));
    }

    if (action === "research_complete") {
      if (before.status !== "research_pending") return errorResponse("当前 Lead 已完成研究。", 409);
      await db.batch([
        db.prepare(
          `UPDATE business_development_leads
           SET status = 'first_outreach_due', updated_at = ? WHERE id = ?`,
        ).bind(now, leadId),
        db.prepare(
          `INSERT INTO audit_logs
            (id, action, entity_type, entity_id, before_data, after_data, source)
           VALUES (?, 'lead_research_completed', 'business_development_lead', ?, ?, ?, 'user')`,
        ).bind(
          crypto.randomUUID(), leadId, JSON.stringify(before),
          JSON.stringify({ status: "first_outreach_due" }),
        ),
      ]);
      return Response.json(await leadSnapshot(leadId));
    }

    if (action === "set_next_date") {
      const nextDate = dateOnly(body.nextFollowUpDate);
      if (body.nextFollowUpDate && !nextDate) return errorResponse("下次开发日期无效。");
      await db.prepare(
        `UPDATE business_development_leads
         SET next_follow_up_date = ?, updated_at = ? WHERE id = ?`,
      ).bind(nextDate || null, now, leadId).run();
      await audit("lead_next_development_updated", leadId, before, { nextFollowUpDate: nextDate || null });
      return Response.json(await leadSnapshot(leadId));
    }

    if (action === "set_status") {
      const requested = text(body.status, 40);
      let nextStatus = requested;
      if (requested === "resume") {
        nextStatus = await leadTouchCount(leadId) > 0 ? "following_up" : "research_pending";
      }
      if (!["paused", "abandoned", "research_pending", "first_outreach_due", "following_up"].includes(nextStatus)) {
        return errorResponse("Lead 状态变更无效。");
      }
      await db.prepare(
        `UPDATE business_development_leads SET status = ?, updated_at = ? WHERE id = ?`,
      ).bind(nextStatus, now, leadId).run();
      await audit("lead_status_updated", leadId, before, { status: nextStatus });
      return Response.json(await leadSnapshot(leadId));
    }

    if (action === "save_development") {
      const developmentAt = dateOnly(body.developmentAt);
      const channel = text(body.channel, 30);
      const direction = text(body.direction, 20);
      const summary = text(body.summary, 8000);
      if (!developmentAt) return errorResponse("请选择开发日期。");
      if (!allowed(channel, LEAD_DEVELOPMENT_CHANNELS)) return errorResponse("开发渠道无效。");
      if (!allowed(direction, LEAD_DEVELOPMENT_TYPES)) return errorResponse("开发记录类型无效。");
      if (!summary) return errorResponse("请填写开发记录。");

      const currentTouches = await leadTouchCount(leadId);
      const touchNumber = direction === "outbound" ? currentTouches + 1 : null;
      const realReply = direction === "reply";
      const nextStatus = realReply
        ? "replied_pending_conversion"
        : direction === "outbound" && before.status !== "replied_pending_conversion"
          ? "following_up"
          : String(before.status || "research_pending");
      const nextDate = realReply
        ? null
        : direction === "outbound"
          ? nextLeadTouchDate(developmentAt, touchNumber || 0) || null
          : before.next_follow_up_date || null;
      const historyId = crypto.randomUUID();
      await db.batch([
        db.prepare(
          `INSERT INTO lead_development_history
            (id, lead_id, development_at, channel, direction, summary, touch_number,
             real_reply, outcome, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          historyId, leadId, developmentAt, channel, direction, summary, touchNumber,
          realReply ? 1 : 0, nullable(body.outcome, 100), now, now,
        ),
        db.prepare(
          `UPDATE business_development_leads
           SET status = ?, next_follow_up_date = ?, updated_at = ? WHERE id = ?`,
        ).bind(nextStatus, nextDate, now, leadId),
        db.prepare(
          `INSERT INTO audit_logs
            (id, action, entity_type, entity_id, before_data, after_data, source)
           VALUES (?, 'lead_development_recorded', 'business_development_lead', ?, ?, ?, 'user')`,
        ).bind(
          crypto.randomUUID(), leadId, JSON.stringify(before),
          JSON.stringify({ historyId, direction, touchNumber, status: nextStatus, nextDate }),
        ),
      ]);
      return Response.json(await leadSnapshot(leadId));
    }

    if (action === "convert_to_potential") {
      if (before.status === "converted") return errorResponse("该 Lead 已转为潜在客户。", 409);
      const duplicates = await conversionDuplicates(before);
      if (duplicates.length && body.confirmDuplicate !== true) {
        return Response.json({
          error: "发现可能重复的客户，请确认后再转换。",
          code: "possible_duplicate",
          duplicates,
        }, { status: 409 });
      }
      const [contacts, history] = await Promise.all([
        db.prepare(`SELECT * FROM lead_contacts WHERE lead_id = ? ORDER BY is_primary DESC, created_at, id`)
          .bind(leadId).all<Row>(),
        db.prepare(`SELECT * FROM lead_development_history WHERE lead_id = ? ORDER BY development_at, created_at, id`)
          .bind(leadId).all<Row>(),
      ]);
      const customerId = crypto.randomUUID();
      const background = [
        before.why_worth_developing ? `主营 / 公司情况\n${before.why_worth_developing}` : "",
        before.existing_brands ? `现有品牌\n${before.existing_brands}` : "",
        before.relevant_products ? `相关产品\n${before.relevant_products}` : "",
        before.risk_doubt ? `备注\n${before.risk_doubt}` : "",
      ].filter(Boolean).join("\n\n");
      const statements = [
        db.prepare(
          `INSERT INTO customers
            (id, customer_code, company, lifecycle, grade, country, city, website,
             source, next_action, company_background_notes, source_lead_id,
             created_at, updated_at)
           VALUES (?, NULL, ?, 'potential_customer', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          customerId, before.company_name, nullable(before.country, 100), nullable(before.city, 100),
          nullable(before.website, 500), nullable(before.source, 300), nullable(before.next_step, 5000),
          background || null, leadId, now, now,
        ),
        ...contacts.results.map((contact) => db.prepare(
          `INSERT INTO contacts
            (id, customer_id, name, position, role, email, phone, whatsapp, wechat,
             linkedin, notes, is_primary, deleted_at, legacy_metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}', ?, ?)`,
        ).bind(
          crypto.randomUUID(), customerId, contact.name, contact.title, contact.title,
          contact.email, contact.phone, contact.whatsapp, contact.wechat, contact.linkedin,
          contact.note, Number(contact.is_primary || 0), now, now,
        )),
        ...history.results.map((entry) => db.prepare(
          `INSERT INTO customer_follow_ups
            (id, customer_id, follow_up_at, content, next_follow_up_date, channel, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(), customerId, entry.development_at, entry.summary,
          entry.channel, now, now,
        )),
        db.prepare(
          `INSERT INTO customer_status_history
            (id, customer_id, to_status, reason, source, created_at)
           VALUES (?, ?, 'potential_customer', 'Converted from Lead', 'user', ?)`,
        ).bind(crypto.randomUUID(), customerId, now),
        db.prepare(
          `UPDATE business_development_leads
           SET status = 'converted', updated_at = ? WHERE id = ?`,
        ).bind(now, leadId),
        db.prepare(
          `INSERT INTO audit_logs
            (id, action, entity_type, entity_id, before_data, after_data, source)
           VALUES (?, 'lead_converted_to_potential', 'business_development_lead', ?, ?, ?, 'user')`,
        ).bind(
          crypto.randomUUID(), leadId, JSON.stringify(before), JSON.stringify({ customerId }),
        ),
      ];
      await db.batch(statements);
      return Response.json({ ...(await leadSnapshot(leadId)), customerId });
    }

    if (action === "save_contact") {
      const contactId = text(body.contactId, 100) || crypto.randomUUID();
      const decisionMakerFit = text(body.decisionMakerFit, 20);
      if (decisionMakerFit && !allowed(decisionMakerFit, LEAD_DECISION_MAKER_FITS)) {
        return errorResponse("Decision Maker Fit 无效。");
      }
      const contact = contactPayload(body);
      if (contact.email) {
        const duplicateEmail = await db.prepare(
          `SELECT id FROM lead_contacts
           WHERE lead_id = ? AND lower(trim(email)) = lower(trim(?)) AND id <> ? LIMIT 1`,
        ).bind(leadId, contact.email, contactId).first<Row>();
        if (duplicateEmail) return errorResponse("该 Lead 已有相同 Email 的联系人。", 409);
      }
      const existing = await db.prepare("SELECT * FROM lead_contacts WHERE id = ? AND lead_id = ?")
        .bind(contactId, leadId).first<Row>();
      if (body.decisionMakerFit === undefined && existing) {
        contact.decisionMakerFit = text(existing.decision_maker_fit, 20);
      }
      const belongsToAnotherLead = await db.prepare(
        "SELECT id FROM lead_contacts WHERE id = ? AND lead_id <> ?",
      ).bind(contactId, leadId).first<Row>();
      if (belongsToAnotherLead) return errorResponse("联系人不属于该 Lead。", 409);
      const statements = [];
      if (contact.isPrimary) {
        statements.push(db.prepare("UPDATE lead_contacts SET is_primary = 0, updated_at = ? WHERE lead_id = ?")
          .bind(now, leadId));
      }
      statements.push(db.prepare(
        `INSERT INTO lead_contacts
          (id, lead_id, name, title, email, phone, whatsapp, wechat, linkedin, note,
           is_primary, decision_maker_fit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, title = excluded.title, email = excluded.email,
           phone = excluded.phone, whatsapp = excluded.whatsapp, wechat = excluded.wechat,
           linkedin = excluded.linkedin, note = excluded.note, is_primary = excluded.is_primary,
           decision_maker_fit = excluded.decision_maker_fit, updated_at = excluded.updated_at`,
      ).bind(
        contactId, leadId, nullable(contact.name, 300), nullable(contact.title, 300),
        nullable(contact.email, 300), nullable(contact.phone, 100), nullable(contact.whatsapp, 100),
        nullable(contact.wechat, 100), nullable(contact.linkedin, 500), nullable(contact.note, 5000),
        contact.isPrimary ? 1 : 0, nullable(contact.decisionMakerFit, 20), now, now,
      ));
      await db.batch(statements);
      await audit("lead_contact_saved", contactId, existing, contact);
      return Response.json(await leadSnapshot(leadId));
    }

    if (action === "delete_contact") {
      const contactId = text(body.contactId, 100);
      if (!contactId) return errorResponse("缺少联系人 ID。");
      const existing = await db.prepare("SELECT * FROM lead_contacts WHERE id = ? AND lead_id = ?")
        .bind(contactId, leadId).first<Row>();
      if (!existing) return errorResponse("联系人不存在。", 404);
      await db.prepare("DELETE FROM lead_contacts WHERE id = ? AND lead_id = ?")
        .bind(contactId, leadId).run();
      await audit("lead_contact_deleted", contactId, existing, null);
      return Response.json(await leadSnapshot(leadId));
    }

    return errorResponse("未知 Lead 操作。");
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Lead 保存失败。", 500);
  }
}
