/**
 * Capabilities - Capability declaration and runtime enforcement for plugin sandboxing
 *
 * Defines:
 *   - Capability enumeration (fs.read, fs.write, net.*, child_process, env, plugin.access)
 *   - CapabilityLevel risk classification (safe, low_risk, medium, high_risk)
 *   - CAPABILITY_LEVELS mapping (capability -> risk level)
 *   - TRUST_LEVELS matrix (sourceType -> allowed capabilities)
 *   - Runtime checker: isCapabilityAllowed(sourceType, capability)
 *
 * Design based on docs/design/harness-universal-platform-final-design.md section 3.2-3.4.
 *
 * @module capabilities
 */

'use strict';

// ---------------------------------------------------------------------------
// Capability enumeration
// ---------------------------------------------------------------------------

/**
 * All recognized capabilities that a plugin may declare in plugin.json.
 * Core services (eventBus, stateStore, logger, config) are always available
 * and do not need to be declared.
 * @public
 */
var Capability = Object.freeze({
  // File system access
  FS_READ: 'fs.read',
  FS_WRITE: 'fs.write',

  // Network access
  NET_REQUEST: 'net.request',
  NET_LISTEN: 'net.listen',

  // Process control
  CHILD_PROCESS: 'child_process',

  // Environment variables
  ENV_READ: 'env.read',

  // Cross-plugin provider access
  PLUGIN_ACCESS: 'plugin.access',
});

/**
 * Risk classification for capabilities.
 * Used to determine audit severity and UI presentation.
 * @public
 */
var CapabilityLevel = Object.freeze({
  SAFE: 'safe',
  LOW_RISK: 'low_risk',
  MEDIUM: 'medium',
  HIGH_RISK: 'high_risk',
});

/**
 * Maps each capability to its risk level.
 * Used by audit logger and capability display logic.
 * @public
 */
var CAPABILITY_LEVELS = {};
CAPABILITY_LEVELS[Capability.FS_READ] = CapabilityLevel.LOW_RISK;
CAPABILITY_LEVELS[Capability.FS_WRITE] = CapabilityLevel.MEDIUM;
CAPABILITY_LEVELS[Capability.NET_REQUEST] = CapabilityLevel.MEDIUM;
CAPABILITY_LEVELS[Capability.NET_LISTEN] = CapabilityLevel.HIGH_RISK;
CAPABILITY_LEVELS[Capability.CHILD_PROCESS] = CapabilityLevel.HIGH_RISK;
CAPABILITY_LEVELS[Capability.ENV_READ] = CapabilityLevel.LOW_RISK;
CAPABILITY_LEVELS[Capability.PLUGIN_ACCESS] = CapabilityLevel.LOW_RISK;

Object.freeze(CAPABILITY_LEVELS);

// ---------------------------------------------------------------------------
// Trust levels and capability restriction matrix
// ---------------------------------------------------------------------------

/**
 * Trust levels by source type.
 *   core  — fully trusted, all capabilities available, no sandboxing
 *   npm   — moderate trust, capabilities must be declared, sandboxed
 *   local — low trust, capabilities must be declared, sandboxed + path audit
 * @public
 */
var TRUST_LEVELS = Object.freeze({
  core: 'full',
  npm: 'moderate',
  local: 'low',
});

/**
 * Per-sourceType capability restrictions.
 *
 * 'auto'       — always granted without declaration
 * 'declared'   — granted only if declared in plugin.json capabilities
 * 'forbidden'  — never granted (blocked at runtime)
 *
 * NOTE: npm and local share identical restriction matrices by design.
 * Both require explicit capability declaration (declared) and forbid
 * child_process. Although TRUST_LEVELS differentiates 'moderate' vs 'low',
 * the capability enforcement is intentionally uniform — any third-party
 * plugin (whether from npm or local filesystem) must declare its capabilities.
 * If differentiated restrictions are needed in the future, the structure
 * supports independent modification per sourceType.
 *
 * @internal 此数据结构可能在不同版本间变更以支持新的安全策略
 */
var CAPABILITY_RESTRICTIONS = Object.freeze({
  core: Object.freeze({
    'fs.read': 'auto',
    'fs.write': 'auto',
    'net.request': 'auto',
    'net.listen': 'auto',
    'child_process': 'auto',
    'env.read': 'auto',
    'plugin.access': 'auto',
  }),
  npm: Object.freeze({
    'fs.read': 'declared',
    'fs.write': 'declared',
    'net.request': 'declared',
    'net.listen': 'declared',
    'child_process': 'forbidden',
    'env.read': 'declared',
    'plugin.access': 'declared',
  }),
  local: Object.freeze({
    'fs.read': 'declared',
    'fs.write': 'declared',
    'net.request': 'declared',
    'net.listen': 'declared',
    'child_process': 'forbidden',
    'env.read': 'declared',
    'plugin.access': 'declared',
  }),
});

