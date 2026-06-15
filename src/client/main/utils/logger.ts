/**
 * Client-side Logger Utility
 * Manages console logging based on system configuration
 *
 * When disabled (default), all console.log/warn/error/info calls become no-ops
 * to keep production logs clean. Can be enabled via Admin > System Config.
 */

// Store original console methods
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console)
};

// No-op functions for when logging is disabled
const noOp = () => {};

let loggingEnabled = false;

/**
 * Initialize the logger by fetching config and setting up console overrides
 */
export async function initializeLogger() {
  try {
    const response = await fetch('/api/config/client-logging');

    if (response.ok) {
      const data = await response.json();
      loggingEnabled = data.enabled || false;

      // Override console methods based on config
      if (loggingEnabled) {
        enableLogging();
        originalConsole.log('[Logger] Client-side logging ENABLED');
      } else {
        disableLogging();
      }
    } else {
      // If config fetch fails, disable logging by default
      disableLogging();
    }
  } catch (error) {
    // If anything fails, disable logging by default
    disableLogging();
  }
}

/**
 * Enable console logging (restore original methods)
 */
function enableLogging() {
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.info = originalConsole.info;
  console.debug = originalConsole.debug;
}

/**
 * Disable console logging (replace with no-ops)
 */
function disableLogging() {
  console.log = noOp;
  console.warn = noOp;
  console.error = noOp;
  console.info = noOp;
  console.debug = noOp;
}

/**
 * Check if logging is currently enabled
 */
export function isLoggingEnabled() {
  return loggingEnabled;
}

/**
 * Force enable logging (useful for emergency debugging)
 * Call window.enableDebugLogging() in browser console
 */
if (typeof window !== 'undefined') {
  window.enableDebugLogging = () => {
    loggingEnabled = true;
    enableLogging();
    originalConsole.log('[Logger] Debug logging FORCE ENABLED via console command');
  };

  /**
   * Force disable logging
   * Call window.disableDebugLogging() in browser console
   */
  window.disableDebugLogging = () => {
    loggingEnabled = false;
    disableLogging();
    originalConsole.log('[Logger] Debug logging FORCE DISABLED via console command');
  };
}
