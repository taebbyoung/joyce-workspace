import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
};

export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  customerCode: text("customer_code"),
  company: text("company").notNull(),
  lifecycle: text("lifecycle").notNull(),
  grade: text("grade"),
  purchaseIntent: text("purchase_intent"),
  purchaseAbility: text("purchase_ability"),
  ratingReason: text("rating_reason"),
  lastReviewedAt: text("last_reviewed_at"),
  country: text("country"),
  city: text("city"),
  address: text("address"),
  customerType: text("customer_type"),
  contact: text("contact"),
  email: text("email"),
  phone: text("phone"),
  website: text("website"),
  source: text("source"),
  nextAction: text("next_action"),
  lastFollow: text("last_follow"),
  nextFollow: text("next_follow"),
  strategy: text("strategy"),
  profile: text("profile"),
  companyBackgroundNotes: text("company_background_notes"),
  lastContactAt: text("last_contact_at"),
  legacyMetadata: text("legacy_metadata").notNull().default("{}"),
  legacyNotes: text("legacy_notes").notNull().default(""),
  deletedAt: text("deleted_at"),
  ...timestamps,
});

export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  customerId: text("customer_id").notNull(),
  name: text("name"),
  email: text("email"),
  phone: text("phone"),
  role: text("role"),
  position: text("position"),
  whatsapp: text("whatsapp"),
  wechat: text("wechat"),
  linkedin: text("linkedin"),
  notes: text("notes"),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  deletedAt: text("deleted_at"),
  legacyMetadata: text("legacy_metadata").notNull().default("{}"),
  ...timestamps,
});

export const customerMemory = sqliteTable("customer_memory", {
  customerId: text("customer_id").primaryKey(),
  birthday: text("birthday"),
  productPreference: text("product_preference"),
  communicationStyle: text("communication_style"),
  personality: text("personality"),
  whereMet: text("where_met"),
  relationshipNotes: text("relationship_notes"),
  importantPreferences: text("important_preferences"),
  ...timestamps,
});

export const customerCustomFields = sqliteTable("customer_custom_fields", {
  id: text("id").primaryKey(),
  customerId: text("customer_id").notNull(),
  label: text("label").notNull(),
  value: text("value"),
  sortOrder: integer("sort_order").notNull().default(0),
  deletedAt: text("deleted_at"),
  ...timestamps,
});

export const customerFollowUps = sqliteTable("customer_follow_ups", {
  id: text("id").primaryKey(),
  customerId: text("customer_id").notNull(),
  followUpAt: text("follow_up_at").notNull(),
  content: text("content").notNull(),
  nextFollowUpDate: text("next_follow_up_date"),
  channel: text("channel"),
  ...timestamps,
});

