-- Phase 5D-2 (hand-written). Database-level enforcement of the adjustment contract so no
-- future code path (or concurrent request) can violate it. Each RAISE message is a stable
-- token the service maps to an API error code.

-- An adjustment must reference a real booking, and its basis snapshot must equal that booking's agreed amount.
CREATE TRIGGER `adjustments_booking_must_exist`
BEFORE INSERT ON `adjustments`
WHEN NOT EXISTS (SELECT 1 FROM `bookings` WHERE `id` = NEW.`booking_id`)
BEGIN SELECT RAISE(ABORT, 'ADJ_BOOKING_NOT_FOUND'); END;
--> statement-breakpoint
CREATE TRIGGER `adjustments_snapshot_matches_booking`
BEFORE INSERT ON `adjustments`
WHEN NEW.`agreed_amount_snapshot` IS NOT (SELECT `agreed_amount` FROM `bookings` WHERE `id` = NEW.`booking_id`)
BEGIN SELECT RAISE(ABORT, 'ADJ_SNAPSHOT_MISMATCH'); END;
--> statement-breakpoint
-- New rows are born PROPOSED only.
CREATE TRIGGER `adjustments_insert_status`
BEFORE INSERT ON `adjustments`
WHEN NEW.`status` IS NOT 'PROPOSED'
BEGIN SELECT RAISE(ABORT, 'ADJ_BAD_INITIAL_STATUS'); END;
--> statement-breakpoint
-- Cumulative positive adjustments (approved/funding/funded + this one) may not exceed the snapshot cap.
CREATE TRIGGER `adjustments_cap_on_insert`
BEFORE INSERT ON `adjustments`
WHEN (SELECT COALESCE(SUM(`amount`), 0) FROM `adjustments`
       WHERE `booking_id` = NEW.`booking_id` AND `status` IN ('APPROVED', 'FUNDING', 'FUNDED'))
     + NEW.`amount` > NEW.`agreed_amount_snapshot` * NEW.`cap_snapshot_pct` / 100.0 + 0.000001
BEGIN SELECT RAISE(ABORT, 'ADJ_CAP_EXCEEDED'); END;
--> statement-breakpoint
-- Same cap re-checked at the moment an adjustment becomes APPROVED.
CREATE TRIGGER `adjustments_cap_on_approve`
BEFORE UPDATE OF `status` ON `adjustments`
WHEN NEW.`status` = 'APPROVED' AND OLD.`status` = 'PROPOSED'
 AND (SELECT COALESCE(SUM(`amount`), 0) FROM `adjustments`
       WHERE `booking_id` = NEW.`booking_id` AND `id` IS NOT NEW.`id` AND `status` IN ('APPROVED', 'FUNDING', 'FUNDED'))
     + NEW.`amount` > NEW.`agreed_amount_snapshot` * NEW.`cap_snapshot_pct` / 100.0 + 0.000001
BEGIN SELECT RAISE(ABORT, 'ADJ_CAP_EXCEEDED'); END;
--> statement-breakpoint
-- No new adjustment, and no approval of a pending one, once the booking's trip is Delivered.
CREATE TRIGGER `adjustments_no_create_after_delivery`
BEFORE INSERT ON `adjustments`
WHEN EXISTS (SELECT 1 FROM `trips` WHERE `booking_id` = NEW.`booking_id` AND `status` = 'Delivered')
BEGIN SELECT RAISE(ABORT, 'ADJ_AFTER_DELIVERY'); END;
--> statement-breakpoint
CREATE TRIGGER `adjustments_no_approve_after_delivery`
BEFORE UPDATE OF `status` ON `adjustments`
WHEN NEW.`status` = 'APPROVED' AND OLD.`status` = 'PROPOSED'
 AND EXISTS (SELECT 1 FROM `trips` WHERE `booking_id` = NEW.`booking_id` AND `status` = 'Delivered')
BEGIN SELECT RAISE(ABORT, 'ADJ_AFTER_DELIVERY'); END;
--> statement-breakpoint
-- Commercial fields are frozen at creation; only status and lifecycle columns move.
CREATE TRIGGER `adjustments_commercial_immutable`
BEFORE UPDATE OF `booking_id`, `requested_by_id`, `amount`, `agreed_amount_snapshot`, `cap_snapshot_pct`,
                 `reason_code`, `reason`, `source`, `source_ref`, `created_at` ON `adjustments`
WHEN NEW.`booking_id` IS NOT OLD.`booking_id`
  OR NEW.`requested_by_id` IS NOT OLD.`requested_by_id`
  OR NEW.`amount` IS NOT OLD.`amount`
  OR NEW.`agreed_amount_snapshot` IS NOT OLD.`agreed_amount_snapshot`
  OR NEW.`cap_snapshot_pct` IS NOT OLD.`cap_snapshot_pct`
  OR NEW.`reason_code` IS NOT OLD.`reason_code`
  OR NEW.`reason` IS NOT OLD.`reason`
  OR NEW.`source` IS NOT OLD.`source`
  OR NEW.`source_ref` IS NOT OLD.`source_ref`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN SELECT RAISE(ABORT, 'ADJ_IMMUTABLE'); END;
--> statement-breakpoint
-- Terminal states never change.
CREATE TRIGGER `adjustments_terminal_status`
BEFORE UPDATE OF `status` ON `adjustments`
WHEN OLD.`status` IN ('FUNDED', 'REJECTED', 'WITHDRAWN', 'EXPIRED') AND NEW.`status` IS NOT OLD.`status`
BEGIN SELECT RAISE(ABORT, 'ADJ_TERMINAL'); END;
--> statement-breakpoint
-- Adjustment payments: purpose and adjustment_id agree, the adjustment belongs to the same booking,
-- and the amount equals the adjustment's amount (never anything else).
CREATE TRIGGER `payments_purpose_consistent`
BEFORE INSERT ON `payments`
WHEN NOT ((NEW.`purpose` = 'INITIAL' AND NEW.`adjustment_id` IS NULL)
       OR (NEW.`purpose` = 'ADJUSTMENT' AND NEW.`adjustment_id` IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'PAY_PURPOSE_MISMATCH'); END;
--> statement-breakpoint
CREATE TRIGGER `payments_adjustment_valid`
BEFORE INSERT ON `payments`
WHEN NEW.`purpose` = 'ADJUSTMENT'
 AND NOT EXISTS (SELECT 1 FROM `adjustments` WHERE `id` = NEW.`adjustment_id`
                  AND `booking_id` = NEW.`booking_id` AND `amount` = NEW.`amount`)
BEGIN SELECT RAISE(ABORT, 'PAY_ADJUSTMENT_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER `payments_purpose_immutable`
BEFORE UPDATE OF `purpose`, `adjustment_id`, `booking_id` ON `payments`
WHEN NEW.`purpose` IS NOT OLD.`purpose` OR NEW.`adjustment_id` IS NOT OLD.`adjustment_id` OR NEW.`booking_id` IS NOT OLD.`booking_id`
BEGIN SELECT RAISE(ABORT, 'PAY_PURPOSE_IMMUTABLE'); END;
