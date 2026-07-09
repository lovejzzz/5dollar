CREATE TABLE `job_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`step` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_events_job_step_idx` ON `job_events` (`job_id`,`step`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`payout_method` text NOT NULL,
	`destination_hash` text NOT NULL,
	`destination_hint` text NOT NULL,
	`amount_cents` integer DEFAULT 500 NOT NULL,
	`mode` text DEFAULT 'sandbox' NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`current_step` integer DEFAULT 0 NOT NULL,
	`payout_reference` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_id_idx` ON `jobs` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_destination_created_idx` ON `jobs` (`destination_hash`,`created_at`);