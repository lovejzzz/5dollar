CREATE TABLE `paypal_funding_webhook_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`funding_receipt_id` text,
	`capture_id` text NOT NULL,
	`terminal_status` text NOT NULL,
	`provider_event_time` integer NOT NULL,
	`received_at` integer NOT NULL,
	`applied_at` integer
);
--> statement-breakpoint
CREATE INDEX `paypal_funding_webhook_events_capture_idx` ON `paypal_funding_webhook_events` (`capture_id`);--> statement-breakpoint
CREATE INDEX `paypal_funding_webhook_events_receipt_idx` ON `paypal_funding_webhook_events` (`funding_receipt_id`);--> statement-breakpoint
CREATE TABLE `sponsor_order_request_limits` (
	`owner_email` text PRIMARY KEY NOT NULL,
	`window_started_at` integer NOT NULL,
	`request_count` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "sponsor_order_request_limits_count_check" CHECK("sponsor_order_request_limits"."request_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE `sponsor_task_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`client_request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`task_type` text DEFAULT 'dataset_summary' NOT NULL,
	`title` text NOT NULL,
	`instructions` text NOT NULL,
	`input_json` text NOT NULL,
	`acceptance_json` text NOT NULL,
	`min_answer_chars` integer DEFAULT 120 NOT NULL,
	`automation_allowed` integer DEFAULT 0 NOT NULL,
	`auto_accept` integer DEFAULT 0 NOT NULL,
	`rights_attested` integer DEFAULT 0 NOT NULL,
	`no_sensitive_data` integer DEFAULT 0 NOT NULL,
	`attestation_version` text NOT NULL,
	`attested_at` integer NOT NULL,
	`sponsor_reference` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`gross_cents` integer DEFAULT 800 NOT NULL,
	`minimum_net_cents` integer DEFAULT 600 NOT NULL,
	`payout_cents` integer DEFAULT 500 NOT NULL,
	`paypal_order_id` text,
	`paypal_capture_id` text,
	`funded_task_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`lease_token` text,
	`lease_expires_at` integer,
	`last_error_code` text,
	`last_error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`funded_task_id`) REFERENCES `funded_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sponsor_task_orders_task_type_check" CHECK("sponsor_task_orders"."task_type" = 'dataset_summary'),
	CONSTRAINT "sponsor_task_orders_currency_check" CHECK("sponsor_task_orders"."currency" = 'USD'),
	CONSTRAINT "sponsor_task_orders_gross_check" CHECK("sponsor_task_orders"."gross_cents" = 800),
	CONSTRAINT "sponsor_task_orders_minimum_net_check" CHECK("sponsor_task_orders"."minimum_net_cents" >= 600),
	CONSTRAINT "sponsor_task_orders_payout_check" CHECK("sponsor_task_orders"."payout_cents" = 500),
	CONSTRAINT "sponsor_task_orders_automation_check" CHECK("sponsor_task_orders"."automation_allowed" = 1 AND "sponsor_task_orders"."auto_accept" = 1),
	CONSTRAINT "sponsor_task_orders_attestations_check" CHECK("sponsor_task_orders"."rights_attested" = 1 AND "sponsor_task_orders"."no_sensitive_data" = 1),
	CONSTRAINT "sponsor_task_orders_status_check" CHECK("sponsor_task_orders"."status" IN ('draft', 'order_created', 'capture_pending', 'capture_retry', 'funded', 'canceled', 'needs_review')),
	CONSTRAINT "sponsor_task_orders_funded_completeness_check" CHECK("sponsor_task_orders"."status" <> 'funded' OR ("sponsor_task_orders"."paypal_order_id" IS NOT NULL AND "sponsor_task_orders"."paypal_capture_id" IS NOT NULL AND "sponsor_task_orders"."funded_task_id" IS NOT NULL AND "sponsor_task_orders"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sponsor_task_orders_owner_request_idx` ON `sponsor_task_orders` (`owner_email`,`client_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sponsor_task_orders_reference_idx` ON `sponsor_task_orders` (`sponsor_reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `sponsor_task_orders_paypal_order_idx` ON `sponsor_task_orders` (`paypal_order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sponsor_task_orders_paypal_capture_idx` ON `sponsor_task_orders` (`paypal_capture_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sponsor_task_orders_funded_task_idx` ON `sponsor_task_orders` (`funded_task_id`);--> statement-breakpoint
CREATE INDEX `sponsor_task_orders_owner_created_idx` ON `sponsor_task_orders` (`owner_email`,`created_at`);--> statement-breakpoint
CREATE INDEX `sponsor_task_orders_capture_idx` ON `sponsor_task_orders` (`status`,`next_attempt_at`,`lease_expires_at`);