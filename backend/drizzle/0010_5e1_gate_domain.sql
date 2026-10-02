CREATE TABLE `gate_events` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`booking_id` text NOT NULL,
	`truck_id` text NOT NULL,
	`driver_id` text NOT NULL,
	`site_id` text NOT NULL,
	`agent_user_id` text NOT NULL,
	`event_type` text NOT NULL,
	`token_id` text NOT NULL,
	`token_purpose` text NOT NULL,
	`trip_status_before` text NOT NULL,
	`trip_status_after` text NOT NULL,
	`booking_funded` integer NOT NULL,
	`driver_location_available` integer NOT NULL,
	`driver_distance_from_site_meters` real,
	`inside_site_geofence` integer,
	`location_age_seconds` integer,
	`snapshot` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gate_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`purpose` text NOT NULL,
	`token_hash` text NOT NULL,
	`issued_to_user_id` text NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`consumed_by_user_id` text,
	`revoked_at` text,
	`revoke_reason` text
);
--> statement-breakpoint
CREATE TABLE `loading_agent_sites` (
	`agent_user_id` text NOT NULL,
	`site_id` text NOT NULL,
	`created_by_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `loading_sites` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`radius_meters` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `loads` ADD `pickup_site_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `gate_events_one_type_per_trip` ON `gate_events` (`trip_id`,`event_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `gate_events_token_unique` ON `gate_events` (`token_id`);--> statement-breakpoint
CREATE INDEX `gate_events_trip_idx` ON `gate_events` (`trip_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `gate_tokens_hash_unique` ON `gate_tokens` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `gate_tokens_one_active_per_trip` ON `gate_tokens` (`trip_id`) WHERE "gate_tokens"."consumed_at" is null and "gate_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX `gate_tokens_trip_idx` ON `gate_tokens` (`trip_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `loading_agent_sites_pk` ON `loading_agent_sites` (`agent_user_id`,`site_id`);--> statement-breakpoint
CREATE INDEX `loading_agent_sites_site_idx` ON `loading_agent_sites` (`site_id`);