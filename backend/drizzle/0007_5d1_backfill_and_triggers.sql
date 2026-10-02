-- Phase 5D-1 (hand-written). Backfill FIRST, then the immutability triggers, so the
-- one-time legacy backfill of bookings.agreed_amount is not blocked by its own trigger.
UPDATE `bookings`
   SET `agreed_amount` = (SELECT `price` FROM `loads` WHERE `loads`.`id` = `bookings`.`load_id`),
       `agreement_source` = 'POSTED_PRICE'
 WHERE `agreed_amount` IS NULL
   AND `agreement_source` IS NULL;
--> statement-breakpoint
CREATE TRIGGER `loads_price_immutable`
BEFORE UPDATE OF `price` ON `loads`
WHEN OLD.`price` IS NOT NEW.`price`
BEGIN SELECT RAISE(ABORT, 'loads.price is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `bookings_agreed_amount_immutable`
BEFORE UPDATE OF `agreed_amount` ON `bookings`
WHEN OLD.`agreed_amount` IS NOT NULL AND NEW.`agreed_amount` IS NOT OLD.`agreed_amount`
BEGIN SELECT RAISE(ABORT, 'bookings.agreed_amount is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `payments_amount_immutable`
BEFORE UPDATE OF `amount` ON `payments`
WHEN NEW.`amount` IS NOT OLD.`amount`
BEGIN SELECT RAISE(ABORT, 'payments.amount is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `offers_amount_immutable`
BEFORE UPDATE OF `amount` ON `offers`
WHEN NEW.`amount` IS NOT OLD.`amount`
BEGIN SELECT RAISE(ABORT, 'offers.amount is immutable'); END;
