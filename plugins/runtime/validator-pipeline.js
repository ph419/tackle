/**
 * ValidatorPipeline - Validator execution pipeline for AI Agent Harness
 *
 * Features:
 *   - Execute registered validators at workflow checkpoints
 *   - Support blocking mode (fail fast) and non-blocking mode (warnings only)
 *   - Auto-run validator-doc-sync after build
 *   - Auto-run validator-work-package when WP changes
 *   - Event-driven integration with EventBus
 *
 * Usage:
 *   var pipeline = new ValidatorPipeline({
 *     pluginLoader: pluginLoader,
 *     eventBus: eventBus,
 *     logger: logger,
 *   });
 *   await pipeline.runValidator('validator-doc-sync', { blocking: false });
 *   var result = await pipeline.runAllValidators({ phase: 'build' });
 */

'use strict';

var path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Validator execution modes.
 * @public
 */
var ExecutionMode = {
  BLOCKING: 'blocking',      // Fail on validation error, stop workflow
  NON_BLOCKING: 'non-blocking', // Continue on error, log warnings
};

/**
 * Workflow phases where validators auto-trigger.
 * @public
 */
var WorkflowPhase = {
  BUILD: 'build',             // After `tackle build` completes
  WP_CREATE: 'wp-create',     // After WP document creation
  WP_MODIFY: 'wp-modify',     // After WP document modification
  MANUAL: 'manual',           // Explicit manual invocation
};

// ---------------------------------------------------------------------------
// ValidatorPipeline class
// ---------------------------------------------------------------------------

/**
 * ValidatorPipeline constructor.
 * @public
 * @param {object} options
 * @param {object} options.pluginLoader - PluginLoader instance
 * @param {object} options.eventBus     - EventBus instance
 * @param {object} options.logger       - Logger instance
 * @param {string} [options.projectRoot] - Project root directory (default: cwd)
 */
