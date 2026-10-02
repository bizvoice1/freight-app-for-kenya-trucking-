-- Phase 5E-1 (hand-written). Database-level enforcement of the gate/loading evidence contract so no
-- future code path (or concurrent request) can forge, replay or rewrite evidence. Each RAISE message
-- is a stable token the service maps to an API error code. Nothing here references payments,
-- escrows (read-only funded check) or payouts for writing.

-- ── loading sites ───────────────────────────────────────────────────────────
-- Sites are deactivated, never deleted: events reference them forever.
CREATE TRIGGER `loading_sites_no_delete`
BEFORE DELETE ON `loading_sites`
BEGIN SELECT RAISE(ABORT, 'GATE_SITE_NO_DELETE'); END;
--> statement-breakpoint
-- A load may only point at a real site.
CREATE TRIGGER `loads_pickup_site_exists_insert`
BEFORE INSERT ON `loads`
WHEN NEW.`pickup_site_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `loading_sites` WHERE `id` = NEW.`pickup_site_id`)
BEGIN SELECT RAISE(ABORT, 'GATE_SITE_NOT_FOUND'); END;
--> statement-breakpoint
CREATE TRIGGER `loads_pickup_site_exists_update`
BEFORE UPDATE OF `pickup_site_id` ON `loads`
WHEN NEW.`pickup_site_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `loading_sites` WHERE `id` = NEW.`pickup_site_id`)
BEGIN SELECT RAISE(ABORT, 'GATE_SITE_NOT_FOUND'); END;
--> statement-breakpoint
-- Once any gate evidence exists for a load's trip, its site can no longer move.
CREATE TRIGGER `loads_pickup_site_frozen_after_evidence`
BEFORE UPDATE OF `pickup_site_id` ON `loads`
WHEN NEW.`pickup_site_id` IS NOT OLD.`pickup_site_id`
 AND EXISTS (SELECT 1 FROM `gate_events` e JOIN `trips` t ON t.`id` = e.`trip_id` WHERE t.`load_id` = OLD.`id`)
BEGIN SELECT RAISE(ABORT, 'GATE_SITE_FROZEN'); END;
--> statement-breakpoint

-- ── agent ↔ site authorization ──────────────────────────────────────────────
CREATE TRIGGER `loading_agent_sites_valid_agent`
BEFORE INSERT ON `loading_agent_sites`
WHEN NOT EXISTS (SELECT 1 FROM `users` WHERE `id` = NEW.`agent_user_id` AND `role` = 'loading_agent')
BEGIN SELECT RAISE(ABORT, 'GATE_NOT_AN_AGENT'); END;
--> statement-breakpoint
CREATE TRIGGER `loading_agent_sites_valid_site`
BEFORE INSERT ON `loading_agent_sites`
WHEN NOT EXISTS (SELECT 1 FROM `loading_sites` WHERE `id` = NEW.`site_id`)
BEGIN SELECT RAISE(ABORT, 'GATE_SITE_NOT_FOUND'); END;
--> statement-breakpoint
-- To change an assignment, delete and re-create it.
CREATE TRIGGER `loading_agent_sites_immutable`
BEFORE UPDATE ON `loading_agent_sites`
BEGIN SELECT RAISE(ABORT, 'GATE_ASSIGNMENT_IMMUTABLE'); END;
--> statement-breakpoint

-- ── gate tokens ─────────────────────────────────────────────────────────────
CREATE TRIGGER `gate_tokens_valid_insert`
BEFORE INSERT ON `gate_tokens`
WHEN NOT EXISTS (SELECT 1 FROM `trips` WHERE `id` = NEW.`trip_id`)
  OR NEW.`consumed_at` IS NOT NULL OR NEW.`revoked_at` IS NOT NULL OR NEW.`consumed_by_user_id` IS NOT NULL
  OR NEW.`expires_at` <= NEW.`issued_at`
