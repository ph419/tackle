/**
 * plugin-validator - Plugin format validation
 *
 * Validates plugin.json format, required fields, type compliance, and
 * companion file existence. Also validates capabilities schema introduced
 * in v0.2.0 and JSON Schema formal validation (WP-115).
 *
 * Usage:
 *   const pluginValidator = require('./plugin-validator');
 *   const result = pluginValidator.validatePlugin(entry, pluginDir);
 *   const capWarnings = pluginValidator.validateCapabilities(meta.capabilities);
 *   const schemaResult = pluginValidator.validateWithSchema(meta);
 *
 * @module plugin-validator
 */

'use strict';

var fs = require('fs');
var path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Required fields in every plugin.json.
 * @public
 * @type {string[]}
 */
var PLUGIN_REQUIRED_FIELDS = ['name', 'version', 'type', 'description'];

/**
 * Valid plugin type values.
 * @public
 * @type {string[]}
 */
var VALID_PLUGIN_TYPES = ['skill', 'hook', 'validator', 'provider'];

/**
 * Known capability names recognized by tackle-harness.
 * Unknown capability names will generate warnings (non-blocking).
 * @internal Use getKnownCapabilities() for public access
 * @type {string[]}
 */
var KNOWN_CAPABILITIES = ['filesystem', 'network', 'child_process', 'env', 'plugin_access'];

// ---------------------------------------------------------------------------
// Plugin validation
// ---------------------------------------------------------------------------

/**
 * Validate a single plugin entry.
 *
 * Checks:
 * 1. Plugin directory exists
 * 2. plugin.json exists and is valid JSON
 * 3. Required fields (name, version, type, description)
 * 4. Plugin type is valid
 * 5. Type-specific companion files (skill.md for skills, index.js for hooks)
 * 6. Version follows semver format (warning only)
 *
 * @public
 * @param {object} entry  - registry entry with at least a name field
 * @param {string} pluginDir - resolved plugin directory path
 * @returns {{ errors: object[], warnings: object[] }}
 */
function validatePlugin(entry, pluginDir) {
  var errors = [];
  var warnings = [];
  var pluginName = entry.name || entry.source || 'unknown';

  // 1. Check plugin directory exists
  if (!fs.existsSync(pluginDir)) {
    errors.push({
      plugin: pluginName,
      field: 'directory',
      message: 'Plugin directory not found: ' + pluginDir,
    });
    return { errors: errors, warnings: warnings }; // can't validate further
  }

  // 2. Check plugin.json exists
  var metaPath = path.join(pluginDir, 'plugin.json');
  if (!fs.existsSync(metaPath)) {
    errors.push({
      plugin: pluginName,
      field: 'plugin.json',
      message: 'plugin.json not found in ' + pluginDir,
    });
    return { errors: errors, warnings: warnings };
  }

  // 3. Parse and validate plugin.json
  var meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch (err) {
    errors.push({
      plugin: pluginName,
      field: 'plugin.json',
      message: 'Invalid JSON in plugin.json: ' + err.message,
    });
    return { errors: errors, warnings: warnings };
  }

  // 4. Check required fields
  for (var i = 0; i < PLUGIN_REQUIRED_FIELDS.length; i++) {
    var field = PLUGIN_REQUIRED_FIELDS[i];
    if (!meta[field]) {
      errors.push({
        plugin: pluginName,
        field: field,
        message: 'Missing required field: ' + field,
      });
    }
  }

  // 5. Check plugin type is valid
  if (meta.type && VALID_PLUGIN_TYPES.indexOf(meta.type) === -1) {
    errors.push({
      plugin: pluginName,
      field: 'type',
      message: 'Invalid plugin type: "' + meta.type + '". Must be one of: ' + VALID_PLUGIN_TYPES.join(', '),
    });
  }

  // 5.5 JSON Schema formal validation (WP-115)
  var schemaResult = validateWithSchema(meta);
  if (!schemaResult.valid) {
    for (var si = 0; si < schemaResult.errors.length; si++) {
      var schemaErr = schemaResult.errors[si];
      // Skip duplicate required-field errors already reported in step 4
      if (schemaErr.message && schemaErr.message.indexOf('Missing required') === 0) {
        continue;
      }
      errors.push({
        plugin: pluginName,
        field: schemaErr.field,
        message: '[schema] ' + schemaErr.message,
      });
    }
  }

  // 6. Type-specific file checks
  if (meta.type === 'skill') {
    var skillMdPath = path.join(pluginDir, 'skill.md');
    if (!fs.existsSync(skillMdPath)) {
      errors.push({
        plugin: pluginName,
        field: 'skill.md',
        message: 'Skill plugin is missing skill.md file',
      });
    }
  }

  if (meta.type === 'hook') {
    var indexPath = path.join(pluginDir, 'index.js');
    if (!fs.existsSync(indexPath)) {
      warnings.push({
        plugin: pluginName,
        field: 'index.js',
        message: 'Hook plugin is missing index.js file (build will generate stub)',
      });
    }
  }

  // 7. Version format check (basic semver)
  if (meta.version && !/^\d+\.\d+\.\d+/.test(meta.version)) {
    warnings.push({
      plugin: pluginName,
      field: 'version',
      message: 'Version "' + meta.version + '" does not follow semver format (x.y.z)',
    });
  }

  return { errors: errors, warnings: warnings };
}