export const customerStatusHistory = sqliteTable("customer_status_history", {
  id: text("id").primaryKey(),
  customerId: text("customer_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  reason: text("reason"),
  source: text("source"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  customerId: text("customer_id"),
  customerCode: text("customer_code"),
  customerName: text("customer_name"),
  orderNo: text("order_no"),
  piNo: text("pi_no"),
  orderDate: text("order_date"),
  country: text("country"),
  model: text("model"),
  quantity: real("quantity"),
  originalCurrency: text("original_currency"),
  originalAmount: real("original_amount"),
  fixedExchangeRateToCny: real("fixed_exchange_rate_to_cny"),
  cnyAmount: real("cny_amount"),
  otherCosts: real("other_costs"),
  currencyStatus: text("currency_status").notNull().default("needs_confirmation"),
  paymentStatus: text("payment_status"),
  depositAmount: real("deposit_amount"),
  depositDate: text("deposit_date"),
  balanceAmount: real("balance_amount"),
  balanceExpectedDate: text("balance_expected_date"),
  balanceReceivedDate: text("balance_received_date"),
  productionStatus: text("production_status"),
  shipmentStatus: text("shipment_status"),
  orderStatus: text("order_status").notNull().default("active"),
  completedAt: text("completed_at"),
  expectedShippingDate: text("expected_shipping_date"),
  estimatedDeliveryDate: text("estimated_delivery_date"),
  progressNextStep: text("progress_next_step"),
  containerNumber: text("container_number"),
  blNumber: text("bl_number"),
  forwarder: text("forwarder"),
  vessel: text("vessel"),
  voyage: text("voyage"),
  etd: text("etd"),
  eta: text("eta"),
  port: text("port"),
  portOfLoading: text("port_of_loading"),
  portOfDischarge: text("port_of_discharge"),
  shippingCompany: text("shipping_company"),
  shippingMethod: text("shipping_method"),
  awbNumber: text("awb_number"),
  carrierCompany: text("carrier_company"),
  trackingNumber: text("tracking_number"),
  logisticsCompany: text("logistics_company"),
  logisticsNumber: text("logistics_number"),
  productionNotes: text("production_notes"),
  documents: text("documents").notNull().default("[]"),
  dueDate: text("due_date"),
  risk: text("risk"),
  notes: text("notes"),
  importBatchId: text("import_batch_id"),
  sourceType: text("source_type"),
  deletedAt: text("deleted_at"),
  legacyMetadata: text("legacy_metadata").notNull().default("{}"),
  ...timestamps,
});

export const orderItems = sqliteTable("order_items", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  productId: text("product_id"),
  description: text("description"),
  quantity: real("quantity"),
  unitPrice: real("unit_price"),
  legacyMetadata: text("legacy_metadata").notNull().default("{}"),
});

export const orderPayments = sqliteTable("order_payments", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  paymentType: text("payment_type").notNull(),
  paymentDate: text("payment_date").notNull(),
  amount: real("amount").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  legacyMetadata: text("legacy_metadata").notNull().default("{}"),
  ...timestamps,
});

