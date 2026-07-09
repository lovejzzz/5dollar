CREATE TABLE `funded_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`task_type` text DEFAULT 'dataset_summary' NOT NULL,
	`title` text NOT NULL,
	`instructions` text NOT NULL,
	`input_json` text DEFAULT '{}' NOT NULL,
	`reward_cents` integer NOT NULL,
	`payout_cents` integer DEFAULT 500 NOT NULL,
	`automation_allowed` integer DEFAULT 0 NOT NULL,
	`auto_accept` integer DEFAULT 0 NOT NULL,
	`min_answer_chars` integer DEFAULT 120 NOT NULL,
	`acceptance_json` text DEFAULT '{}' NOT NULL,
	`sponsor_reference` text NOT NULL,
	`funding_receipt_id` text NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`lease_job_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`accepted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `funded_tasks_sponsor_reference_idx` ON `funded_tasks` (`sponsor_reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `funded_tasks_funding_receipt_idx` ON `funded_tasks` (`funding_receipt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `funded_tasks_lease_job_id_idx` ON `funded_tasks` (`lease_job_id`);--> statement-breakpoint
CREATE INDEX `funded_tasks_available_idx` ON `funded_tasks` (`status`,`automation_allowed`,`created_at`);--> statement-breakpoint
CREATE TABLE `funding_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_transaction_id` text NOT NULL,
	`sponsor_reference` text NOT NULL,
	`currency` text NOT NULL,
	`gross_cents` integer NOT NULL,
	`net_cents` integer NOT NULL,
	`status` text NOT NULL,
	`captured_at` integer NOT NULL,
	`task_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `funding_receipts_provider_transaction_idx` ON `funding_receipts` (`provider`,`provider_transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `funding_receipts_sponsor_reference_idx` ON `funding_receipts` (`sponsor_reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `funding_receipts_task_id_idx` ON `funding_receipts` (`task_id`);--> statement-breakpoint
CREATE TABLE `live_job_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_key` text NOT NULL,
	`job_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_job_events_event_key_idx` ON `live_job_events` (`event_key`);--> statement-breakpoint
CREATE INDEX `live_job_events_job_id_idx` ON `live_job_events` (`job_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `live_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`payout_method` text NOT NULL,
	`destination_ciphertext` text NOT NULL,
	`destination_fingerprint` text NOT NULL,
	`destination_hint` text NOT NULL,
	`amount_cents` integer DEFAULT 500 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`task_id` text,
	`earned_cents` integer DEFAULT 0 NOT NULL,
	`submission_json` text,
	`model_response_id` text,
	`model_name` text,
	`provider_status` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`lease_token` text,
	`lease_expires_at` integer,
	`last_error_code` text,
	`last_error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_jobs_owner_email_idx` ON `live_jobs` (`owner_email`);--> statement-breakpoint
CREATE UNIQUE INDEX `live_jobs_destination_fingerprint_idx` ON `live_jobs` (`destination_fingerprint`);--> statement-breakpoint
CREATE INDEX `live_jobs_processing_idx` ON `live_jobs` (`status`,`next_attempt_at`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `notification_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`event_key` text NOT NULL,
	`job_id` text NOT NULL,
	`kind` text NOT NULL,
	`payout_reference` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`lease_token` text,
	`lease_expires_at` integer,
	`provider_message_id` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_outbox_event_key_idx` ON `notification_outbox` (`event_key`);--> statement-breakpoint
CREATE INDEX `notification_outbox_delivery_idx` ON `notification_outbox` (`status`,`next_attempt_at`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `payouts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`sender_batch_id` text NOT NULL,
	`sender_item_id` text NOT NULL,
	`provider_batch_id` text,
	`provider_item_id` text,
	`status` text DEFAULT 'created' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payouts_job_id_idx` ON `payouts` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payouts_sender_batch_id_idx` ON `payouts` (`sender_batch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payouts_sender_item_id_idx` ON `payouts` (`sender_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payouts_provider_batch_id_idx` ON `payouts` (`provider_batch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payouts_provider_item_id_idx` ON `payouts` (`provider_item_id`);--> statement-breakpoint
CREATE TABLE `paypal_webhook_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`payout_id` text NOT NULL,
	`provider_event_time` integer NOT NULL,
	`received_at` integer NOT NULL,
	`applied_at` integer
);
--> statement-breakpoint
CREATE INDEX `paypal_webhook_events_payout_idx` ON `paypal_webhook_events` (`payout_id`);