/**
 * Format validation results into a human-readable summary.
 *
 * @public
 * @param {object} options
 * @param {number} options.totalPlugins - total plugins checked
 * @param {object[]} options.errors - validation errors
 * @param {object[]} options.warnings - validation warnings
 * @returns {string} formatted summary string
 */
function formatValidationSummary(options) {
  var totalPlugins = options.totalPlugins;
  var errors = options.errors;
  var warnings = options.warnings;

  var lines = [];
  lines.push('');
  lines.push('=== Validation Report ===');
  lines.push('Plugins checked: ' + totalPlugins);
  lines.push('Errors: ' + errors.length);
  lines.push('Warnings: ' + warnings.length);

  if (errors.length > 0) {
    lines.push('');
    lines.push('--- Errors ---');
    for (var i = 0; i < errors.length; i++) {
      var e = errors[i];
      lines.push('  [' + e.plugin + '] ' + e.message);
    }
  }

  if (warnings.length > 0) {
    lines.push('');
    lines.push('--- Warnings ---');
    for (var j = 0; j < warnings.length; j++) {
      var w = warnings[j];
      lines.push('  [' + w.plugin + '] ' + w.message);
    }
  }

  lines.push('');
  lines.push(errors.length === 0 ? 'Validation PASSED' : 'Validation FAILED');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Capabilities validation (v0.2.0)
// ---------------------------------------------------------------------------

/**
 * Validate the capabilities field of a plugin.json.
 *
 * Checks that each declared capability key is a known capability name.
 * Unknown names produce warnings but do not block the build.
 *
 * @public
 * @param {object|null|undefined} capabilities - The capabilities field from plugin.json
 * @returns {object[]} Array of warning objects: { field: string, message: string }
 */
function validateCapabilities(capabilities) {
  var warnings = [];

  if (!capabilities) {
    return warnings;
  }

  // Capabilities must be an object
  if (typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    warnings.push({
      field: 'capabilities',
      message: 'capabilities must be an object, got ' + (Array.isArray(capabilities) ? 'array' : typeof capabilities),
    });
    return warnings;
  }

  var keys = Object.keys(capabilities);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (KNOWN_CAPABILITIES.indexOf(key) === -1) {
      warnings.push({
        field: 'capabilities.' + key,
        message: 'Unknown capability: "' + key + '". Known capabilities: ' + KNOWN_CAPABILITIES.join(', '),
      });
    }
  }

  return warnings;
}

/**
 * Get the list of known capability names.
 * Useful for tests and external consumers.
 *
 * @public
 * @returns {string[]}
 */
function getKnownCapabilities() {
  return KNOWN_CAPABILITIES.slice();
}

// ---------------------------------------------------------------------------
// JSON Schema validation (WP-115)
// ---------------------------------------------------------------------------

/**
 * Cached JSON Schema object, loaded lazily on first use.
 * @type {object|null|undefined}
 */
var _cachedSchema = undefined;

/**
 * Load the plugin.json JSON Schema definition.
 * Cached after first load.
 *
 * @internal
 * @returns {object|null} The parsed schema object, or null if not found.
 */
function loadPluginSchema() {
  if (_cachedSchema !== undefined) {
    return _cachedSchema;
  }
  var schemaPath = path.join(
    __dirname, '..', 'contracts', 'plugin-schema.json'
  );
  try {
    var content = fs.readFileSync(schemaPath, 'utf-8');
    _cachedSchema = JSON.parse(content);
  } catch (err) {
    _cachedSchema = null;
  }
  return _cachedSchema;
}

/**
 * Try to require the ajv module (optional dependency).
 * Returns null if ajv is not available.
 *
 * @internal
 * @returns {object|null} The Ajv constructor, or null.
 */
function _tryLoadAjv() {
  try {
    // eslint-disable-next-line no-redeclare
    var Ajv = require('ajv');
    return Ajv;
  } catch (err) {
    return null;
  }
}

