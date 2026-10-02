CREATE TABLE `adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`requested_by_id` text NOT NULL,
	`amount` real NOT NULL,
	`agreed_amount_snapshot` real NOT NULL,
	`cap_snapshot_pct` real NOT NULL,
	`reason_code` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`close_reason` text,
	`source` text DEFAULT 'MANUAL' NOT NULL,
	`source_ref` text,
	`approval_expires_at` text NOT NULL,
	`funding_due_at` text,
	`approved_by_id` text,
	`approved_at` text,
	`rejected_by_id` text,
	`rejected_at` text,
	`reject_reason` text,
	`withdrawn_at` text,
	`expired_at` text,
	`paid_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `adjustments_amount_positive` CHECK (`amount` > 0)
);
--> statement-breakpoint
ALTER TABLE `payments` ADD `adjustment_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `adjustments_one_open_per_booking` ON `adjustments` (`booking_id`) WHERE "adjustments"."status" in ('PROPOSED', 'APPROVED', 'FUNDING', 'DISPUTED');--> statement-breakpoint
CREATE UNIQUE INDEX `adjustments_booking_source_ref_unique` ON `adjustments` (`booking_id`,`source_ref`) WHERE "adjustments"."source_ref" is not null;--> statement-breakpoint
CREATE INDEX `adjustments_booking_id_idx` ON `adjustments` (`booking_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_one_paid_initial_per_booking` ON `payments` (`booking_id`) WHERE "payments"."purpose" = 'INITIAL' and "payments"."status" = 'Paid';--> statement-breakpoint
CREATE UNIQUE INDEX `payments_one_paid_per_adjustment` ON `payments` (`adjustment_id`) WHERE "payments"."status" = 'Paid';