BEGIN SELECT RAISE(ABORT, 'GATE_TOKEN_BAD_INSERT'); END;
--> statement-breakpoint
CREATE TRIGGER `gate_tokens_core_immutable`
BEFORE UPDATE OF `id`, `trip_id`, `purpose`, `token_hash`, `issued_to_user_id`, `issued_at`, `expires_at` ON `gate_tokens`
WHEN NEW.`id` IS NOT OLD.`id` OR NEW.`trip_id` IS NOT OLD.`trip_id` OR NEW.`purpose` IS NOT OLD.`purpose`
  OR NEW.`token_hash` IS NOT OLD.`token_hash` OR NEW.`issued_to_user_id` IS NOT OLD.`issued_to_user_id`
  OR NEW.`issued_at` IS NOT OLD.`issued_at` OR NEW.`expires_at` IS NOT OLD.`expires_at`
BEGIN SELECT RAISE(ABORT, 'GATE_TOKEN_IMMUTABLE'); END;
--> statement-breakpoint
-- A token that has been consumed or revoked never changes again (no un-consume, no revoke-after-consume).
CREATE TRIGGER `gate_tokens_closed_is_final`
BEFORE UPDATE OF `consumed_at`, `consumed_by_user_id`, `revoked_at`, `revoke_reason` ON `gate_tokens`
WHEN (OLD.`consumed_at` IS NOT NULL OR OLD.`revoked_at` IS NOT NULL)
 AND (NEW.`consumed_at` IS NOT OLD.`consumed_at` OR NEW.`consumed_by_user_id` IS NOT OLD.`consumed_by_user_id`
   OR NEW.`revoked_at` IS NOT OLD.`revoked_at` OR NEW.`revoke_reason` IS NOT OLD.`revoke_reason`)
BEGIN SELECT RAISE(ABORT, 'GATE_TOKEN_CLOSED'); END;
--> statement-breakpoint
-- Consumption needs a consumer, may not follow revocation, and may not happen after expiry.
CREATE TRIGGER `gate_tokens_valid_consume`
BEFORE UPDATE OF `consumed_at` ON `gate_tokens`
WHEN NEW.`consumed_at` IS NOT NULL AND OLD.`consumed_at` IS NULL
 AND (NEW.`consumed_by_user_id` IS NULL OR NEW.`revoked_at` IS NOT NULL OR NEW.`consumed_at` > OLD.`expires_at`)
BEGIN SELECT RAISE(ABORT, 'GATE_TOKEN_INVALID_CONSUME'); END;
--> statement-breakpoint
CREATE TRIGGER `gate_tokens_no_delete`
BEFORE DELETE ON `gate_tokens`
BEGIN SELECT RAISE(ABORT, 'GATE_TOKEN_NO_DELETE'); END;
--> statement-breakpoint