function ValidatorPipeline(options) {
  options = options || {};

  if (!options.pluginLoader) {
    throw new Error('ValidatorPipeline: pluginLoader is required');
  }

  this._pluginLoader = options.pluginLoader;
  this._eventBus = options.eventBus || null;
  this._logger = options.logger || null;
  this._projectRoot = options.projectRoot || process.cwd();

  /** @type {Map<string, object>} validator execution results cache */
  this._resultsCache = new Map();

  this._setupEventListeners();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a single validator by name.
 *
 * @public
 * @param {string} validatorName - registered validator plugin name
 * @param {object} [options]
 * @param {string} [options.mode='blocking'] - ExecutionMode: 'blocking' or 'non-blocking'
 * @param {object} [options.context] - Additional context to pass to validator
 * @returns {Promise<{ passed: boolean, errors: object[], warnings: object[], mode: string }>}
 */
ValidatorPipeline.prototype.runValidator = async function runValidator(validatorName, options) {
  options = options || {};
  var mode = options.mode || ExecutionMode.BLOCKING;
  var context = options.context || {};

  this._log('info', 'Running validator: ' + validatorName + ' (mode: ' + mode + ')');

  // Get the validator plugin instance
  var validator = this._pluginLoader.getPlugin(validatorName);
  if (!validator) {
    var error = 'Validator plugin "' + validatorName + '" is not loaded';
    this._log('error', error);
    if (mode === ExecutionMode.BLOCKING) {
      throw new Error(error);
    }
    return {
      passed: false,
      errors: [{ message: error }],
      warnings: [],
      mode: mode,
    };
  }

  // Verify it's actually a ValidatorPlugin
  if (validator.type !== 'validator') {
    error = 'Plugin "' + validatorName + '" is not a validator (type: ' + validator.type + ')';
    this._log('error', error);
    if (mode === ExecutionMode.BLOCKING) {
      throw new Error(error);
    }
    return {
      passed: false,
      errors: [{ message: error }],
      warnings: [],
      mode: mode,
    };
  }

  // Execute the validator
  var result;
  try {
    result = await validator.validate(context);
  } catch (err) {
    this._log('error', 'Validator "' + validatorName + '" threw exception: ' + err.message);
    result = {
      valid: false,
      errors: [{ message: 'Exception during validation: ' + err.message }],
      warnings: [],
    };
  }

  // Normalize result format (validators may return { valid, errors, warnings } or { passed, errors, warnings })
  var passed = result.valid !== undefined ? result.valid : (result.passed || false);
  var errors = result.errors || [];
  var warnings = result.warnings || [];

  // Build standardized result
  var stdResult = {
    passed: passed,
    errors: errors,
    warnings: warnings,
    mode: mode,
    validator: validatorName,
  };

  // Emit event
  if (this._eventBus) {
    this._eventBus.emit('validator:executed', {
      validator: validatorName,
      passed: passed,
      mode: mode,
      errorsCount: errors.length,
      warningsCount: warnings.length,
    });
  }

  // Log results
  if (passed) {
    this._log('info', 'Validator "' + validatorName + '" PASSED' + (warnings.length > 0 ? ' with ' + warnings.length + ' warnings' : ''));
  } else {
    this._log('error', 'Validator "' + validatorName + '" FAILED: ' + errors.length + ' errors');
  }

  // Cache result
  this._resultsCache.set(validatorName, stdResult);

  // Handle blocking mode
  if (mode === ExecutionMode.BLOCKING && !passed) {
    var errorMessages = errors.map(function (e) { return e.message || String(e); });
    throw new Error('Validator "' + validatorName + '" failed in blocking mode:\n  - ' + errorMessages.join('\n  - '));
  }

  return stdResult;
};

/**
 * Run all registered validators for a specific workflow phase.
 *
 * @public
 * @param {object} [options]
 * @param {string} [options.phase='manual'] - WorkflowPhase identifier
 * @param {string} [options.mode='blocking'] - Default execution mode (can be overridden per-validator)
 * @param {boolean} [options.stopOnFirstError=false] - Stop execution on first blocking failure
 * @returns {Promise<{ results: object[], overallPassed: boolean, totalErrors: number, totalWarnings: number }>}
 */
ValidatorPipeline.prototype.runAllValidators = async function runAllValidators(options) {
  options = options || {};
  var phase = options.phase || WorkflowPhase.MANUAL;
  var defaultMode = options.mode || ExecutionMode.BLOCKING;
  var stopOnFirstError = options.stopOnFirstError !== false;

  this._log('info', 'Running all validators for phase: ' + phase);

  var loadedPlugins = this._pluginLoader.getLoadedNames();
  var validatorNames = [];

  // Find all validator plugins
  for (var i = 0; i < loadedPlugins.length; i++) {
    var plugin = this._pluginLoader.getPlugin(loadedPlugins[i]);
    if (plugin && plugin.type === 'validator') {
      validatorNames.push(loadedPlugins[i]);
    }
  }

  if (validatorNames.length === 0) {
    this._log('info', 'No validators registered, skipping');
    return {
      results: [],
      overallPassed: true,
      totalErrors: 0,
      totalWarnings: 0,
    };
  }

  var results = [];
  var totalErrors = 0;
  var totalWarnings = 0;
  var overallPassed = true;

  // Determine which validators to run based on phase
  var validatorsToRun = this._filterValidatorsForPhase(validatorNames, phase);

  for (var j = 0; j < validatorsToRun.length; j++) {
    var validatorName = validatorsToRun[j];
    var validator = this._pluginLoader.getPlugin(validatorName);

    // Determine execution mode from validator config or default
    var mode = defaultMode;
    if (validator && validator.blocking === false) {
      mode = ExecutionMode.NON_BLOCKING;
    }

    try {
      var result = await this.runValidator(validatorName, { mode: mode, phase: phase });
      results.push(result);

      if (!result.passed) {
        overallPassed = false;
        totalErrors += result.errors.length;
      }
      totalWarnings += result.warnings.length;

      // Stop on first blocking error if requested
      if (stopOnFirstError && mode === ExecutionMode.BLOCKING && !result.passed) {
        this._log('warn', 'Stopping validator execution due to blocking failure');
        break;
      }
    } catch (err) {
      // runValidator throws in blocking mode on failure
      overallPassed = false;
      totalErrors += 1;
      results.push({
        validator: validatorName,
        passed: false,
        errors: [{ message: err.message }],
        warnings: [],
        mode: mode,
      });

      if (stopOnFirstError && mode === ExecutionMode.BLOCKING) {
        throw err;
      }
    }
  }

  var summary = {
    results: results,
    overallPassed: overallPassed,
    totalErrors: totalErrors,
    totalWarnings: totalWarnings,
  };

  // Emit completion event
  if (this._eventBus) {
    this._eventBus.emit('validator:phase-complete', {
      phase: phase,
      overallPassed: overallPassed,
      totalErrors: totalErrors,
      totalWarnings: totalWarnings,
      validatorsExecuted: validatorsToRun.length,
    });
  }

  this._log('info', 'Validator phase complete: ' + (overallPassed ? 'PASSED' : 'FAILED') + ' (' + totalErrors + ' errors, ' + totalWarnings + ' warnings)');

  return summary;
};

/**
 * Run validators specifically for post-build phase.
 * This is a convenience method for the build workflow.
 *
 * @public
 *
 * @param {object} [options]
 * @returns {Promise<object>}
 */
ValidatorPipeline.prototype.runPostBuildValidators = async function runPostBuildValidators(options) {
  options = options || {};
  options.phase = WorkflowPhase.BUILD;
  options.mode = options.mode || ExecutionMode.NON_BLOCKING; // Build should not fail on validation
  return await this.runAllValidators(options);
};

/**
 * Run validators for WP-related operations.
 * This is a convenience method for WP creation/modification workflow.
 *
 * @public
 *
 * @param {string} wpId - Work package ID (e.g., 'WP-001')
 * @param {string} operation - 'create' or 'modify'
 * @param {object} [options]
 * @returns {Promise<object>}
 */
ValidatorPipeline.prototype.runWPValidators = async function runWPValidators(wpId, operation, options) {
  options = options || {};
  var phase = operation === 'create' ? WorkflowPhase.WP_CREATE : WorkflowPhase.WP_MODIFY;

  this._log('info', 'Running WP validators for ' + wpId + ' (operation: ' + operation + ')');

  // Build context with WP-specific info
  var context = options.context || {};
  context.wpId = wpId;
  context.operation = operation;
  context.wpPath = context.wpPath || path.join(this._projectRoot, 'docs', 'wp', wpId + '.md');

  options.phase = phase;
  options.context = context;

  return await this.runAllValidators(options);
};

/**
 * Get cached validator result.
 * @public
 * @param {string} validatorName
 * @returns {object|undefined}
 */
ValidatorPipeline.prototype.getCachedResult = function getCachedResult(validatorName) {
  return this._resultsCache.get(validatorName);
};

/**
 * Clear all cached validator results.
 * @public
 */
ValidatorPipeline.prototype.clearCache = function clearCache() {
  this._resultsCache.clear();
  this._log('info', 'Validator result cache cleared');
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Set up event listeners for automatic validator triggering.
 * @internal
 */
ValidatorPipeline.prototype._setupEventListeners = function _setupEventListeners() {
  if (!this._eventBus) {
    return;
  }

  var self = this;

  // Listen for build completion events
  this._eventBus.on('build:complete', function () {
    self._log('info', 'Build complete detected, running post-build validators');
    self.runPostBuildValidators().catch(function (err) {
      self._log('error', 'Post-build validation failed: ' + err.message);
    });
  });

  // Listen for WP document events
  this._eventBus.on('wp:created', function (data) {
    var wpId = data && data.wpId;
    if (wpId) {
      self._log('info', 'WP created detected: ' + wpId);
      self.runWPValidators(wpId, 'create').catch(function (err) {
        self._log('error', 'WP validation failed: ' + err.message);
      });
    }
  });

  this._eventBus.on('wp:modified', function (data) {
    var wpId = data && data.wpId;
    if (wpId) {
      self._log('info', 'WP modified detected: ' + wpId);
      self.runWPValidators(wpId, 'modify').catch(function (err) {
        self._log('error', 'WP validation failed: ' + err.message);
      });
    }
  });
};

/**
 * Filter validators based on workflow phase.
 * Each validator can declare which phases it applies to via metadata.targets or similar.
 *
 * @internal
 * @param {string[]} validatorNames
 * @param {string} phase
 * @returns {string[]}
 */
ValidatorPipeline.prototype._filterValidatorsForPhase = function _filterValidatorsForPhase(validatorNames, phase) {
  var filtered = [];

  for (var i = 0; i < validatorNames.length; i++) {
    var validatorName = validatorNames[i];
    var validator = this._pluginLoader.getPlugin(validatorName);

    if (!validator) {
      continue;
    }

    // Check if validator has explicit phase targeting
    // First check metadata.targets (from plugin.json), then fall back to instance.targets
    var targets = validator.metadata && validator.metadata.targets;
    if (!targets || (Array.isArray(targets) && targets.length === 0)) {
      targets = validator.targets;
    }

    if (targets && Array.isArray(targets) && targets.length > 0) {
      // Check if current phase is in targets
      var targetsLower = targets.map(function (t) { return String(t).toLowerCase(); });
      var phaseLower = phase.toLowerCase();

      if (targetsLower.indexOf(phaseLower) !== -1 || targetsLower.indexOf('all') !== -1) {
        filtered.push(validatorName);
      }
    } else {
      // No explicit targets - apply to all phases
      filtered.push(validatorName);
    }
  }

  return filtered;
};

/**
 * Internal logging helper.
 */
ValidatorPipeline.prototype._log = function _log(level, message) {
  if (this._logger && typeof this._logger[level] === 'function') {
    this._logger[level]('validator-pipeline', message);
  }
};

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  ValidatorPipeline: ValidatorPipeline,
  ExecutionMode: ExecutionMode,
  WorkflowPhase: WorkflowPhase,
};
