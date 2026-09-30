CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`related_entity_type` text,
	`related_entity_id` text,
	`read` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
