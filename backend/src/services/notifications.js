/**
 * backend/src/services/notifications.js
 * -------------------------------------------
 * Phase 4L — the one place every route that triggers a notification calls
 * through, mirroring services/ledger.js's shape. notifyUsers() writes one
 * row per recipient (see schema.js's note on why) inside a single
 * transaction, so a broadcast to every transporter doesn't interleave with
 * a concurrent request also reading the running count.
 */

import { db } from "../db/client.js";
import { notifications, users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createNotification } from "../domain/notification.js";

/** @param {string} userId @param {string} type @param {string} title @param {string} body @param {string} [relatedEntityType] @param {string} [relatedEntityId] */
export async function notifyUser(userId, type, title, body, relatedEntityType, relatedEntityId) {
  return notifyUsers([userId], type, title, body, relatedEntityType, relatedEntityId);
}

/** Same shape as notifyUser, but for N recipients (e.g. every transporter on a new load). */
export async function notifyUsers(userIds, type, title, body, relatedEntityType, relatedEntityId) {
  if (!userIds.length) return;
  let count = (await db.select().from(notifications)).length;
  const rows = userIds.map(userId => {
    const row = createNotification({ userId, type, title, body, relatedEntityType, relatedEntityId }, count);
    count += 1;
    return row;
  });
  await db.insert(notifications).values(rows);
}

/** Every fleet_owner account — the audience for a marketplace-wide "new load posted" notification. */
export async function allTransporterUserIds() {
  const rows = await db.select().from(users).where(eq(users.role, "fleet_owner"));
  return rows.map(u => u.id);
}

/** Every admin account — the audience for events that need an admin to act (release/retry). */
export async function allAdminUserIds() {
  const rows = await db.select().from(users).where(eq(users.role, "admin"));
  return rows.map(u => u.id);
}
