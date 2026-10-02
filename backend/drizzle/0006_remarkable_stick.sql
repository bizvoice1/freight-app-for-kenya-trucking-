CREATE TABLE `offers` (
	`id` text PRIMARY KEY NOT NULL,
	`load_id` text NOT NULL,
	`transporter_id` text NOT NULL,
	`round` integer NOT NULL,
	`proposer_role` text NOT NULL,
	`proposer_id` text NOT NULL,
	`amount` real NOT NULL,
	`note` text,
	`status` text NOT NULL,
	`close_reason` text,
	`expires_at` text NOT NULL,
	`parent_offer_id` text,
	`idempotency_key` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`resolved_at` text,
	CONSTRAINT `offers_round_range` CHECK (`round` BETWEEN 1 AND 5)
);
--> statement-breakpoint
ALTER TABLE `bookings` ADD `agreed_amount` real;--> statement-breakpoint
ALTER TABLE `bookings` ADD `agreement_source` text;--> statement-breakpoint
ALTER TABLE `bookings` ADD `agreed_offer_id` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `purpose` text DEFAULT 'INITIAL' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `offers_thread_round_unique` ON `offers` (`load_id`,`transporter_id`,`round`);--> statement-breakpoint
CREATE UNIQUE INDEX `offers_one_pending_per_thread` ON `offers` (`load_id`,`transporter_id`) WHERE "offers"."status" = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX `offers_one_accepted_per_load` ON `offers` (`load_id`) WHERE "offers"."status" = 'ACCEPTED';--> statement-breakpoint
CREATE UNIQUE INDEX `offers_proposer_idempotency_unique` ON `offers` (`proposer_id`,`idempotency_key`) WHERE "offers"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX `offers_load_id_idx` ON `offers` (`load_id`);--> statement-breakpoint
CREATE INDEX `offers_transporter_id_idx` ON `offers` (`transporter_id`);--> statement-breakpoint
CREATE INDEX `offers_status_expires_idx` ON `offers` (`status`,`expires_at`);