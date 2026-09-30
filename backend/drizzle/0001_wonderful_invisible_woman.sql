CREATE TABLE `escrows` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`payment_id` text,
	`amount` real,
	`status` text NOT NULL,
	`held_at` text,
	`release_pending_at` text,
	`release_in_progress_at` text,
	`settled_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`event_type` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`payload` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`shipper_id` text NOT NULL,
	`amount` real NOT NULL,
	`phone_number` text NOT NULL,
	`status` text NOT NULL,
	`merchant_request_id` text,
	`checkout_request_id` text,
	`mpesa_receipt_number` text,
	`result_code` integer,
	`result_desc` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payouts` (
	`id` text PRIMARY KEY NOT NULL,
	`escrow_id` text NOT NULL,
	`transporter_id` text NOT NULL,
	`amount` real NOT NULL,
	`phone_number` text NOT NULL,
	`status` text NOT NULL,
	`conversation_id` text,
	`originator_conversation_id` text,
	`transaction_id` text,
	`result_code` integer,
	`result_desc` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reconciliation_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`related_entity_type` text,
	`related_entity_id` text,
	`raw_payload` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `escrows_booking_id_unique` ON `escrows` (`booking_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_checkout_request_id_unique` ON `payments` (`checkout_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_mpesa_receipt_number_unique` ON `payments` (`mpesa_receipt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `payouts_conversation_id_unique` ON `payouts` (`conversation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payouts_transaction_id_unique` ON `payouts` (`transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payouts_one_confirmed_per_escrow` ON `payouts` (`escrow_id`) WHERE "payouts"."status" = 'Confirmed';--> statement-breakpoint
CREATE UNIQUE INDEX `payouts_one_inflight_per_escrow` ON `payouts` (`escrow_id`) WHERE "payouts"."status" in ('Pending', 'Requested');