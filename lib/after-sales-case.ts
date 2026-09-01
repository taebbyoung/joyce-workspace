export type TechnicalCaseDraft = {
  caseTitle: string;
  customerCode: string;
  vehicleModel: string;
  orderNo: string;
  vin: string;
  faultDate: string;
  tags: string[];
  faultSymptoms: string;
  troubleshootingProcess: string;
  confirmedCause: string;
  reuseSolution: string;
  fullTechnicalReport: string;
};

const genericTags = new Set([
  "售后",
  "技术",
  "售后技术",
  "车辆",
  "车辆故障",
  "故障",
  "问题",
  "案例",
]);

function stringValue(value: unknown, max = 20_000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizeTechnicalCaseExtraction(
  value: unknown,
  fullReport: string,
): TechnicalCaseDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const tags = Array.isArray(row.tags)
    ? [...new Set(
        row.tags
          .map((tag) => stringValue(tag, 60))
          .filter((tag) => tag && !genericTags.has(tag)),
      )].slice(0, 8)
    : [];
  const result = {
    caseTitle: stringValue(row.case_title, 180),
    customerCode: stringValue(row.customer_code, 40),
    vehicleModel: stringValue(row.vehicle_model, 120),
    orderNo: stringValue(row.order_no, 100),
    vin: stringValue(row.vin, 100),
    faultDate: /^\d{4}-\d{2}-\d{2}$/.test(stringValue(row.fault_date, 10))
      ? stringValue(row.fault_date, 10)
      : "",
    tags,
    faultSymptoms: stringValue(row.fault_symptoms),
    troubleshootingProcess: stringValue(row.troubleshooting_process),
    confirmedCause:
      row.cause_confirmed === true ? stringValue(row.confirmed_cause) : "",
    reuseSolution: stringValue(row.reuse_solution),
    fullTechnicalReport: fullReport.trim(),
  };
  return result.fullTechnicalReport ? result : null;
}

export function parseTechnicalCaseTags(value: unknown) {
  if (Array.isArray(value)) {
    return [...new Set(
      value.map((tag) => stringValue(tag, 60)).filter(Boolean),
    )].slice(0, 20);
  }
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed)
      ? [...new Set(parsed.map((tag) => stringValue(tag, 60)).filter(Boolean))]
          .slice(0, 20)
      : [];
  } catch {
    return [];
  }
}
