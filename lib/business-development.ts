export const LEAD_STATUSES = [
  "research_pending",
  "first_outreach_due",
  "waiting_reply",
  "following_up",
  "replied_pending_conversion",
  "converted",
  "paused",
  "abandoned",
] as const;

export const EDITABLE_LEAD_STATUSES = LEAD_STATUSES.filter(
  (status) => status !== "converted",
);

export const LEAD_PRIORITIES = ["High", "Medium", "Low"] as const;
export const LEAD_MARKET_FITS = ["High", "Medium", "Low"] as const;
export const LEAD_MOTO_EV_BUSINESSES = ["Confirmed", "Likely", "Unknown", "No"] as const;
export const LEAD_SOURCES = [
  "Online Prospecting",
  "Exhibition List",
  "Exhibition Contact",
  "Info Inquiry",
  "Referral",
  "Manual",
  "Other",
] as const;
export const LEAD_COMPANY_TYPES = [
  "Importer",
  "Distributor",
  "Dealer",
  "Brand",
  "Retailer",
  "Rental / Fleet",
  "E-commerce",
  "Other",
] as const;
export const LEAD_DECISION_MAKER_FITS = ["High", "Medium", "Low"] as const;

export const LEAD_ACTIVE_STATUSES = [
  "research_pending",
  "first_outreach_due",
  "waiting_reply",
  "following_up",
  "replied_pending_conversion",
] as const;

export const LEAD_DEVELOPMENT_CHANNELS = [
  "Email",
  "WhatsApp",
  "LinkedIn",
  "Phone",
  "Video",
  "Exhibition",
  "Other",
] as const;

export const LEAD_DEVELOPMENT_TYPES = ["outbound", "reply", "note"] as const;

// Touch 1 happens on Day 0. Each following interval is based on the actual
// date of the preceding outbound touch, not the Lead creation date.
export const LEAD_TOUCH_CADENCE_DAYS = [0, 4, 7, 14, 25, 35, 45, 50] as const;

export const leadStatusLabels: Record<(typeof LEAD_STATUSES)[number], string> = {
  research_pending: "待研究",
  first_outreach_due: "待首次开发",
  waiting_reply: "开发中",
  following_up: "开发中",
  replied_pending_conversion: "已回复·待转 Potential",
  converted: "已转 Potential",
  paused: "暂停",
  abandoned: "放弃",
};

export function isActiveLeadStatus(value: unknown) {
  return (LEAD_ACTIVE_STATUSES as readonly string[]).includes(text(value));
}

export function isDevelopingLeadStatus(value: unknown) {
  return ["waiting_reply", "following_up"].includes(text(value));
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

export function normalizeLeadName(value: unknown) {
  return text(value)
    .toLowerCase()
    .replace(/[.,'"()\[\]{}]/g, " ")
    .replace(/\b(gmbh|ltd|limited|llc|inc|s\.l\.?|b\.v\.?|s\.r\.l\.?|oy|ab)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function websiteDomain(value: unknown) {
  const raw = text(value);
  if (!raw) return "";
  try {
    const hostname = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname
      .toLowerCase()
      .replace(/^www\./, "");
    return hostname;
  } catch {
    return "";
  }
}

export function dateOnly(value: unknown) {
  const candidate = text(value).slice(0, 10);
  if (!candidate) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return "";
  const [year, month, day] = candidate.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? candidate
    : "";
}

export function addLeadDateDays(value: unknown, days: number) {
  const date = dateOnly(value);
  if (!date || !Number.isInteger(days)) return "";
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

export function nextLeadTouchDate(actualDate: unknown, completedTouchCount: number) {
  if (!Number.isInteger(completedTouchCount) || completedTouchCount < 1) return "";
  const interval = LEAD_TOUCH_CADENCE_DAYS[completedTouchCount];
  return interval === undefined ? "" : addLeadDateDays(actualDate, interval);
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T, fallback = "") {
  const candidate = text(value);
  return allowed.includes(candidate) ? candidate : fallback;
}

export function leadPayload(value: Record<string, unknown>) {
  const companyName = text(value.companyName).slice(0, 300);
  const website = text(value.website).slice(0, 500);
  const nextFollowUpDate = value.nextFollowUpDate === undefined
    ? undefined
    : dateOnly(value.nextFollowUpDate);
  return {
    companyName,
    normalizedName: normalizeLeadName(companyName),
    country: text(value.country).slice(0, 100),
    city: text(value.city).slice(0, 100),
    website,
    websiteDomain: websiteDomain(website),
    linkedinCompany: text(value.linkedinCompany).slice(0, 500),
    source: enumValue(value.source, LEAD_SOURCES, "Manual"),
    companyType: enumValue(value.companyType, LEAD_COMPANY_TYPES),
    motoEvBusiness: enumValue(value.motoEvBusiness, LEAD_MOTO_EV_BUSINESSES, "Unknown"),
    existingBrands: text(value.existingBrands).slice(0, 3000),
    relevantProducts: text(value.relevantProducts).slice(0, 3000),
    targetModels: text(value.targetModels).slice(0, 1000),
    marketFit: enumValue(value.marketFit, LEAD_MARKET_FITS),
    priority: enumValue(value.priority, LEAD_PRIORITIES, "Medium"),
    whyWorthDeveloping: text(value.whyWorthDeveloping).slice(0, 8000),
    riskDoubt: text(value.riskDoubt).slice(0, 8000),
    status: enumValue(value.status, EDITABLE_LEAD_STATUSES, "research_pending"),
    nextFollowUpDate,
    nextStep: text(value.nextStep).slice(0, 5000),
  };
}

export function leadSortKey(row: Record<string, unknown>, today: string) {
  const status = text(row.status);
  const next = dateOnly(row.next_follow_up_date);
  const priority = text(row.priority);
  const active = isActiveLeadStatus(status);
  const statusRank = active && next && next < today
    ? 0
    : active && next === today
      ? 1
      : status === "replied_pending_conversion"
        ? 2
        : status === "first_outreach_due"
          ? 3
          : active && next
            ? 4
            : status === "research_pending"
              ? 5
              : active
                ? 6
                : 7;
  const priorityRank = priority === "High" ? 0 : priority === "Medium" ? 1 : 2;
  return [statusRank, priorityRank, next || "9999-12-31", text(row.created_at) || "9999-12-31", text(row.id)];
}

export function sortLeads<T extends Record<string, unknown>>(rows: T[], today: string) {
  return [...rows].sort((left, right) => {
    const leftKey = leadSortKey(left, today);
    const rightKey = leadSortKey(right, today);
    for (let index = 0; index < leftKey.length; index += 1) {
      if (leftKey[index] < rightKey[index]) return -1;
      if (leftKey[index] > rightKey[index]) return 1;
    }
    return 0;
  });
}
