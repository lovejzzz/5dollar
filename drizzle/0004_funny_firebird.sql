CREATE TABLE `gift_card_rewards` (
	`task_id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'tremendous' NOT NULL,
	`order_id` text NOT NULL,
	`reward_id` text NOT NULL,
	`status` text DEFAULT 'ISSUED' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `funded_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "gift_card_rewards_provider_check" CHECK("gift_card_rewards"."provider" = 'tremendous'),
	CONSTRAINT "gift_card_rewards_status_check" CHECK("gift_card_rewards"."status" IN ('ISSUED', 'DELIVERY_PENDING', 'DELIVERED', 'CANCELED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gift_card_rewards_order_idx` ON `gift_card_rewards` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `gift_card_rewards_reward_idx` ON `gift_card_rewards` (`reward_id`);--> statement-breakpoint
CREATE INDEX `gift_card_rewards_status_idx` ON `gift_card_rewards` (`status`,`updated_at`);