// ---------------------------------------------------------------------------
// Runtime capability checker
// ---------------------------------------------------------------------------

/**
 * Check whether a specific capability is allowed for a given source type.
 *
 * @public
 * @param {string} sourceType  - 'core' | 'npm' | 'local'
 * @param {string} capability  - one of Capability values
 * @param {object} [declaredCapabilities] - the capabilities field from plugin.json (optional)
 * @returns {{ allowed: boolean, reason: string }}
 */
function isCapabilityAllowed(sourceType, capability, declaredCapabilities) {
  // Core plugins: everything allowed
  if (sourceType === 'core') {
    return { allowed: true, reason: 'core plugin: full trust' };
  }

  // Validate sourceType
  if (!CAPABILITY_RESTRICTIONS[sourceType]) {
    return { allowed: false, reason: 'unknown sourceType: ' + sourceType };
  }

  var restrictions = CAPABILITY_RESTRICTIONS[sourceType];
  var restriction = restrictions[capability];

  if (!restriction) {
    // Unknown capability — deny by default for non-core
    return { allowed: false, reason: 'unknown capability: ' + capability };
  }

  if (restriction === 'auto') {
    return { allowed: true, reason: 'auto-granted for ' + sourceType };
  }

  if (restriction === 'forbidden') {
    return { allowed: false, reason: capability + ' is forbidden for ' + sourceType + ' plugins' };
  }

  // restriction === 'declared': check if declared in plugin.json
  if (declaredCapabilities) {
    // The capabilities field maps top-level keys like "filesystem", "network", "child_process", "env"
    // to sub-structures. We need to map capability enums back to top-level keys.
    var capKey = _capabilityToTopLevelKey(capability);
    if (capKey && declaredCapabilities[capKey] !== undefined) {
      // If the value is explicitly false, treat as not declared
      if (declaredCapabilities[capKey] === false) {
        return { allowed: false, reason: capability + ' explicitly disabled in plugin.json' };
      }
      return { allowed: true, reason: capability + ' declared in plugin.json' };
    }
  }

  return { allowed: false, reason: capability + ' not declared in plugin.json capabilities' };
}

/**
 * Determine if a plugin should run in a sandbox (Worker Thread).
 * Core plugins run in the main process; npm/local plugins run sandboxed.
 *
 * @public
 * @param {string} sourceType - 'core' | 'npm' | 'local'
 * @returns {boolean}
 */
function shouldSandbox(sourceType) {
  return sourceType === 'npm' || sourceType === 'local';
}

/**
 * Get all allowed capabilities for a source type, given declared capabilities.
 *
 * @public
 * @param {string} sourceType
 * @param {object} [declaredCapabilities]
 * @returns {string[]} list of allowed Capability values
 */
function getAllowedCapabilities(sourceType, declaredCapabilities) {
  var allCaps = Object.keys(Capability).map(function (k) { return Capability[k]; });
  var allowed = [];

  for (var i = 0; i < allCaps.length; i++) {
    var result = isCapabilityAllowed(sourceType, allCaps[i], declaredCapabilities);
    if (result.allowed) {
      allowed.push(allCaps[i]);
    }
  }

  return allowed;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map a Capability enum value back to the top-level plugin.json key.
 * e.g. 'fs.read' -> 'filesystem', 'net.request' -> 'network', etc.
 *
 * @internal
 * @param {string} capability
 * @returns {string|null}
 */
function _capabilityToTopLevelKey(capability) {
  var map = {
    'fs.read': 'filesystem',
    'fs.write': 'filesystem',
    'net.request': 'network',
    'net.listen': 'network',
    'child_process': 'child_process',
    'env.read': 'env',
    'plugin.access': 'plugin_access',
  };
  return map[capability] || null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  Capability: Capability,
  CapabilityLevel: CapabilityLevel,
  CAPABILITY_LEVELS: CAPABILITY_LEVELS,
  TRUST_LEVELS: TRUST_LEVELS,
  CAPABILITY_RESTRICTIONS: CAPABILITY_RESTRICTIONS,
  isCapabilityAllowed: isCapabilityAllowed,
  shouldSandbox: shouldSandbox,
  getAllowedCapabilities: getAllowedCapabilities,
};