/**
 * Validate a plugin.json object against the formal JSON Schema.
 *
 * Attempts to use ajv if available (optionalDependencies), otherwise
 * falls back to inline validation covering required fields, type checks,
 * and enum constraints defined in the schema.
 *
 * @public
 * @param {object} pluginJson - The parsed plugin.json object.
 * @returns {{ valid: boolean, errors: object[] }} Validation result.
 */
function validateWithSchema(pluginJson) {
  var schema = loadPluginSchema();
  if (!schema) {
    return { valid: true, errors: [] };
  }

  // Try ajv-based validation first
  var Ajv = _tryLoadAjv();
  if (Ajv) {
    var ajv = new Ajv({ allErrors: true });
    var validate = ajv.compile(schema);
    var valid = validate(pluginJson);
    if (valid) {
      return { valid: true, errors: [] };
    }
    var errors = (validate.errors || []).map(function (e) {
      return {
        field: e.instancePath ? e.instancePath.slice(1) : (e.params || {}).missingProperty || '',
        message: e.message || 'Schema validation error',
        schemaError: true,
      };
    });
    return { valid: false, errors: errors };
  }

  // Fallback: inline validation matching schema constraints
  return _inlineSchemaValidate(pluginJson, schema);
}

/**
 * Inline schema validation fallback.
 * Covers required fields, type checks, patterns, and enums.
 *
 * @param {object} pluginJson - The parsed plugin.json object.
 * @param {object} schema - The loaded JSON Schema.
 * @returns {{ valid: boolean, errors: object[] }}
 * @private
 */
function _inlineSchemaValidate(pluginJson, schema) {
  var errors = [];

  // Required fields
  var required = schema.required || [];
  for (var i = 0; i < required.length; i++) {
    if (!pluginJson[required[i]]) {
      errors.push({
        field: required[i],
        message: 'Missing required property: ' + required[i],
        schemaError: true,
      });
    }
  }

  // Check each property against schema definition
  var props = schema.properties || {};
  var propNames = Object.keys(props);
  for (var j = 0; j < propNames.length; j++) {
    var propName = propNames[j];
    var propVal = pluginJson[propName];
    var propSchema = props[propName];

    if (propVal === undefined || propVal === null) {
      continue; // optional field not present
    }

    // Type check
    if (propSchema.type) {
      var actualType = Array.isArray(propVal) ? 'array' : typeof propVal;
      if (actualType !== propSchema.type) {
        errors.push({
          field: propName,
          message: 'Property "' + propName + '" must be ' + propSchema.type + ', got ' + actualType,
          schemaError: true,
        });
        continue;
      }
    }

    // Enum check
    if (propSchema.enum) {
      if (propSchema.enum.indexOf(propVal) === -1) {
        errors.push({
          field: propName,
          message: 'Property "' + propName + '" must be one of: ' + propSchema.enum.join(', '),
          schemaError: true,
        });
      }
    }

    // Pattern check (for strings)
    if (propSchema.pattern && typeof propVal === 'string') {
      var regex = new RegExp(propSchema.pattern);
      if (!regex.test(propVal)) {
        errors.push({
          field: propName,
          message: 'Property "' + propName + '" does not match pattern: ' + propSchema.pattern,
          schemaError: true,
        });
      }
    }

    // minLength check (for strings)
    if (propSchema.minLength !== undefined && typeof propVal === 'string') {
      if (propVal.length < propSchema.minLength) {
        errors.push({
          field: propName,
          message: 'Property "' + propName + '" must have minLength ' + propSchema.minLength,
          schemaError: true,
        });
      }
    }

    // additionalProperties check for objects
    if (propSchema.additionalProperties === false && typeof propVal === 'object' && !Array.isArray(propVal)) {
      var allowedKeys = Object.keys(propSchema.properties || {});
      var actualKeys = Object.keys(propVal);
      for (var k = 0; k < actualKeys.length; k++) {
        if (allowedKeys.indexOf(actualKeys[k]) === -1) {
          errors.push({
            field: propName + '.' + actualKeys[k],
            message: 'Additional property "' + actualKeys[k] + '" is not allowed in "' + propName + '"',
            schemaError: true,
          });
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors,
  };
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  validatePlugin: validatePlugin,
  formatValidationSummary: formatValidationSummary,
  PLUGIN_REQUIRED_FIELDS: PLUGIN_REQUIRED_FIELDS,
  VALID_PLUGIN_TYPES: VALID_PLUGIN_TYPES,
  validateCapabilities: validateCapabilities,
  getKnownCapabilities: getKnownCapabilities,
  KNOWN_CAPABILITIES: KNOWN_CAPABILITIES,
  validateWithSchema: validateWithSchema,
  loadPluginSchema: loadPluginSchema,
};
