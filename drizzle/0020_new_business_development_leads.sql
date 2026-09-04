CREATE TABLE IF NOT EXISTS `business_development_leads` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `company_name` TEXT NOT NULL,
  `normalized_name` TEXT NOT NULL,
  `country` TEXT NOT NULL,
  `city` TEXT,
  `website` TEXT,
  `website_domain` TEXT,
  `linkedin_company` TEXT,
  `source` TEXT NOT NULL DEFAULT 'Manual',
  `company_type` TEXT,
  `moto_ev_business` TEXT NOT NULL DEFAULT 'Unknown',
  `existing_brands` TEXT,
  `relevant_products` TEXT,
  `target_models` TEXT,
  `market_fit` TEXT,
  `priority` TEXT NOT NULL DEFAULT 'Medium',
  `why_worth_developing` TEXT,
  `risk_doubt` TEXT,
  `status` TEXT NOT NULL DEFAULT 'research_pending',
  `next_follow_up_date` TEXT,
  `next_step` TEXT,
  `created_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `business_development_leads_status_idx`
ON `business_development_leads` (`status`, `next_follow_up_date`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `business_development_leads_priority_idx`
ON `business_development_leads` (`priority`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `business_development_leads_country_idx`
ON `business_development_leads` (`country`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `lead_contacts` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `lead_id` TEXT NOT NULL,
  `name` TEXT,
  `title` TEXT,
  `email` TEXT,
  `phone` TEXT,
  `whatsapp` TEXT,
  `wechat` TEXT,
  `linkedin` TEXT,
  `note` TEXT,
  `is_primary` INTEGER NOT NULL DEFAULT 0,
  `decision_maker_fit` TEXT,
  `created_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `lead_contacts_lead_idx`
ON `lead_contacts` (`lead_id`, `is_primary`, `created_at`);