-- ── gate events: append-only evidence ───────────────────────────────────────
CREATE TRIGGER `gate_events_no_update`
BEFORE UPDATE ON `gate_events`
BEGIN SELECT RAISE(ABORT, 'GATE_EVENT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `gate_events_no_delete`
BEFORE DELETE ON `gate_events`
BEGIN SELECT RAISE(ABORT, 'GATE_EVENT_IMMUTABLE'); END;
--> statement-breakpoint
-- The denormalized assignment on the event must equal the trip's canonical assignment.
CREATE TRIGGER `gate_events_assignment_matches_trip`
BEFORE INSERT ON `gate_events`
WHEN NOT EXISTS (SELECT 1 FROM `trips` WHERE `id` = NEW.`trip_id` AND `booking_id` IS NEW.`booking_id`
                  AND `truck_id` = NEW.`truck_id` AND `driver_id` = NEW.`driver_id`)
BEGIN SELECT RAISE(ABORT, 'GATE_ASSIGNMENT_MISMATCH'); END;
--> statement-breakpoint
-- The event type fixes the only legal before/after trip statuses, and the trip must currently be in `before`.
CREATE TRIGGER `gate_events_legal_transition`
BEFORE INSERT ON `gate_events`
WHEN NOT ((NEW.`event_type` = 'GATE_IN'           AND NEW.`trip_status_before` = 'At Pickup' AND NEW.`trip_status_after` = 'At Pickup')
       OR (NEW.`event_type` = 'LOADING_STARTED'   AND NEW.`trip_status_before` = 'At Pickup' AND NEW.`trip_status_after` = 'Loading')
       OR (NEW.`event_type` = 'LOADING_COMPLETED' AND NEW.`trip_status_before` = 'Loading'   AND NEW.`trip_status_after` = 'In Transit'))
BEGIN SELECT RAISE(ABORT, 'GATE_BAD_TRANSITION'); END;
--> statement-breakpoint
CREATE TRIGGER `gate_events_trip_in_expected_state`
BEFORE INSERT ON `gate_events`
WHEN NOT EXISTS (SELECT 1 FROM `trips` WHERE `id` = NEW.`trip_id` AND `status` = NEW.`trip_status_before`)
BEGIN SELECT RAISE(ABORT, 'GATE_TRIP_STATE_MISMATCH'); END;
--> statement-breakpoint
-- The event must be backed by a token for this trip, of the matching purpose, already consumed by this
-- very agent and never revoked. Single-purpose: GATE_IN->GATE_IN, LOADING_START->LOADING_STARTED, LOADING_COMPLETE->LOADING_COMPLETED.
CREATE TRIGGER `gate_events_backed_by_consumed_token`
BEFORE INSERT ON `gate_events`
WHEN NOT EXISTS (SELECT 1 FROM `gate_tokens` WHERE `id` = NEW.`token_id` AND `trip_id` = NEW.`trip_id`
                  AND `purpose` = NEW.`token_purpose` AND `consumed_at` IS NOT NULL
                  AND `consumed_by_user_id` = NEW.`agent_user_id` AND `revoked_at` IS NULL)
  OR NOT ((NEW.`event_type` = 'GATE_IN' AND NEW.`token_purpose` = 'GATE_IN')
       OR (NEW.`event_type` = 'LOADING_STARTED' AND NEW.`token_purpose` = 'LOADING_START')
       OR (NEW.`event_type` = 'LOADING_COMPLETED' AND NEW.`token_purpose` = 'LOADING_COMPLETE'))
BEGIN SELECT RAISE(ABORT, 'GATE_TOKEN_INVALID'); END;
--> statement-breakpoint
-- Site authority: the trip's load resolves to exactly this active site, and this agent is assigned to it.
CREATE TRIGGER `gate_events_site_matches_load`
BEFORE INSERT ON `gate_events`
WHEN NOT EXISTS (SELECT 1 FROM `trips` t JOIN `loads` l ON l.`id` = t.`load_id`
                  WHERE t.`id` = NEW.`trip_id` AND l.`pickup_site_id` = NEW.`site_id`)
BEGIN SELECT RAISE(ABORT, 'GATE_SITE_MISMATCH'); END;
--> statement-breakpoint
CREATE TRIGGER `gate_events_site_active`
BEFORE INSERT ON `gate_events`
WHEN NOT EXISTS (SELECT 1 FROM `loading_sites` WHERE `id` = NEW.`site_id` AND `active` = 1)
BEGIN SELECT RAISE(ABORT, 'GATE_SITE_INACTIVE'); END;
--> statement-breakpoint
CREATE TRIGGER `gate_events_agent_authorized`
BEFORE INSERT ON `gate_events`
WHEN NOT EXISTS (SELECT 1 FROM `loading_agent_sites` WHERE `agent_user_id` = NEW.`agent_user_id` AND `site_id` = NEW.`site_id`)
  OR NOT EXISTS (SELECT 1 FROM `users` WHERE `id` = NEW.`agent_user_id` AND `role` = 'loading_agent')
BEGIN SELECT RAISE(ABORT, 'GATE_AGENT_NOT_AUTHORIZED'); END;
--> statement-breakpoint
-- No freight movement from an unfunded booking: escrow must be Held, and the snapshot must say so truthfully.
CREATE TRIGGER `gate_events_booking_funded`
BEFORE INSERT ON `gate_events`
WHEN NEW.`booking_funded` IS NOT 1
  OR NOT EXISTS (SELECT 1 FROM `escrows` WHERE `booking_id` = NEW.`booking_id` AND `status` = 'Held')
BEGIN SELECT RAISE(ABORT, 'GATE_NOT_FUNDED'); END;
--> statement-breakpoint
-- Loading can only start after gate entry, and complete after it started.
CREATE TRIGGER `gate_events_sequence`
BEFORE INSERT ON `gate_events`
WHEN (NEW.`event_type` = 'LOADING_STARTED' AND NOT EXISTS (SELECT 1 FROM `gate_events` WHERE `trip_id` = NEW.`trip_id` AND `event_type` = 'GATE_IN'))
  OR (NEW.`event_type` = 'LOADING_COMPLETED' AND NOT EXISTS (SELECT 1 FROM `gate_events` WHERE `trip_id` = NEW.`trip_id` AND `event_type` = 'LOADING_STARTED'))
BEGIN SELECT RAISE(ABORT, 'GATE_SEQUENCE'); END;
--> statement-breakpoint
-- An unavailable location is recorded as unavailable, never as a passed check. A stale-but-present fix
-- keeps its distance/age but inside_site_geofence stays NULL (not evaluated).
CREATE TRIGGER `gate_events_location_honest`
BEFORE INSERT ON `gate_events`
WHEN (NEW.`driver_location_available` NOT IN (0, 1))
  OR (NEW.`driver_location_available` = 0 AND (NEW.`driver_distance_from_site_meters` IS NOT NULL OR NEW.`inside_site_geofence` IS NOT NULL OR NEW.`location_age_seconds` IS NOT NULL))
  OR (NEW.`driver_location_available` = 1 AND (NEW.`driver_distance_from_site_meters` IS NULL OR NEW.`location_age_seconds` IS NULL))
  OR (NEW.`inside_site_geofence` IS NOT NULL AND NEW.`inside_site_geofence` NOT IN (0, 1))
BEGIN SELECT RAISE(ABORT, 'GATE_LOCATION_INCONSISTENT'); END;

--> statement-breakpoint
-- drizzle-kit does not emit CHECK constraints, so value-domain rules live here (same as 5D-2).
CREATE TRIGGER `loading_sites_valid_insert`
BEFORE INSERT ON `loading_sites`
WHEN NEW.`radius_meters` <= 0 OR NEW.`lat` NOT BETWEEN -90 AND 90 OR NEW.`lng` NOT BETWEEN -180 AND 180 OR NEW.`active` NOT IN (0, 1)
BEGIN SELECT RAISE(ABORT, 'GATE_SITE_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER `loading_sites_valid_update`
BEFORE UPDATE ON `loading_sites`
WHEN NEW.`radius_meters` <= 0 OR NEW.`lat` NOT BETWEEN -90 AND 90 OR NEW.`lng` NOT BETWEEN -180 AND 180 OR NEW.`active` NOT IN (0, 1)
BEGIN SELECT RAISE(ABORT, 'GATE_SITE_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER `gate_tokens_valid_purpose`
BEFORE INSERT ON `gate_tokens`
WHEN NEW.`purpose` NOT IN ('GATE_IN', 'LOADING_START', 'LOADING_COMPLETE')
BEGIN SELECT RAISE(ABORT, 'GATE_TOKEN_BAD_INSERT'); END;
--> statement-breakpoint
CREATE TRIGGER `gate_events_valid_type`
BEFORE INSERT ON `gate_events`
WHEN NEW.`event_type` NOT IN ('GATE_IN', 'LOADING_STARTED', 'LOADING_COMPLETED')
BEGIN SELECT RAISE(ABORT, 'GATE_BAD_TRANSITION'); END;
