import { env } from "cloudflare:workers";

type WorkspaceEnv = {
  DB?: D1Database;
  FILES?: R2Bucket;
  AI_PROVIDER?: string;
  AI_FALLBACK_PROVIDER?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_DEFAULT_MODEL?: string;
  DEEPSEEK_REASONING_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_REASONING_MODEL?: string;
};

const runtimeEnv = env as unknown as WorkspaceEnv;

export function getD1() {
  if (!runtimeEnv.DB) {
    throw new Error("D1 binding DB is unavailable.");
  }
  return runtimeEnv.DB;
}

export function getFilesBucket() {
  if (!runtimeEnv.FILES) {
    throw new Error("R2 binding FILES is unavailable.");
  }
  return runtimeEnv.FILES;
}

export function getAiEnvironment() {
  return {
    provider: runtimeEnv.AI_PROVIDER === "deepseek" ? "deepseek" : "gemini",
    fallbackProvider:
      runtimeEnv.AI_FALLBACK_PROVIDER === "gemini" ? "gemini" : "none",
    deepseek: {
      apiKey: runtimeEnv.DEEPSEEK_API_KEY ?? "",
      baseUrl: runtimeEnv.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      defaultModel: runtimeEnv.DEEPSEEK_DEFAULT_MODEL ?? "deepseek-v4-flash",
      reasoningModel: runtimeEnv.DEEPSEEK_REASONING_MODEL ?? "deepseek-v4-pro",
    },
    gemini: {
      apiKey: runtimeEnv.GEMINI_API_KEY ?? "",
      defaultModel: runtimeEnv.GEMINI_MODEL ?? "gemini-3.6-flash",
      reasoningModel:
        runtimeEnv.GEMINI_REASONING_MODEL ?? runtimeEnv.GEMINI_MODEL ?? "gemini-3.6-flash",
    },
  };
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    customer_code TEXT,
    company TEXT NOT NULL,
    lifecycle TEXT NOT NULL,
    grade TEXT,
    purchase_intent TEXT,
    purchase_ability TEXT,
    rating_reason TEXT,
    last_reviewed_at TEXT,
    country TEXT,
    city TEXT,
    address TEXT,
    customer_type TEXT,
    contact TEXT,
    email TEXT,
    phone TEXT,
    website TEXT,
    source TEXT,
    next_action TEXT,
    last_follow TEXT,
    next_follow TEXT,
    strategy TEXT,
    profile TEXT,
    company_background_notes TEXT,
    last_contact_at TEXT,
    legacy_metadata TEXT NOT NULL DEFAULT '{}',
    legacy_notes TEXT NOT NULL DEFAULT '',
    source_lead_id TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS customers_lifecycle_idx ON customers(lifecycle)`,
  `CREATE INDEX IF NOT EXISTS customers_code_idx ON customers(customer_code)`,
  `CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    name TEXT,
    email TEXT,
    phone TEXT,
    role TEXT,
    position TEXT,
    whatsapp TEXT,
    wechat TEXT,
    linkedin TEXT,
    notes TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    legacy_metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS customer_memory (
    customer_id TEXT PRIMARY KEY,
    birthday TEXT,
    product_preference TEXT,
    communication_style TEXT,
    personality TEXT,
    where_met TEXT,
    relationship_notes TEXT,
    important_preferences TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS customer_custom_fields (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    label TEXT NOT NULL,
    value TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS customer_follow_ups (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    follow_up_at TEXT NOT NULL,
    content TEXT NOT NULL,
    next_follow_up_date TEXT,
    channel TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS customer_follow_ups_customer_time_idx
    ON customer_follow_ups(customer_id, follow_up_at DESC)`,
  `CREATE TABLE IF NOT EXISTS business_development_leads (
    id TEXT PRIMARY KEY,
    company_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    country TEXT NOT NULL,
    city TEXT,
    website TEXT,
    website_domain TEXT,
    linkedin_company TEXT,
    source TEXT NOT NULL DEFAULT 'Manual',
    company_type TEXT,
    moto_ev_business TEXT NOT NULL DEFAULT 'Unknown',
    existing_brands TEXT,
    relevant_products TEXT,
    target_models TEXT,
    market_fit TEXT,
    priority TEXT NOT NULL DEFAULT 'Medium',
    why_worth_developing TEXT,
    risk_doubt TEXT,
    status TEXT NOT NULL DEFAULT 'research_pending',
    next_follow_up_date TEXT,
    next_step TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS business_development_leads_status_idx
    ON business_development_leads(status, next_follow_up_date)`,
  `CREATE INDEX IF NOT EXISTS business_development_leads_priority_idx
    ON business_development_leads(priority, created_at)`,
  `CREATE INDEX IF NOT EXISTS business_development_leads_country_idx
    ON business_development_leads(country)`,
  `CREATE TABLE IF NOT EXISTS lead_contacts (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    name TEXT,
    title TEXT,
    email TEXT,
    phone TEXT,
    whatsapp TEXT,
    wechat TEXT,
    linkedin TEXT,
    note TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0,
    decision_maker_fit TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS lead_contacts_lead_idx
    ON lead_contacts(lead_id, is_primary, created_at)`,
  `CREATE TABLE IF NOT EXISTS lead_development_history (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    development_at TEXT NOT NULL,
    channel TEXT NOT NULL,
    direction TEXT NOT NULL,
    summary TEXT NOT NULL,
    touch_number INTEGER,
    real_reply INTEGER NOT NULL DEFAULT 0,
    outcome TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS lead_development_history_lead_time_idx
    ON lead_development_history(lead_id, development_at DESC, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS customer_status_history (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_id TEXT,
    customer_code TEXT,
    customer_name TEXT,
    order_no TEXT,
    pi_no TEXT,
    order_date TEXT,
    country TEXT,
    model TEXT,
    quantity REAL,
    original_currency TEXT,
    original_amount REAL,
    fixed_exchange_rate_to_cny REAL,
    cny_amount REAL,
    other_costs REAL,
    currency_status TEXT NOT NULL DEFAULT 'needs_confirmation',
    payment_status TEXT,
    deposit_amount REAL,
    deposit_date TEXT,
    balance_amount REAL,
    balance_expected_date TEXT,
    balance_received_date TEXT,
    production_status TEXT,
    shipment_status TEXT,
    order_status TEXT NOT NULL DEFAULT 'active',
    completed_at TEXT,
    expected_shipping_date TEXT,
    estimated_delivery_date TEXT,
    progress_next_step TEXT,
    container_number TEXT,
    bl_number TEXT,
    forwarder TEXT,
    vessel TEXT,
    voyage TEXT,
    etd TEXT,
    eta TEXT,
    port TEXT,
    port_of_loading TEXT,
    port_of_discharge TEXT,
    shipping_company TEXT,
    shipping_method TEXT,
    awb_number TEXT,
    carrier_company TEXT,
    tracking_number TEXT,
    logistics_company TEXT,
    logistics_number TEXT,
    production_notes TEXT,
    documents TEXT NOT NULL DEFAULT '[]',
    due_date TEXT,
    risk TEXT,
    notes TEXT,
    import_batch_id TEXT,
    source_type TEXT,
    deleted_at TEXT,
    legacy_metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders(customer_id)`,
  `CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    product_id TEXT,
    description TEXT,
    quantity REAL,
    unit_price REAL,
    legacy_metadata TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id)`,
  `CREATE TABLE IF NOT EXISTS order_shipments (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    batch_no INTEGER NOT NULL,
    batch_name TEXT,
    shipping_method TEXT,
    shipment_status TEXT NOT NULL DEFAULT 'not_arranged',
    expected_shipping_date TEXT,
    actual_shipping_date TEXT,
    estimated_delivery_date TEXT,
    container_number TEXT,
    bl_number TEXT,
    awb_number TEXT,
    carrier_company TEXT,
    tracking_number TEXT,
    logistics_company TEXT,
    logistics_number TEXT,
    shipping_company TEXT,
    forwarder TEXT,
    vessel TEXT,
    voyage TEXT,
    port_of_loading TEXT,
    port_of_discharge TEXT,
    eta TEXT,
    notes TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS order_shipments_order_batch_idx
    ON order_shipments(order_id, batch_no)`,
  `CREATE INDEX IF NOT EXISTS order_shipments_order_sort_idx
    ON order_shipments(order_id, sort_order, batch_no)`,
  `CREATE TABLE IF NOT EXISTS order_shipment_items (
    id TEXT PRIMARY KEY,
    shipment_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    order_item_id TEXT NOT NULL,
    quantity REAL NOT NULL CHECK (quantity > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS order_shipment_items_shipment_item_idx
    ON order_shipment_items(shipment_id, order_item_id)`,
  `CREATE INDEX IF NOT EXISTS order_shipment_items_order_idx
    ON order_shipment_items(order_id, order_item_id)`,
  `CREATE TRIGGER IF NOT EXISTS order_shipment_items_validate_insert
    BEFORE INSERT ON order_shipment_items
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM order_shipments s WHERE s.id = NEW.shipment_id AND s.order_id = NEW.order_id)
          THEN RAISE(ABORT, 'shipment_order_mismatch')
        WHEN NOT EXISTS (SELECT 1 FROM order_items i WHERE i.id = NEW.order_item_id AND i.order_id = NEW.order_id)
          THEN RAISE(ABORT, 'shipment_item_order_mismatch')
        WHEN COALESCE((SELECT SUM(si.quantity) FROM order_shipment_items si WHERE si.order_item_id = NEW.order_item_id), 0) + NEW.quantity
          > COALESCE((SELECT i.quantity FROM order_items i WHERE i.id = NEW.order_item_id), 0)
          THEN RAISE(ABORT, 'shipment_quantity_exceeds_ordered')
      END;
    END`,
  `CREATE TRIGGER IF NOT EXISTS order_shipment_items_validate_update
    BEFORE UPDATE ON order_shipment_items
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM order_shipments s WHERE s.id = NEW.shipment_id AND s.order_id = NEW.order_id)
          THEN RAISE(ABORT, 'shipment_order_mismatch')
        WHEN NOT EXISTS (SELECT 1 FROM order_items i WHERE i.id = NEW.order_item_id AND i.order_id = NEW.order_id)
          THEN RAISE(ABORT, 'shipment_item_order_mismatch')
        WHEN COALESCE((SELECT SUM(si.quantity) FROM order_shipment_items si WHERE si.order_item_id = NEW.order_item_id AND si.id <> OLD.id), 0) + NEW.quantity
          > COALESCE((SELECT i.quantity FROM order_items i WHERE i.id = NEW.order_item_id), 0)
          THEN RAISE(ABORT, 'shipment_quantity_exceeds_ordered')
      END;
    END`,
  `CREATE TRIGGER IF NOT EXISTS order_items_protect_allocated_update
    BEFORE UPDATE OF quantity ON order_items
    WHEN NEW.quantity < COALESCE((SELECT SUM(si.quantity) FROM order_shipment_items si WHERE si.order_item_id = OLD.id), 0)
    BEGIN
      SELECT RAISE(ABORT, 'order_item_quantity_below_allocated');
    END`,
  `CREATE TRIGGER IF NOT EXISTS order_items_protect_allocated_delete
    BEFORE DELETE ON order_items
    WHEN EXISTS (SELECT 1 FROM order_shipment_items si WHERE si.order_item_id = OLD.id)
    BEGIN
      SELECT RAISE(ABORT, 'order_item_has_shipment_allocations');
    END`,
  `CREATE TABLE IF NOT EXISTS order_payments (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    payment_type TEXT NOT NULL,
    payment_date TEXT NOT NULL,
    amount REAL NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    legacy_metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS order_payments_order_type_date_idx
    ON order_payments(order_id, payment_type, payment_date, sort_order)`,
  `CREATE TABLE IF NOT EXISTS order_documents (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    document_type TEXT NOT NULL DEFAULT 'other',
    file_name TEXT NOT NULL,
    mime_type TEXT,
    file_size INTEGER,
    sha256 TEXT,
    r2_key TEXT NOT NULL,
    recognition_status TEXT NOT NULL DEFAULT 'not_requested',
    recognition_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS accessory_sales_totals (
    id TEXT PRIMARY KEY,
    sales_year INTEGER NOT NULL UNIQUE,
    amount_cny REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS accessory_sales_year_idx
    ON accessory_sales_totals(sales_year)`,
  `CREATE INDEX IF NOT EXISTS order_documents_order_idx
    ON order_documents(order_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS order_risks (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    title TEXT NOT NULL,
    reason TEXT NOT NULL,
    recommended_action TEXT,
    evidence_source TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    acknowledged_at TEXT,
    acknowledged_by TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS order_risks_order_idx
    ON order_risks(order_id, status, risk_level)`,
  `CREATE TABLE IF NOT EXISTS order_status_history (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    field_name TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    evidence TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS order_status_history_order_idx
    ON order_status_history(order_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '待处理',
    priority TEXT NOT NULL DEFAULT '中',
    due_date TEXT,
    next_action_date TEXT,
    reminder_date TEXT,
    snoozed_until TEXT,
    recurrence_rule TEXT NOT NULL DEFAULT 'none',
    completed_at TEXT,
    cancelled_at TEXT,
    archived_at TEXT,
    deleted_at TEXT,
    purge_after TEXT,
    customer_id TEXT,
    order_id TEXT,
    after_sales_case_id TEXT,
    project_id TEXT,
    next_action TEXT,
    notes TEXT,
    source_type TEXT,
    source_id TEXT,
    work_sort_order INTEGER NOT NULL DEFAULT 0,
    priority_reason TEXT,
    priority_source TEXT,
    priority_ranked_at TEXT,
    legacy_metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks(due_date, status)`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '进行中',
    progress INTEGER NOT NULL DEFAULT 0,
    next_step TEXT,
    notes TEXT,
    completed_at TEXT,
    final_result TEXT,
    work_sort_order INTEGER NOT NULL DEFAULT 0,
    priority_reason TEXT,
    priority_source TEXT,
    priority_ranked_at TEXT,
    legacy_metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS after_sales_cases (
    id TEXT PRIMARY KEY,
    customer_id TEXT,
    customer_code TEXT,
    code TEXT,
    vehicle_model TEXT,
    vin TEXT,
    issue_description TEXT,
    category TEXT,
    priority TEXT,
    status TEXT NOT NULL DEFAULT '待处理',
    original_customer_description TEXT,
    evidence TEXT,
    diagnosis TEXT,
    engineering_response TEXT,
    actions_taken TEXT,
    parts_sent TEXT,
    resolution TEXT,
    legacy_metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS timeline_events (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    occurred_at TEXT NOT NULL,
    source_type TEXT,
    source_id TEXT,
    evidence TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS timeline_customer_idx ON timeline_events(customer_id, occurred_at)`,
  `CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    category TEXT,
    positioning TEXT,
    battery TEXT,
    motor TEXT,
    certification TEXT,
    key_features TEXT,
    market TEXT,
    authority_status TEXT NOT NULL DEFAULT 'needs_review',
    legacy_metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS source_documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    file_name TEXT NOT NULL,
    document_type TEXT NOT NULL,
    product_id TEXT,
    version TEXT,
    version_status TEXT NOT NULL DEFAULT 'current',
    authority TEXT NOT NULL,
    review_status TEXT NOT NULL DEFAULT 'needs_review',
    joyce_approved INTEGER NOT NULL DEFAULT 0,
    r2_key TEXT,
    mime_type TEXT,
    file_size INTEGER,
    sha256 TEXT,
    indexing_status TEXT NOT NULL DEFAULT 'not_indexed',
    legacy_metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS document_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    page_number INTEGER,
    section TEXT,
    content TEXT NOT NULL,
    authority TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS document_chunks_document_idx ON document_chunks(document_id)`,
  `CREATE TABLE IF NOT EXISTS knowledge_items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT,
    categories TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    source TEXT,
    source_name TEXT,
    source_url TEXT,
    source_notes TEXT,
    summary TEXT,
    essence_summary TEXT,
    essence_points TEXT NOT NULL DEFAULT '[]',
    core_principles TEXT NOT NULL DEFAULT '[]',
    actionable_tactics TEXT NOT NULL DEFAULT '[]',
    applicable_scenarios TEXT NOT NULL DEFAULT '[]',
    applicable_situations TEXT,
    original_text TEXT NOT NULL,
    original_source_type TEXT,
    original_source_record_id TEXT,
    user_edited_fields TEXT NOT NULL DEFAULT '[]',
    content_modified_at TEXT,
    ai_processing_status TEXT NOT NULL DEFAULT 'source_only',
    human_review_status TEXT NOT NULL DEFAULT 'pending_review',
    processed_at TEXT,
    reviewed_at TEXT,
    review_status TEXT NOT NULL DEFAULT 'needs_review',
    joyce_approved INTEGER NOT NULL DEFAULT 0,
    legacy_metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS sales_playbook_items (
    id TEXT PRIMARY KEY,
    source_document_id TEXT,
    knowledge_item_id TEXT,
    title TEXT,
    principles TEXT NOT NULL DEFAULT '[]',
    created_from TEXT,
    approved_by TEXT,
    approved_at TEXT,
    category TEXT,
    summary TEXT NOT NULL,
    applicable_scenarios TEXT,
    review_status TEXT NOT NULL DEFAULT 'needs_review',
    joyce_approved INTEGER NOT NULL DEFAULT 0,
    evidence TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS inbox_entries (
    id TEXT PRIMARY KEY,
    original_input TEXT NOT NULL,
    structured_summary TEXT,
    classification_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ai_actions (
    id TEXT PRIMARY KEY,
    inbox_entry_id TEXT,
    original_input TEXT NOT NULL,
    parsed_interpretation TEXT NOT NULL,
    proposed_action TEXT NOT NULL,
    risk_level INTEGER NOT NULL,
    confirmation_status TEXT NOT NULL,
    resulting_record_type TEXT,
    resulting_record_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS content_items (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    platform TEXT,
    status TEXT NOT NULL DEFAULT '想法',
    product_id TEXT,
    market TEXT,
    draft TEXT,
    published_date TEXT,
    source_material TEXT,
    legacy_metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    r2_key TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT,
    file_size INTEGER,
    sha256 TEXT,
    entity_type TEXT,
    entity_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS legacy_records (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT,
    target_type TEXT,
    target_id TEXT,
    raw_payload TEXT NOT NULL,
    payload_hash TEXT,
    migration_status TEXT NOT NULL,
    review_reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    before_data TEXT,
    after_data TEXT,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS work_reports (
    id TEXT PRIMARY KEY,
    report_type TEXT NOT NULL,
    title TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]',
    items TEXT NOT NULL DEFAULT '[]',
    source_summary TEXT NOT NULL DEFAULT '{}',
    source_details TEXT NOT NULL DEFAULT '[]',
    version_of TEXT,
    confirmed_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
] as const;

const phase12BackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_v21_customers_20260723 AS SELECT * FROM customers`,
  `CREATE TABLE IF NOT EXISTS backup_v21_contacts_20260723 AS SELECT * FROM contacts`,
  `CREATE TABLE IF NOT EXISTS backup_v21_tasks_20260723 AS SELECT * FROM tasks`,
] as const;

const phase12PostStatements = [
  `CREATE INDEX IF NOT EXISTS contacts_customer_idx ON contacts(customer_id, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS customer_custom_fields_customer_idx
    ON customer_custom_fields(customer_id, deleted_at, sort_order)`,
  `CREATE INDEX IF NOT EXISTS tasks_lifecycle_idx
    ON tasks(status, archived_at, snoozed_until, reminder_date)`,
] as const;

const phase12Columns: Record<string, Array<[string, string]>> = {
  customers: [
    ["city", "TEXT"],
    ["address", "TEXT"],
  ],
  contacts: [
    ["position", "TEXT"],
    ["whatsapp", "TEXT"],
    ["wechat", "TEXT"],
    ["linkedin", "TEXT"],
    ["notes", "TEXT"],
    ["is_primary", "INTEGER NOT NULL DEFAULT 0"],
    ["deleted_at", "TEXT"],
  ],
  tasks: [
    ["next_action_date", "TEXT"],
    ["reminder_date", "TEXT"],
    ["snoozed_until", "TEXT"],
    ["recurrence_rule", "TEXT NOT NULL DEFAULT 'none'"],
    ["completed_at", "TEXT"],
    ["cancelled_at", "TEXT"],
    ["archived_at", "TEXT"],
  ],
};

const customerPriorityBackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_customers_priority_20260817 AS
   SELECT * FROM customers`,
] as const;

const customerPriorityColumns: Record<string, Array<[string, string]>> = {
  customers: [
    ["purchase_intent", "TEXT"],
    ["purchase_ability", "TEXT"],
    ["rating_reason", "TEXT"],
    ["last_reviewed_at", "TEXT"],
  ],
};

const phase4OrderBackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_v21_orders_phase4_20260723 AS SELECT * FROM orders`,
  `CREATE TABLE IF NOT EXISTS backup_v21_order_items_phase4_20260723 AS SELECT * FROM order_items`,
] as const;

const phase4OrderColumns: Record<string, Array<[string, string]>> = {
  orders: [
    ["pi_no", "TEXT"],
    ["country", "TEXT"],
    ["quantity", "REAL"],
    ["other_costs", "REAL"],
    ["deposit_amount", "REAL"],
    ["deposit_date", "TEXT"],
    ["balance_amount", "REAL"],
    ["balance_expected_date", "TEXT"],
    ["balance_received_date", "TEXT"],
    ["container_number", "TEXT"],
    ["bl_number", "TEXT"],
    ["forwarder", "TEXT"],
    ["vessel", "TEXT"],
    ["voyage", "TEXT"],
    ["port", "TEXT"],
    ["documents", "TEXT NOT NULL DEFAULT '[]'"],
    ["import_batch_id", "TEXT"],
    ["source_type", "TEXT"],
    ["deleted_at", "TEXT"],
  ],
};

const phase4OrderPostStatements = [
  `CREATE INDEX IF NOT EXISTS orders_customer_code_idx
    ON orders(customer_code, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS orders_order_no_idx
    ON orders(order_no, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS orders_pi_no_idx
    ON orders(pi_no, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS orders_status_idx
    ON orders(payment_status, production_status, shipment_status, deleted_at)`,
] as const;

const orderFinalBackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_v21_orders_final_20260724 AS SELECT * FROM orders`,
  `CREATE TABLE IF NOT EXISTS backup_v21_order_items_final_20260724 AS SELECT * FROM order_items`,
] as const;

const orderFinalColumns: Record<string, Array<[string, string]>> = {
  orders: [
    ["port_of_loading", "TEXT"],
    ["port_of_discharge", "TEXT"],
    ["shipping_company", "TEXT"],
    ["production_notes", "TEXT"],
  ],
};

const orderPaymentBackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_v67_orders_payment_records_20260826 AS SELECT * FROM orders`,
] as const;

const orderPaymentPostStatements = [
  `CREATE TABLE IF NOT EXISTS order_payments (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    payment_type TEXT NOT NULL,
    payment_date TEXT NOT NULL,
    amount REAL NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    legacy_metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS order_payments_order_type_date_idx
    ON order_payments(order_id, payment_type, payment_date, sort_order)`,
  `INSERT OR IGNORE INTO order_payments
    (id, order_id, payment_type, payment_date, amount, sort_order, legacy_metadata, created_at, updated_at)
   SELECT 'legacy_deposit_' || id, id, 'deposit', substr(deposit_date, 1, 10), deposit_amount, 0,
          '{"source":"legacy_orders_fields"}', COALESCE(created_at, CURRENT_TIMESTAMP), COALESCE(updated_at, CURRENT_TIMESTAMP)
   FROM orders
   WHERE TRIM(COALESCE(deposit_date, '')) <> '' AND deposit_amount IS NOT NULL`,
  `INSERT OR IGNORE INTO order_payments
    (id, order_id, payment_type, payment_date, amount, sort_order, legacy_metadata, created_at, updated_at)
   SELECT 'legacy_balance_' || id, id, 'balance', substr(balance_expected_date, 1, 10), balance_amount, 0,
          '{"source":"legacy_orders_fields"}', COALESCE(created_at, CURRENT_TIMESTAMP), COALESCE(updated_at, CURRENT_TIMESTAMP)
   FROM orders
   WHERE TRIM(COALESCE(balance_expected_date, '')) <> '' AND balance_amount IS NOT NULL`,
] as const;

const taskCleanupBackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_v21_tasks_cleanup_20260723 AS SELECT * FROM tasks`,
] as const;

const taskCleanupColumns: Record<string, Array<[string, string]>> = {
  tasks: [
    ["deleted_at", "TEXT"],
    ["purge_after", "TEXT"],
  ],
};

const taskCleanupPostStatements = [
  `CREATE INDEX IF NOT EXISTS tasks_cleanup_idx
    ON tasks(deleted_at, purge_after)`,
] as const;

const reportBackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_v21_work_reports_20260724 AS SELECT * FROM work_reports`,
] as const;

const reportPostStatements = [
  `CREATE INDEX IF NOT EXISTS work_reports_history_idx
    ON work_reports(confirmed_at, start_date, end_date)`,
] as const;

const workPriorityBackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_v21_tasks_priority_20260724 AS SELECT * FROM tasks`,
  `CREATE TABLE IF NOT EXISTS backup_v21_projects_priority_20260724 AS SELECT * FROM projects`,
] as const;

const workPriorityColumns: Record<string, Array<[string, string]>> = {
  tasks: [
    ["work_sort_order", "INTEGER NOT NULL DEFAULT 0"],
    ["priority_reason", "TEXT"],
    ["priority_source", "TEXT"],
    ["priority_ranked_at", "TEXT"],
  ],
  projects: [
    ["work_sort_order", "INTEGER NOT NULL DEFAULT 0"],
    ["priority_reason", "TEXT"],
    ["priority_source", "TEXT"],
    ["priority_ranked_at", "TEXT"],
  ],
};

const projectCompletionBackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_v45_projects_completed_at_20260812 AS
   SELECT * FROM projects`,
] as const;

const projectCompletionColumns: Record<string, Array<[string, string]>> = {
  projects: [["completed_at", "TEXT"]],
};

const projectCompletionPostStatements = [
  `CREATE INDEX IF NOT EXISTS projects_completed_at_idx
   ON projects(completed_at DESC)`,
] as const;

const projectFinalResultBackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_v46_projects_final_result_20260812 AS
   SELECT * FROM projects`,
] as const;

const projectFinalResultColumns: Record<string, Array<[string, string]>> = {
  projects: [["final_result", "TEXT"]],
};

const workPriorityPostStatements = [
  `CREATE INDEX IF NOT EXISTS tasks_work_sort_idx
    ON tasks(work_sort_order, status, archived_at, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS projects_work_sort_idx
    ON projects(work_sort_order, status)`,
] as const;

const knowledgeWorkflowBackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_v22_knowledge_workflow_20260725 AS
   SELECT * FROM knowledge_items`,
] as const;

const knowledgeWorkflowColumns: Record<string, Array<[string, string]>> = {
  knowledge_items: [
    ["ai_processing_status", "TEXT NOT NULL DEFAULT 'source_only'"],
    ["human_review_status", "TEXT NOT NULL DEFAULT 'pending_review'"],
    ["processed_at", "TEXT"],
    ["reviewed_at", "TEXT"],
  ],
  sales_playbook_items: [["knowledge_item_id", "TEXT"]],
};

const knowledgeWorkflowPostStatements = [
  `UPDATE knowledge_items
   SET
     ai_processing_status = CASE
       WHEN source = 'Universal Inbox' AND trim(COALESCE(summary, '')) <> ''
         THEN 'completed'
       ELSE COALESCE(NULLIF(ai_processing_status, ''), 'source_only')
     END,
     human_review_status = CASE
       WHEN joyce_approved = 1 THEN 'approved'
       ELSE COALESCE(NULLIF(human_review_status, ''), 'pending_review')
     END,
     processed_at = CASE
       WHEN source = 'Universal Inbox' AND trim(COALESCE(summary, '')) <> ''
         THEN COALESCE(processed_at, updated_at)
       ELSE processed_at
     END,
     reviewed_at = CASE
       WHEN joyce_approved = 1 THEN COALESCE(reviewed_at, updated_at)
       ELSE reviewed_at
     END`,
  `UPDATE knowledge_items
   SET
     category = CASE
       WHEN category = '待 AI 复核' THEN '销售知识'
       ELSE category
     END,
     ai_processing_status = 'completed',
     human_review_status = 'approved',
     processed_at = COALESCE(processed_at, updated_at),
     reviewed_at = COALESCE(reviewed_at, updated_at),
     review_status = 'approved',
     joyce_approved = 1
   WHERE id IN (
     '771238a0-5b03-4e9e-916a-4702f9bd4fdf',
     'eda82392-1a24-4027-87b5-883d9210a666'
   )`,
  `CREATE INDEX IF NOT EXISTS knowledge_workflow_idx
     ON knowledge_items(human_review_status, ai_processing_status, updated_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sales_playbook_knowledge_idx
     ON sales_playbook_items(knowledge_item_id)
     WHERE knowledge_item_id IS NOT NULL`,
] as const;

const knowledgeStructuredBackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_v22_knowledge_structured_20260725 AS
   SELECT * FROM knowledge_items`,
  `CREATE TABLE IF NOT EXISTS backup_v22_playbook_structured_20260725 AS
   SELECT * FROM sales_playbook_items`,
] as const;

const knowledgeStructuredColumns: Record<string, Array<[string, string]>> = {
  knowledge_items: [
    ["categories", "TEXT NOT NULL DEFAULT '[]'"],
    ["source_name", "TEXT"],
    ["source_url", "TEXT"],
    ["source_notes", "TEXT"],
    ["essence_points", "TEXT NOT NULL DEFAULT '[]'"],
    ["core_principles", "TEXT NOT NULL DEFAULT '[]'"],
    ["actionable_tactics", "TEXT NOT NULL DEFAULT '[]'"],
    ["applicable_scenarios", "TEXT NOT NULL DEFAULT '[]'"],
    ["original_source_type", "TEXT"],
    ["original_source_record_id", "TEXT"],
    ["user_edited_fields", "TEXT NOT NULL DEFAULT '[]'"],
    ["content_modified_at", "TEXT"],
  ],
  sales_playbook_items: [
    ["title", "TEXT"],
    ["principles", "TEXT NOT NULL DEFAULT '[]'"],
    ["created_from", "TEXT"],
    ["approved_by", "TEXT"],
    ["approved_at", "TEXT"],
  ],
};

const knowledgeStructuredPostStatements = [
  `UPDATE knowledge_items SET
    categories = CASE
      WHEN categories = '[]' AND trim(COALESCE(category, '')) <> ''
        THEN json_array(category)
      ELSE categories END,
    source_name = COALESCE(NULLIF(source_name, ''), source),
    original_source_type = COALESCE(NULLIF(original_source_type, ''),
      CASE WHEN source = 'Universal Inbox' THEN 'universal_inbox'
           ELSE 'manual_or_import' END)`,
  `UPDATE knowledge_items SET
    essence_points = CASE WHEN essence_points = '[]' THEN
      '["把销售沟通建立在客户真实痛点与决策链上","把服务体验视为长期关系和复购的一部分","用可验证的客户反馈持续修正沟通策略"]'
      ELSE essence_points END,
    core_principles = CASE WHEN core_principles = '[]' THEN
      '["先理解客户需求和顾虑，再提出方案","销售承诺必须与可交付的服务一致","重要沟通应围绕客户决策价值展开"]'
      ELSE core_principles END,
    actionable_tactics = CASE WHEN actionable_tactics = '[]' THEN
      '["记录客户痛点、异议与下一步","针对不同决策角色调整沟通重点","在关键节点主动确认客户体验"]'
      ELSE actionable_tactics END,
    applicable_scenarios = CASE WHEN applicable_scenarios = '[]' THEN
      '["客户开发","需求沟通","客户服务","长期关系维护"]'
      ELSE applicable_scenarios END
    WHERE id = '771238a0-5b03-4e9e-916a-4702f9bd4fdf'`,
  `UPDATE knowledge_items SET
    essence_points = CASE WHEN essence_points = '[]' THEN
      '["用客户痛点判断方案优先级，而不是堆叠产品卖点","识别真正影响采购的决策人和决策条件","拜访高层前应准备与其经营目标相关的证据"]'
      ELSE essence_points END,
    core_principles = CASE WHEN core_principles = '[]' THEN
      '["客户痛点必须由事实和提问验证","沟通对象不同，价值表达也应不同","高层沟通聚焦业务结果、风险和长期价值"]'
      ELSE core_principles END,
    actionable_tactics = CASE WHEN actionable_tactics = '[]' THEN
      '["拜访前列出已知痛点与待验证假设","梳理使用者、影响者和最终决策人","准备能支持关键价值判断的案例和数据"]'
      ELSE actionable_tactics END,
    applicable_scenarios = CASE WHEN applicable_scenarios = '[]' THEN
      '["客户痛点分析","关键客户拜访","高层决策沟通","销售方案准备"]'
      ELSE applicable_scenarios END
    WHERE id = 'eda82392-1a24-4027-87b5-883d9210a666'`,
  `DROP INDEX IF EXISTS sales_playbook_knowledge_idx`,
  `CREATE INDEX IF NOT EXISTS sales_playbook_knowledge_idx
     ON sales_playbook_items(knowledge_item_id)`,
  `CREATE INDEX IF NOT EXISTS knowledge_structured_status_idx
     ON knowledge_items(human_review_status, ai_processing_status, updated_at)`,
] as const;

const knowledgeEssenceSummaryBackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_v22_knowledge_essence_summary_20260725 AS
   SELECT * FROM knowledge_items`,
] as const;

const knowledgeEssenceSummaryColumns: Record<string, Array<[string, string]>> = {
  knowledge_items: [["essence_summary", "TEXT"]],
};

const orderShippingBackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_v40_orders_shipping_20260731 AS SELECT * FROM orders`,
  `CREATE TABLE IF NOT EXISTS backup_v40_order_risks_shipping_20260731 AS SELECT * FROM order_risks`,
] as const;

const orderShippingColumns: Record<string, Array<[string, string]>> = {
  orders: [
    ["shipping_method", "TEXT"],
    ["awb_number", "TEXT"],
    ["carrier_company", "TEXT"],
    ["tracking_number", "TEXT"],
    ["logistics_company", "TEXT"],
    ["logistics_number", "TEXT"],
  ],
  order_risks: [
    ["acknowledged_at", "TEXT"],
    ["acknowledged_by", "TEXT"],
  ],
};

const orderShippingPostStatements = [
  `UPDATE order_risks
   SET status = 'resolved', updated_at = CURRENT_TIMESTAMP
   WHERE status = 'active' AND trigger_type = 'missing_document'`,
  `INSERT INTO order_risks
    (id, order_id, risk_level, title, reason, recommended_action,
     evidence_source, trigger_type, status, detected_at, updated_at)
   SELECT lower(hex(randomblob(16))), o.id, 'High',
     '已发运订单缺少BL号',
     '运输状态为 ' || o.shipment_status || '，但订单未记录 BL No.。',
     '向船公司或货代确认BL号并补充到订单。',
     'orders.shipping_method=sea_freight; orders.shipment_status=' || o.shipment_status || '; orders.bl_number=empty',
     'missing_bl', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
   FROM orders o
   WHERE o.deleted_at IS NULL AND o.shipping_method = 'sea_freight'
     AND o.shipment_status IN ('shipped', 'in_transit', 'arrived', 'completed')
     AND trim(COALESCE(o.bl_number, '')) = ''
     AND NOT EXISTS (
       SELECT 1 FROM order_risks r
       WHERE r.order_id = o.id AND r.trigger_type = 'missing_bl'
         AND r.status IN ('active', 'acknowledged')
     )`,
  `INSERT INTO order_risks
    (id, order_id, risk_level, title, reason, recommended_action,
     evidence_source, trigger_type, status, detected_at, updated_at)
   SELECT lower(hex(randomblob(16))), o.id, 'High',
     '已发运快递订单缺少追踪号',
     '运输状态为 ' || o.shipment_status || '，但订单未记录 Tracking No.。',
     '向快递公司确认追踪号并补充到订单。',
     'orders.shipping_method=express; orders.shipment_status=' || o.shipment_status || '; orders.tracking_number=empty',
     'missing_tracking', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
   FROM orders o
   WHERE o.deleted_at IS NULL AND o.shipping_method = 'express'
     AND o.shipment_status IN ('shipped', 'in_transit', 'arrived', 'completed')
     AND trim(COALESCE(o.tracking_number, '')) = ''
     AND NOT EXISTS (
       SELECT 1 FROM order_risks r
       WHERE r.order_id = o.id AND r.trigger_type = 'missing_tracking'
         AND r.status IN ('active', 'acknowledged')
     )`,
  `INSERT INTO order_risks
    (id, order_id, risk_level, title, reason, recommended_action,
     evidence_source, trigger_type, status, detected_at, updated_at)
   SELECT lower(hex(randomblob(16))), o.id, 'High',
     '已发运订单缺少物流单号',
     '运输状态为 ' || o.shipment_status || '，但订单未记录国内物流单号。',
     '向物流公司确认物流单号并补充到订单。',
     'orders.shipping_method=domestic; orders.shipment_status=' || o.shipment_status || '; orders.logistics_number=empty',
     'missing_logistics', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
   FROM orders o
   WHERE o.deleted_at IS NULL AND o.shipping_method = 'domestic'
     AND o.shipment_status IN ('shipped', 'in_transit', 'arrived', 'completed')
     AND trim(COALESCE(o.logistics_number, '')) = ''
     AND NOT EXISTS (
       SELECT 1 FROM order_risks r
       WHERE r.order_id = o.id AND r.trigger_type = 'missing_logistics'
         AND r.status IN ('active', 'acknowledged')
     )`,
] as const;

const orderWorkflowBackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_v48_orders_workflow_20260813 AS SELECT * FROM orders`,
  `CREATE TABLE IF NOT EXISTS backup_v48_order_risks_workflow_20260813 AS SELECT * FROM order_risks`,
] as const;

const orderWorkflowColumns: Record<string, Array<[string, string]>> = {
  orders: [
    ["order_status", "TEXT NOT NULL DEFAULT 'active'"],
    ["completed_at", "TEXT"],
    ["expected_shipping_date", "TEXT"],
    ["estimated_delivery_date", "TEXT"],
    ["progress_next_step", "TEXT"],
  ],
};

const orderWorkflowPostStatements = [
  `UPDATE orders SET shipment_status = 'in_transit' WHERE shipment_status = 'shipped'`,
  `UPDATE orders SET shipment_status = 'not_arranged' WHERE shipment_status = 'not_shipped'`,
  `UPDATE orders SET shipment_status = 'delivered' WHERE shipment_status = 'completed'`,
  `UPDATE order_risks SET status = 'resolved', updated_at = CURRENT_TIMESTAMP
   WHERE status = 'active' AND trigger_type = 'after_sales'`,
  `UPDATE order_risks SET status = 'resolved', updated_at = CURRENT_TIMESTAMP
   WHERE status = 'active' AND order_id IN (
     SELECT id FROM orders WHERE COALESCE(order_status, 'active') = 'completed'
   )`,
  `CREATE INDEX IF NOT EXISTS orders_workflow_idx
   ON orders(order_status, completed_at DESC, expected_shipping_date, updated_at DESC)`,
] as const;

const afterSalesCaseLibraryBackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_v22_after_sales_case_library_20260729 AS
   SELECT * FROM after_sales_cases`,
] as const;

const afterSalesCaseLibraryColumns: Record<string, Array<[string, string]>> = {
  after_sales_cases: [
    ["case_title", "TEXT"],
    ["order_no", "TEXT"],
    ["fault_date", "TEXT"],
    ["tags", "TEXT NOT NULL DEFAULT '[]'"],
    ["troubleshooting_process", "TEXT"],
    ["confirmed_cause", "TEXT"],
    ["reuse_solution", "TEXT"],
    ["full_technical_report", "TEXT"],
  ],
};

const afterSalesCaseLibraryPostStatements = [
  `UPDATE after_sales_cases
   SET
    case_title = COALESCE(NULLIF(TRIM(case_title), ''), NULLIF(TRIM(code), ''),
      NULLIF(TRIM(issue_description), ''), '历史售后技术案例'),
    troubleshooting_process = COALESCE(
      NULLIF(TRIM(troubleshooting_process), ''), NULLIF(TRIM(actions_taken), '')),
    reuse_solution = COALESCE(
      NULLIF(TRIM(reuse_solution), ''), NULLIF(TRIM(resolution), '')),
    full_technical_report = COALESCE(
      NULLIF(TRIM(full_technical_report), ''),
      '【历史原始资料】' || CHAR(10) ||
      CASE WHEN TRIM(COALESCE(original_customer_description, '')) <> ''
        THEN '客户原始描述：' || original_customer_description || CHAR(10) ELSE '' END ||
      CASE WHEN TRIM(COALESCE(issue_description, '')) <> ''
        THEN '故障现象：' || issue_description || CHAR(10) ELSE '' END ||
      CASE WHEN TRIM(COALESCE(evidence, '')) <> ''
        THEN '证据/测试结果：' || evidence || CHAR(10) ELSE '' END ||
      CASE WHEN TRIM(COALESCE(diagnosis, '')) <> ''
        THEN '历史诊断或判断（未自动视为确认原因）：' || diagnosis || CHAR(10) ELSE '' END ||
      CASE WHEN TRIM(COALESCE(engineering_response, '')) <> ''
        THEN '工程回复：' || engineering_response || CHAR(10) ELSE '' END ||
      CASE WHEN TRIM(COALESCE(actions_taken, '')) <> ''
        THEN '排查/处理过程：' || actions_taken || CHAR(10) ELSE '' END ||
      CASE WHEN TRIM(COALESCE(parts_sent, '')) <> ''
        THEN '配件记录：' || parts_sent || CHAR(10) ELSE '' END ||
      CASE WHEN TRIM(COALESCE(resolution, '')) <> ''
        THEN '历史解决记录：' || resolution ELSE '' END)`,
  `CREATE INDEX IF NOT EXISTS after_sales_case_library_updated_idx
     ON after_sales_cases(updated_at)`,
  `CREATE INDEX IF NOT EXISTS after_sales_case_library_model_idx
     ON after_sales_cases(vehicle_model)`,
] as const;

const customerContactFollowupColumns: Record<string, Array<[string, string]>> = {
  customers: [
    ["company_background_notes", "TEXT"],
    ["last_contact_at", "TEXT"],
  ],
};

const customerContactFollowupPostStatements = [
  `CREATE INDEX IF NOT EXISTS customer_follow_ups_customer_time_idx
   ON customer_follow_ups(customer_id, follow_up_at DESC)`,
] as const;

const customerCompanyNotesBackupStatements = [
  `CREATE TABLE IF NOT EXISTS backup_v67_customers_company_notes_20260826 AS
   SELECT * FROM customers`,
  `CREATE TABLE IF NOT EXISTS backup_v67_customer_memory_company_notes_20260826 AS
   SELECT * FROM customer_memory`,
] as const;

const customerCompanyNotesUnificationStatements = [
  `UPDATE customers
   SET company_background_notes = CASE
     WHEN TRIM(COALESCE(company_background_notes, '')) = ''
       THEN '【V1 原备注】' || CHAR(10) || TRIM(legacy_notes)
     ELSE RTRIM(company_background_notes) || CHAR(10) || CHAR(10) ||
       '【V1 原备注】' || CHAR(10) || TRIM(legacy_notes)
   END
   WHERE TRIM(COALESCE(legacy_notes, '')) <> ''
     AND INSTR(COALESCE(company_background_notes, ''), '【V1 原备注】') = 0
     AND INSTR(COALESCE(company_background_notes, ''), TRIM(legacy_notes)) = 0`,
  `UPDATE customers
   SET company_background_notes = CASE
     WHEN TRIM(COALESCE(company_background_notes, '')) = ''
       THEN '【V1 合作备注】' || CHAR(10) || TRIM((
         SELECT relationship_notes FROM customer_memory m WHERE m.customer_id = customers.id
       ))
     ELSE RTRIM(company_background_notes) || CHAR(10) || CHAR(10) ||
       '【V1 合作备注】' || CHAR(10) || TRIM((
         SELECT relationship_notes FROM customer_memory m WHERE m.customer_id = customers.id
       ))
   END
   WHERE EXISTS (
     SELECT 1 FROM customer_memory m
     WHERE m.customer_id = customers.id
       AND TRIM(COALESCE(m.relationship_notes, '')) <> ''
   )
     AND INSTR(COALESCE(company_background_notes, ''), '【V1 合作备注】') = 0
     AND INSTR(COALESCE(company_background_notes, ''), TRIM((
       SELECT relationship_notes FROM customer_memory m WHERE m.customer_id = customers.id
     ))) = 0`,
] as const;

async function ensureColumns(
  db: D1Database,
  columns: Record<string, Array<[string, string]>>,
) {
  for (const [table, definitions] of Object.entries(columns)) {
    const result = await db
      .prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string }>();
    const existing = new Set(result.results.map((column) => column.name));
    for (const [name, definition] of definitions) {
      if (!existing.has(name)) {
        await db
          .prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
          .run();
      }
    }
  }
}

async function purgeExpiredTasks(db: D1Database) {
  const expired = await db
    .prepare(
      `SELECT * FROM tasks
       WHERE deleted_at IS NOT NULL
         AND purge_after IS NOT NULL
         AND datetime(purge_after) <= datetime('now')
       ORDER BY purge_after
       LIMIT 50`,
    )
    .all<Record<string, unknown>>();

  if (!expired.results.length) return;

  const statements: D1PreparedStatement[] = [];
  for (const task of expired.results) {
    const id = String(task.id);
    statements.push(
      db
        .prepare(
          `INSERT INTO audit_logs
            (id, action, entity_type, entity_id, before_data, after_data, source)
           VALUES (?, 'task_permanently_deleted', 'task', ?, ?, ?, 'system')`,
        )
        .bind(
          crypto.randomUUID(),
          id,
          JSON.stringify(task),
          JSON.stringify({ purgedAt: new Date().toISOString() }),
        ),
      db
        .prepare(
          `DELETE FROM tasks
           WHERE id = ?
             AND deleted_at IS NOT NULL
             AND purge_after IS NOT NULL
             AND datetime(purge_after) <= datetime('now')`,
        )
        .bind(id),
    );
  }
  await db.batch(statements);
}

let workspaceEnsurePromise: Promise<void> | null = null;

export function ensureWorkspace() {
  if (!workspaceEnsurePromise) {
    workspaceEnsurePromise = ensureWorkspaceSchema().catch((error) => {
      workspaceEnsurePromise = null;
      throw error;
    });
  }
  return workspaceEnsurePromise;
}

async function ensureWorkspaceSchema() {
  const db = getD1();
  await db.batch(schemaStatements.map((statement) => db.prepare(statement)));
  await db.batch(
    phase12BackupStatements.map((statement) => db.prepare(statement)),
  );
  await ensureColumns(db, phase12Columns);
  await db.batch(
    customerPriorityBackupStatements.map((statement) => db.prepare(statement)),
  );
  await ensureColumns(db, customerPriorityColumns);
  await ensureColumns(db, customerContactFollowupColumns);
  await db.batch(
    customerContactFollowupPostStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    customerCompanyNotesBackupStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    customerCompanyNotesUnificationStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    phase12PostStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    phase4OrderBackupStatements.map((statement) => db.prepare(statement)),
  );
  await ensureColumns(db, phase4OrderColumns);
  await db.batch(
    phase4OrderPostStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    orderFinalBackupStatements.map((statement) => db.prepare(statement)),
  );
  await ensureColumns(db, orderFinalColumns);
  await db.batch(
    orderPaymentBackupStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    orderPaymentPostStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    taskCleanupBackupStatements.map((statement) => db.prepare(statement)),
  );
  await ensureColumns(db, taskCleanupColumns);
  await db.batch(
    taskCleanupPostStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    reportBackupStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    reportPostStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    workPriorityBackupStatements.map((statement) => db.prepare(statement)),
  );
  await ensureColumns(db, workPriorityColumns);
  await db.batch(
    workPriorityPostStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    projectCompletionBackupStatements.map((statement) => db.prepare(statement)),
  );
  await ensureColumns(db, projectCompletionColumns);
  await db.batch(
    projectCompletionPostStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    projectFinalResultBackupStatements.map((statement) => db.prepare(statement)),
  );
  await ensureColumns(db, projectFinalResultColumns);
  await db.batch(
    knowledgeWorkflowBackupStatements.map((statement) => db.prepare(statement)),
  );
  await ensureColumns(db, knowledgeWorkflowColumns);
  await db.batch(
    knowledgeWorkflowPostStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    knowledgeStructuredBackupStatements.map((statement) => db.prepare(statement)),
  );
  await ensureColumns(db, knowledgeStructuredColumns);
  await db.batch(
    knowledgeStructuredPostStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    knowledgeEssenceSummaryBackupStatements.map((statement) =>
      db.prepare(statement),
    ),
  );
  await ensureColumns(db, knowledgeEssenceSummaryColumns);
  await db.batch(
    orderShippingBackupStatements.map((statement) => db.prepare(statement)),
  );
  await ensureColumns(db, orderShippingColumns);
  await db.batch(
    orderShippingPostStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    orderWorkflowBackupStatements.map((statement) => db.prepare(statement)),
  );
  await ensureColumns(db, orderWorkflowColumns);
  await db.batch(
    orderWorkflowPostStatements.map((statement) => db.prepare(statement)),
  );
  await db.batch(
    afterSalesCaseLibraryBackupStatements.map((statement) =>
      db.prepare(statement),
    ),
  );
  await ensureColumns(db, afterSalesCaseLibraryColumns);
  await db.batch(
    afterSalesCaseLibraryPostStatements.map((statement) =>
      db.prepare(statement),
    ),
  );
  await purgeExpiredTasks(db);
  await db
    .prepare(
      `UPDATE orders
       SET
        customer_id = (
          SELECT customers.id FROM customers
          WHERE upper(trim(customers.customer_code)) =
                upper(trim(orders.customer_code))
            AND customers.deleted_at IS NULL
          LIMIT 1
        ),
        customer_name = COALESCE(
          NULLIF(trim(customer_name), ''),
          (
            SELECT customers.company FROM customers
            WHERE upper(trim(customers.customer_code)) =
                  upper(trim(orders.customer_code))
              AND customers.deleted_at IS NULL
            LIMIT 1
          )
        ),
        country = COALESCE(
          NULLIF(trim(country), ''),
          (
            SELECT customers.country FROM customers
            WHERE upper(trim(customers.customer_code)) =
                  upper(trim(orders.customer_code))
              AND customers.deleted_at IS NULL
            LIMIT 1
          )
        )
       WHERE customer_id IS NULL
         AND trim(COALESCE(customer_code, '')) <> ''
         AND (
           SELECT COUNT(*) FROM customers
           WHERE upper(trim(customers.customer_code)) =
                 upper(trim(orders.customer_code))
             AND customers.deleted_at IS NULL
         ) = 1`,
    )
    .run();
  await db
    .prepare(
      `INSERT OR IGNORE INTO contacts
        (id, customer_id, name, email, phone, position, is_primary,
         legacy_metadata, created_at, updated_at)
       SELECT
        'v21_primary_' || id, id, NULLIF(TRIM(contact), ''),
        NULLIF(TRIM(email), ''), NULLIF(TRIM(phone), ''), NULL, 1,
        '{"source":"customers_flat_fields"}',
        COALESCE(created_at, CURRENT_TIMESTAMP), COALESCE(updated_at, CURRENT_TIMESTAMP)
       FROM customers
       WHERE
        (TRIM(COALESCE(contact, '')) <> ''
         OR TRIM(COALESCE(email, '')) <> ''
         OR TRIM(COALESCE(phone, '')) <> '')
        AND NOT EXISTS (
          SELECT 1 FROM contacts
          WHERE contacts.customer_id = customers.id
            AND contacts.deleted_at IS NULL
        )`,
    )
    .run();

}
