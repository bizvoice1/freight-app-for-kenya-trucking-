ALTER TABLE `bookings` ADD `agreed_road_distance_meters` integer;--> statement-breakpoint
ALTER TABLE `loads` ADD `distance_meters` integer;--> statement-breakpoint
ALTER TABLE `loads` ADD `route_polyline` text;--> statement-breakpoint
ALTER TABLE `loads` ADD `route_duration_sec` integer;--> statement-breakpoint
ALTER TABLE `loads` ADD `distance_source` text;--> statement-breakpoint
CREATE TRIGGER `loads_route_consistent_ins` BEFORE INSERT ON `loads`
WHEN NOT ((NEW.distance_source IS NULL AND NEW.distance_meters IS NULL AND NEW.route_polyline IS NULL AND NEW.route_duration_sec IS NULL)
       OR (NEW.distance_source = 'ROAD' AND NEW.distance_meters > 0))
BEGIN SELECT RAISE(ABORT, 'loads: route fields inconsistent (ROAD needs distance_meters > 0; otherwise all null)'); END;
--> statement-breakpoint
CREATE TRIGGER `loads_route_consistent_upd` BEFORE UPDATE ON `loads`
WHEN NOT ((NEW.distance_source IS NULL AND NEW.distance_meters IS NULL AND NEW.route_polyline IS NULL AND NEW.route_duration_sec IS NULL)
       OR (NEW.distance_source = 'ROAD' AND NEW.distance_meters > 0))
BEGIN SELECT RAISE(ABORT, 'loads: route fields inconsistent (ROAD needs distance_meters > 0; otherwise all null)'); END;
--> statement-breakpoint
CREATE TRIGGER `loads_route_immutable` BEFORE UPDATE ON `loads`
WHEN OLD.distance_meters IS NOT NULL AND (
     NEW.distance_meters IS NOT OLD.distance_meters OR NEW.route_polyline IS NOT OLD.route_polyline
  OR NEW.route_duration_sec IS NOT OLD.route_duration_sec OR NEW.distance_source IS NOT OLD.distance_source
  OR NEW.pickup_lat IS NOT OLD.pickup_lat OR NEW.pickup_lng IS NOT OLD.pickup_lng
  OR NEW.delivery_lat IS NOT OLD.delivery_lat OR NEW.delivery_lng IS NOT OLD.delivery_lng)
BEGIN SELECT RAISE(ABORT, 'loads: the stored road route is immutable once set'); END;
--> statement-breakpoint
CREATE TRIGGER `bookings_agreed_distance_valid_ins` BEFORE INSERT ON `bookings`
WHEN NEW.agreed_road_distance_meters IS NOT NULL AND NEW.agreed_road_distance_meters <= 0
BEGIN SELECT RAISE(ABORT, 'bookings: agreed_road_distance_meters must be positive'); END;
--> statement-breakpoint
CREATE TRIGGER `bookings_agreed_distance_immutable` BEFORE UPDATE OF agreed_road_distance_meters ON `bookings`
WHEN OLD.agreed_road_distance_meters IS NOT NULL AND NEW.agreed_road_distance_meters IS NOT OLD.agreed_road_distance_meters
BEGIN SELECT RAISE(ABORT, 'bookings: agreed_road_distance_meters is immutable once set'); END;
