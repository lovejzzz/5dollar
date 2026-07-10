CREATE TABLE `resend_webhook_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`notification_kind` text NOT NULL,
	`notification_id` text,
	`provider_message_id` text NOT NULL,
	`provider_event_time` integer NOT NULL,
	`received_at` integer NOT NULL,
	`applied_at` integer
);
--> statement-breakpoint
CREATE INDEX `resend_webhook_events_message_idx` ON `resend_webhook_events` (`provider_message_id`);--> statement-breakpoint
CREATE INDEX `resend_webhook_events_notification_idx` ON `resend_webhook_events` (`notification_id`);--> statement-breakpoint
ALTER TABLE `notification_outbox` ADD `delivery_status` text;--> statement-breakpoint
ALTER TABLE `notification_outbox` ADD `delivered_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_outbox_provider_message_idx` ON `notification_outbox` (`provider_message_id`);