export type KnowledgeArchiveDraft = {
  title: string;
  categories: string[];
  tags: string[];
  essenceSummary: string;
  corePrinciples: string[];
  actionableTactics: string[];
  applicableScenarios: string[];
  originalText: string;
  sourceName: string;
  sourceUrl: string;
};

export type TechnicalCaseArchiveDraft = {
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

type SectionMap = Record<string, string>;

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n?/g, "\n").trim();
}

function splitSections(
  input: string,
  headings: Record<string, string>,
): { sections: SectionMap; matched: number } {
  const source = normalizeLineEndings(input);
  const sections: SectionMap = {};
  let current = "";
  let matched = 0;
  for (const line of source.split("\n")) {
    const heading = line.trim().match(/^【([^】]+)】\s*(.*)$/);
    if (heading) {
      const key = headings[heading[1].trim()];
      if (key) {
        current = key;
        matched += 1;
        sections[current] = heading[2] || "";
        continue;
      }
    }
    if (!current) continue;
    sections[current] = sections[current]
      ? `${sections[current]}\n${line}`
      : line;
  }
  for (const key of Object.keys(sections)) {
    sections[key] = sections[key].trim();
  }
  return { sections, matched };
}

function listValues(value = "") {
  return [...new Set(
    normalizeLineEndings(value)
      .split(/\n|[,，、]/)
      .map((item) =>
        item
          .replace(/^\s*(?:[-*•·]|(?:\d+|[一二三四五六七八九十]+)[.、）)])\s*/, "")
          .trim(),
      )
      .filter(Boolean),
  )];
}

function sourceValues(value = "") {
  const lines = normalizeLineEndings(value).split("\n").filter(Boolean);
  const urlLine = lines.find((line) => /^https?:\/\/\S+$/i.test(line.trim()));
  return {
    sourceName: lines.filter((line) => line !== urlLine).join("\n").trim(),
    sourceUrl: urlLine?.trim() || "",
  };
}

export function parseKnowledgeArchive(input: string) {
  const { sections, matched } = splitSections(input, {
    标题: "title",
    分类标签: "classification",
    分类: "classification",
    标签: "tags",
    精华提炼: "essenceSummary",
    核心原则: "corePrinciples",
    可执行技巧: "actionableTactics",
    适用场景: "applicableScenarios",
    完整原文: "originalText",
    来源: "source",
  });
  if (matched < 2) return null;
  const source = sourceValues(sections.source);
  const classification = listValues(sections.classification);
  return {
    title: sections.title || "",
    categories: classification,
    tags: listValues(sections.tags),
    essenceSummary: sections.essenceSummary || "",
    corePrinciples: listValues(sections.corePrinciples),
    actionableTactics: listValues(sections.actionableTactics),
    applicableScenarios: listValues(sections.applicableScenarios),
    originalText: sections.originalText || "",
    ...source,
  } satisfies KnowledgeArchiveDraft;
}

export function parseTechnicalCaseArchive(input: string) {
  const { sections, matched } = splitSections(input, {
    案例标题: "caseTitle",
    客户代码: "customerCode",
    "车型/版本": "vehicleModel",
    订单号: "orderNo",
    VIN: "vin",
    故障日期: "faultDate",
    标签: "tags",
    故障现象: "faultSymptoms",
    排查过程: "troubleshootingProcess",
    确认原因: "confirmedCause",
    解决及复用方法: "reuseSolution",
    完整技术报告: "fullTechnicalReport",
  });
  if (matched < 2) return null;
  return {
    caseTitle: sections.caseTitle || "",
    customerCode: sections.customerCode || "",
    vehicleModel: sections.vehicleModel || "",
    orderNo: sections.orderNo || "",
    vin: sections.vin || "",
    faultDate: /^\d{4}-\d{2}-\d{2}$/.test(sections.faultDate || "")
      ? sections.faultDate
      : "",
    tags: listValues(sections.tags),
    faultSymptoms: sections.faultSymptoms || "",
    troubleshootingProcess: sections.troubleshootingProcess || "",
    confirmedCause: sections.confirmedCause || "",
    reuseSolution: sections.reuseSolution || "",
    fullTechnicalReport: sections.fullTechnicalReport || "",
  } satisfies TechnicalCaseArchiveDraft;
}
