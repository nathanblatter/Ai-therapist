/**
 * Wraps an async route handler to catch errors and forward them to Express error handling.
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
