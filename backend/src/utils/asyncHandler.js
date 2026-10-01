/**
 * backend/src/utils/asyncHandler.js
 * --------------------------------------
 * Phase 4M — closes a real gap present since 4F: Express 4 does NOT forward
 * a rejected promise from an async route handler to the error-handling
 * middleware in app.js. Without this, any unexpected error inside an async
 * handler (a DB error not already caught, a bug) leaves the request hanging
 * forever — no response, no 500, just a client-side timeout. Wrapping every
 * handler with this turns that into a clean, logged 500 via the existing
 * error middleware, with zero change to any handler's own logic.
 */
export const asyncHandler = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
