CREATE TABLE `after_sales_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text,
	`customer_code` text,
	`code` text,
	`vehicle_model` text,
	`vin` text,
	`issue_description` text,
	`category` text,
	`priority` text,
	`status` text DEFAULT '待处理' NOT NULL,
	`original_customer_description` text,
	`evidence` text,
	`diagnosis` text,
	`engineering_response` text,
	`actions_taken` text,
	`parts_sent` text,
	`resolution` text,
	`legacy_metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_entry_id` text,
	`original_input` text NOT NULL,
	`parsed_interpretation` text NOT NULL,
	`proposed_action` text NOT NULL,
	`risk_level` integer NOT NULL,
	`confirmation_status` text NOT NULL,
	`resulting_record_type` text,
	`resulting_record_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`before_data` text,
	`after_data` text,
	`source` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`name` text,
	`email` text,
	`phone` text,
	`role` text,
	`legacy_metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `content_items` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`platform` text,
	`status` text DEFAULT '想法' NOT NULL,
	`product_id` text,
	`market` text,
	`draft` text,
	`published_date` text,
	`source_material` text,
	`legacy_metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customer_status_history` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`reason` text,
	`source` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_code` text,
	`company` text NOT NULL,
	`lifecycle` text NOT NULL,
	`grade` text,
	`country` text,
	`customer_type` text,
	`contact` text,
	`email` text,
	`phone` text,
	`website` text,
	`source` text,
	`next_action` text,
	`last_follow` text,
	`next_follow` text,
	`strategy` text,
	`profile` text,
	`legacy_metadata` text DEFAULT '{}' NOT NULL,
	`legacy_notes` text DEFAULT '' NOT NULL,
	`deleted_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `document_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`page_number` integer,
	`section` text,
	`content` text NOT NULL,
	`authority` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text,
	`file_size` integer,
	`sha256` text,
	`entity_type` text,
	`entity_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inbox_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`original_input` text NOT NULL,
	`structured_summary` text,
	`classification_status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `knowledge_items` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`category` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`source` text,
	`summary` text,
	`applicable_situations` text,
	`original_text` text NOT NULL,
	`review_status` text DEFAULT 'needs_review' NOT NULL,
	`joyce_approved` integer DEFAULT false NOT NULL,
	`legacy_metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `legacy_records` (
	`id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text,
	`target_type` text,
	`target_id` text,
	`raw_payload` text NOT NULL,
	`payload_hash` text,
	`migration_status` text NOT NULL,
	`review_reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text,
	`description` text,
	`quantity` real,
	`unit_price` real,
	`legacy_metadata` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text,
	`customer_code` text,
	`customer_name` text,
	`order_no` text,
	`order_date` text,
	`model` text,
	`original_currency` text,
	`original_amount` real,
	`fixed_exchange_rate_to_cny` real,
	`cny_amount` real,
	`currency_status` text DEFAULT 'needs_confirmation' NOT NULL,
	`payment_status` text,
	`production_status` text,
	`shipment_status` text,
	`etd` text,
	`eta` text,
	`due_date` text,
	`risk` text,
	`notes` text,
	`legacy_metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`category` text,
	`positioning` text,
	`battery` text,
	`motor` text,
	`certification` text,
	`key_features` text,
	`market` text,
	`authority_status` text DEFAULT 'needs_review' NOT NULL,
	`legacy_metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT '进行中' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`next_step` text,
	`notes` text,
	`legacy_metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sales_playbook_items` (
	`id` text PRIMARY KEY NOT NULL,
	`source_document_id` text,
	`category` text,
	`summary` text NOT NULL,
	`applicable_scenarios` text,
	`review_status` text DEFAULT 'needs_review' NOT NULL,
	`joyce_approved` integer DEFAULT false NOT NULL,
	`evidence` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`file_name` text NOT NULL,
	`document_type` text NOT NULL,
	`product_id` text,
	`version` text,
	`version_status` text DEFAULT 'current' NOT NULL,
	`authority` text NOT NULL,
	`review_status` text DEFAULT 'needs_review' NOT NULL,
	`joyce_approved` integer DEFAULT false NOT NULL,
	`r2_key` text,
	`mime_type` text,
	`file_size` integer,
	`sha256` text,
	`indexing_status` text DEFAULT 'not_indexed' NOT NULL,
	`legacy_metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT '待处理' NOT NULL,
	`priority` text DEFAULT '中' NOT NULL,
	`due_date` text,
	`customer_id` text,
	`order_id` text,
	`after_sales_case_id` text,
	`project_id` text,
	`next_action` text,
	`notes` text,
	`source_type` text,
	`source_id` text,
	`legacy_metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `timeline_events` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`event_type` text NOT NULL,
	`title` text NOT NULL,
	`content` text,
	`occurred_at` text NOT NULL,
	`source_type` text,
	`source_id` text,
	`evidence` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
