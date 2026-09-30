CREATE TABLE `drivers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`license_number` text,
	`assigned_truck_id` text,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fleet_owners` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`company` text
);
--> statement-breakpoint
CREATE TABLE `location_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`truck_id` text NOT NULL,
	`driver_id` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`accuracy` real,
	`speed` real,
	`heading` real,
	`source` text NOT NULL,
	`timestamp` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trips` (
	`id` text PRIMARY KEY NOT NULL,
	`load_id` text,
	`booking_id` text,
	`truck_id` text NOT NULL,
	`driver_id` text NOT NULL,
	`status` text NOT NULL,
	`pickup` text,
	`delivery` text,
	`started_at` text,
	`completed_at` text,
	`latest_location_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trucks` (
	`id` text PRIMARY KEY NOT NULL,
	`plate` text NOT NULL,
	`truck_type` text,
	`capacity` text,
	`owner_id` text,
	`current_driver_id` text,
	`status` text NOT NULL,
	`current_lat` real,
	`current_lng` real,
	FOREIGN KEY (`owner_id`) REFERENCES `fleet_owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`phone` text NOT NULL,
	`pin_hash` text NOT NULL,
	`role` text NOT NULL,
	`name` text NOT NULL,
	`driver_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_phone_role_unique` ON `users` (`phone`,`role`);