export const orderDocuments = sqliteTable("order_documents", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  documentType: text("document_type").notNull().default("other"),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  sha256: text("sha256"),
  r2Key: text("r2_key").notNull(),
  recognitionStatus: text("recognition_status").notNull().default("not_requested"),
  recognitionJson: text("recognition_json"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const accessorySalesTotals = sqliteTable("accessory_sales_totals", {
  id: text("id").primaryKey(),
  salesYear: integer("sales_year").notNull().unique(),
  amountCny: real("amount_cny").notNull().default(0),
  ...timestamps,
});

export const orderRisks = sqliteTable("order_risks", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  riskLevel: text("risk_level").notNull(),
  title: text("title").notNull(),
  reason: text("reason").notNull(),
  recommendedAction: text("recommended_action"),
  evidenceSource: text("evidence_source").notNull(),
  triggerType: text("trigger_type").notNull(),
  status: text("status").notNull().default("active"),
  detectedAt: text("detected_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  acknowledgedAt: text("acknowledged_at"),
  acknowledgedBy: text("acknowledged_by"),
});

export const orderStatusHistory = sqliteTable("order_status_history", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  fieldName: text("field_name").notNull(),
  fromValue: text("from_value"),
  toValue: text("to_value"),
  evidence: text("evidence"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  status: text("status").notNull().default("待处理"),
  priority: text("priority").notNull().default("中"),
  dueDate: text("due_date"),
  nextActionDate: text("next_action_date"),
  reminderDate: text("reminder_date"),
  snoozedUntil: text("snoozed_until"),
  recurrenceRule: text("recurrence_rule").notNull().default("none"),
  completedAt: text("completed_at"),
  cancelledAt: text("cancelled_at"),
  archivedAt: text("archived_at"),
  deletedAt: text("deleted_at"),
  purgeAfter: text("purge_after"),
  customerId: text("customer_id"),
  orderId: text("order_id"),
  afterSalesCaseId: text("after_sales_case_id"),
  projectId: text("project_id"),
  nextAction: text("next_action"),
  notes: text("notes"),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  workSortOrder: integer("work_sort_order").notNull().default(0),
  priorityReason: text("priority_reason"),
  prioritySource: text("priority_source"),
  priorityRankedAt: text("priority_ranked_at"),
  legacyMetadata: text("legacy_metadata").notNull().default("{}"),
  ...timestamps,
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  status: text("status").notNull().default("进行中"),
  progress: integer("progress").notNull().default(0),
  nextStep: text("next_step"),
  notes: text("notes"),
  completedAt: text("completed_at"),
  finalResult: text("final_result"),
  workSortOrder: integer("work_sort_order").notNull().default(0),
  priorityReason: text("priority_reason"),
  prioritySource: text("priority_source"),
  priorityRankedAt: text("priority_ranked_at"),
  legacyMetadata: text("legacy_metadata").notNull().default("{}"),
  ...timestamps,
});

export const afterSalesCases = sqliteTable("after_sales_cases", {
  id: text("id").primaryKey(),
  customerId: text("customer_id"),
  customerCode: text("customer_code"),
  code: text("code"),
  caseTitle: text("case_title"),
  vehicleModel: text("vehicle_model"),
  orderNo: text("order_no"),
  vin: text("vin"),
  faultDate: text("fault_date"),
  tags: text("tags").notNull().default("[]"),
  issueDescription: text("issue_description"),
  troubleshootingProcess: text("troubleshooting_process"),
  confirmedCause: text("confirmed_cause"),
  reuseSolution: text("reuse_solution"),
  fullTechnicalReport: text("full_technical_report"),
  category: text("category"),
  priority: text("priority"),
  status: text("status").notNull().default("待处理"),
  originalCustomerDescription: text("original_customer_description"),
  evidence: text("evidence"),
  diagnosis: text("diagnosis"),
  engineeringResponse: text("engineering_response"),
  actionsTaken: text("actions_taken"),
  partsSent: text("parts_sent"),
  resolution: text("resolution"),
  legacyMetadata: text("legacy_metadata").notNull().default("{}"),
  ...timestamps,
});

export const timelineEvents = sqliteTable("timeline_events", {
  id: text("id").primaryKey(),
  customerId: text("customer_id").notNull(),
  eventType: text("event_type").notNull(),
  title: text("title").notNull(),
  content: text("content"),
  occurredAt: text("occurred_at").notNull(),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  evidence: text("evidence"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  model: text("model").notNull(),
  category: text("category"),
  positioning: text("positioning"),
  battery: text("battery"),
  motor: text("motor"),
  certification: text("certification"),
  keyFeatures: text("key_features"),
  market: text("market"),
  authorityStatus: text("authority_status").notNull().default("needs_review"),
  legacyMetadata: text("legacy_metadata").notNull().default("{}"),
  ...timestamps,
});

export const sourceDocuments = sqliteTable("source_documents", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  fileName: text("file_name").notNull(),
  documentType: text("document_type").notNull(),
  productId: text("product_id"),
  version: text("version"),
  versionStatus: text("version_status").notNull().default("current"),
  authority: text("authority").notNull(),
  reviewStatus: text("review_status").notNull().default("needs_review"),
  joyceApproved: integer("joyce_approved", { mode: "boolean" })
    .notNull()
    .default(false),
  r2Key: text("r2_key"),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  sha256: text("sha256"),
  indexingStatus: text("indexing_status").notNull().default("not_indexed"),
  legacyMetadata: text("legacy_metadata").notNull().default("{}"),
  ...timestamps,
});

export const documentChunks = sqliteTable("document_chunks", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  pageNumber: integer("page_number"),
  section: text("section"),
  content: text("content").notNull(),
  authority: text("authority").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const knowledgeItems = sqliteTable("knowledge_items", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  category: text("category"),
  categories: text("categories").notNull().default("[]"),
  tags: text("tags").notNull().default("[]"),
  source: text("source"),
  sourceName: text("source_name"),
  sourceUrl: text("source_url"),
  sourceNotes: text("source_notes"),
  summary: text("summary"),
  essenceSummary: text("essence_summary"),
  essencePoints: text("essence_points").notNull().default("[]"),
  corePrinciples: text("core_principles").notNull().default("[]"),
  actionableTactics: text("actionable_tactics").notNull().default("[]"),
  applicableScenarios: text("applicable_scenarios").notNull().default("[]"),
  applicableSituations: text("applicable_situations"),
  originalText: text("original_text").notNull(),
  originalSourceType: text("original_source_type"),
  originalSourceRecordId: text("original_source_record_id"),
  userEditedFields: text("user_edited_fields").notNull().default("[]"),
  contentModifiedAt: text("content_modified_at"),
  aiProcessingStatus: text("ai_processing_status")
    .notNull()
    .default("source_only"),
  humanReviewStatus: text("human_review_status")
    .notNull()
    .default("pending_review"),
  processedAt: text("processed_at"),
  reviewedAt: text("reviewed_at"),
  reviewStatus: text("review_status").notNull().default("needs_review"),
  joyceApproved: integer("joyce_approved", { mode: "boolean" })
    .notNull()
    .default(false),
  legacyMetadata: text("legacy_metadata").notNull().default("{}"),
  ...timestamps,
});

export const salesPlaybookItems = sqliteTable("sales_playbook_items", {
  id: text("id").primaryKey(),
  sourceDocumentId: text("source_document_id"),
  knowledgeItemId: text("knowledge_item_id"),
  title: text("title"),
  principles: text("principles").notNull().default("[]"),
  createdFrom: text("created_from"),
  approvedBy: text("approved_by"),
  approvedAt: text("approved_at"),
  category: text("category"),
  summary: text("summary").notNull(),
  applicableScenarios: text("applicable_scenarios"),
  reviewStatus: text("review_status").notNull().default("needs_review"),
  joyceApproved: integer("joyce_approved", { mode: "boolean" })
    .notNull()
    .default(false),
  evidence: text("evidence"),
  ...timestamps,
});

export const inboxEntries = sqliteTable("inbox_entries", {
  id: text("id").primaryKey(),
  originalInput: text("original_input").notNull(),
  structuredSummary: text("structured_summary"),
  classificationStatus: text("classification_status")
    .notNull()
    .default("pending"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const aiActions = sqliteTable("ai_actions", {
  id: text("id").primaryKey(),
  inboxEntryId: text("inbox_entry_id"),
  originalInput: text("original_input").notNull(),
  parsedInterpretation: text("parsed_interpretation").notNull(),
  proposedAction: text("proposed_action").notNull(),
  riskLevel: integer("risk_level").notNull(),
  confirmationStatus: text("confirmation_status").notNull(),
  resultingRecordType: text("resulting_record_type"),
  resultingRecordId: text("resulting_record_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const contentItems = sqliteTable("content_items", {
  id: text("id").primaryKey(),
  topic: text("topic").notNull(),
  platform: text("platform"),
  status: text("status").notNull().default("想法"),
  productId: text("product_id"),
  market: text("market"),
  draft: text("draft"),
  publishedDate: text("published_date"),
  sourceMaterial: text("source_material"),
  legacyMetadata: text("legacy_metadata").notNull().default("{}"),
  ...timestamps,
});

export const files = sqliteTable("files", {
  id: text("id").primaryKey(),
  r2Key: text("r2_key").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  sha256: text("sha256"),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const legacyRecords = sqliteTable("legacy_records", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id"),
  targetType: text("target_type"),
  targetId: text("target_id"),
  rawPayload: text("raw_payload").notNull(),
  payloadHash: text("payload_hash"),
  migrationStatus: text("migration_status").notNull(),
  reviewReason: text("review_reason"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  beforeData: text("before_data"),
  afterData: text("after_data"),
  source: text("source"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const workReports = sqliteTable("work_reports", {
  id: text("id").primaryKey(),
  reportType: text("report_type").notNull(),
  title: text("title").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  scopes: text("scopes").notNull().default("[]"),
  items: text("items").notNull().default("[]"),
  sourceSummary: text("source_summary").notNull().default("{}"),
  sourceDetails: text("source_details").notNull().default("[]"),
  versionOf: text("version_of"),
  confirmedAt: text("confirmed_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
