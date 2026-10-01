ALTER TABLE `payment_events` ADD `request_id` text;--> statement-breakpoint
CREATE INDEX `bookings_transporter_id_idx` ON `bookings` (`transporter_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_load_id_unique` ON `bookings` (`load_id`);--> statement-breakpoint
CREATE INDEX `loads_shipper_id_idx` ON `loads` (`shipper_id`);--> statement-breakpoint
CREATE INDEX `notifications_user_id_idx` ON `notifications` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_one_inflight_per_booking` ON `payments` (`booking_id`) WHERE "payments"."status" in ('Pending', 'StkSent');--> statement-breakpoint
CREATE INDEX `trips_load_id_idx` ON `trips` (`load_id`);--> statement-breakpoint
CREATE INDEX `trips_truck_id_idx` ON `trips` (`truck_id`);--> statement-breakpoint
CREATE INDEX `trips_driver_id_idx` ON `trips` (`driver_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `trips_booking_id_unique` ON `trips` (`booking_id`);