/**
 * backend/src/domain/booking.js
 * ---------------------------------
 * Phase 4H — the bridge between a Load and a Trip.
 *
 * Booking != Trip:
 *   "Accepted"     -> a transporter has accepted the load. No truck/driver yet.
 *   "Assigned"     -> truckId AND driverId are both set (still not a Trip).
 *   "Trip Created" -> tripId is set — models/trip.js's createTrip() has run.
 *   "Cancelled"    -> terminal.
 *
 * That distinction matters once escrow (Phase 4K) arrives: money will bind
 * to the Booking (the commercial commitment), while GPS/execution state
 * binds to the Trip — conflating them now would make that split painful
 * later.
 */

export const BOOKING_STATUS = {
  ACCEPTED:     "Accepted",
  ASSIGNED:     "Assigned",
  TRIP_CREATED: "Trip Created",
  CANCELLED:    "Cancelled",
};

export function generateBookingId(existingCount) {
  return `BHB-${1000 + existingCount}`;
}

/** @param {{loadId:string, transporterId:string, agreedRoadDistanceMeters:number}} data */
export function createBooking({ loadId, transporterId, agreedRoadDistanceMeters }, existingCount) {
  const now = new Date().toISOString();
  return {
    id:            generateBookingId(existingCount),
    loadId,
    transporterId,
    truckId:       null,
    driverId:      null,
    tripId:        null,
    agreedRoadDistanceMeters, // 5C-3 immutable snapshot of loads.distance_meters
    status:        BOOKING_STATUS.ACCEPTED,
    createdAt:     now,
    updatedAt:     now,
  };
}
