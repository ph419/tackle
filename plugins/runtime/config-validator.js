/**
 * ConfigValidator - Schema-based configuration validator for harness-config.yaml
 *
 * Validates the configuration file structure and reports missing or invalid fields.
 * Provides detailed error messages for each validation failure.
 *
 * Usage:
 *   var validator = new ConfigValidator();
 *   var result = validator.validate(configPath);
 *   if (!result.valid) {
 *     console.error(result.errors);
 *   }
 */

'use strict';

var fs = require('fs');
var path = require('path');

/**
 * Schema definition for harness-config.yaml (loaded from external file).
 * Each field can have:
 *   - type: expected type ('string', 'number', 'boolean', 'object', 'array')
 *   - required: whether the field is required
 *   - default: default value if not present
 *   - allowedValues: array of allowed values (for enums)
 *   - properties: nested schema (for objects)
 *   - items: schema for array items
 */
var CONFIG_SCHEMA = require('../contracts/config-schema.json');

/**
 * Minimal YAML-like parser — S8/A3 consolidated.
 *
 * Delegates to the shared `yaml-parser.parseSimpleYaml`. Previously this
 * module had its own divergent copy; the shared parser now covers the same
 * surface (flat keys, nested objects, lists, list-of-objects, inline flow
 * arrays, quoted strings, comments) plus MAX_YAML_SIZE / MAX_DEPTH guards.
 * @internal
 */
function parseSimpleYaml(content) {
  var sharedParser = require('./yaml-parser');
  return sharedParser.parseSimpleYaml(content);
}

/**
 * Parse a YAML scalar value.
 * Supports strings, numbers, booleans, null, and inline arrays.
 */
function parseValue(val) {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === '~') return null;

  // Remove surrounding quotes
  if ((val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') ||
      (val.charAt(0) === "'" && val.charAt(val.length - 1) === "'")) {
    return val.substring(1, val.length - 1);
  }

  // Check for inline array [item1, item2]
  if (val.charAt(0) === '[' && val.charAt(val.length - 1) === ']') {
    var inner = val.substring(1, val.length - 1).trim();
    if (inner === '') return [];
    var items = [];
    var current = '';
    var inQuotes = false;
    var quoteChar = '';

    for (var i = 0; i < inner.length; i++) {
      var ch = inner.charAt(i);
      if ((ch === '"' || ch === "'") && (i === 0 || inner.charAt(i - 1) !== '\\')) {
        if (!inQuotes) {
          inQuotes = true;
          quoteChar = ch;
        } else if (ch === quoteChar) {
          inQuotes = false;
          quoteChar = '';
        } else {
          current += ch;
        }
      } else if (ch === ',' && !inQuotes) {
        items.push(parseValue(current.trim()));
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim() !== '' || items.length > 0) {
      items.push(parseValue(current.trim()));
    }
    return items;
  }

  // Try number
  var num = Number(val);
  if (!isNaN(num) && val !== '') return num;

  return val;
}

class ConfigValidator {
  /**
   * Create a new validator instance.
   * @public
   * @param {object} [options]
   * @param {object} [options.schema] - custom schema to use (default: CONFIG_SCHEMA)
   */
  constructor(options) {
    options = options || {};
    this._schema = options.schema || CONFIG_SCHEMA;
  }

  /**
   * Validate a configuration file.
   * @public
   * @param {string} configPath - path to harness-config.yaml
   * @returns {{valid: boolean, errors: string[], warnings: string[]}}
   */
  validateFile(configPath) {
    var result = {
      valid: true,
      errors: [],
      warnings: []
    };

    // Check if file exists
    if (!fs.existsSync(configPath)) {
      // Degrade to warning - allow build to proceed with defaults
      result.valid = true;
      result.warnings.push('Configuration file not found: ' + configPath);
      return result;
    }

    // Read and parse file
    var content;
    try {
      content = fs.readFileSync(configPath, 'utf-8');
    } catch (err) {
      result.valid = false;
      result.errors.push('Failed to read configuration file: ' + err.message);
      return result;
    }

    var config;
    try {
      config = parseSimpleYaml(content);
    } catch (err) {
      result.valid = false;
      result.errors.push('Failed to parse configuration file: ' + err.message);
      return result;
    }

    // Validate against schema
    return this.validate(config);
  }

  /**
   * Validate a configuration object.
   * @public
   * @param {object} config - parsed configuration object
   * @returns {{valid: boolean, errors: string[], warnings: string[]}}
   */
  validate(config) {
    var result = {
      valid: true,
      errors: [],
      warnings: []
    };

    if (!config || typeof config !== 'object') {
      result.valid = false;
      result.errors.push('Configuration must be an object');
      return result;
    }

    // Validate each top-level section
    for (var key in this._schema) {
      var schema = this._schema[key];
      var value = config[key];

      if (value === undefined) {
        if (schema.required) {
          result.valid = false;
          result.errors.push('Missing required field: ' + key);
        }
        continue;
      }

      var sectionResult = this._validateField(value, schema, key);
      if (!sectionResult.valid) {
        result.valid = false;
        result.errors = result.errors.concat(sectionResult.errors);
      }
      result.warnings = result.warnings.concat(sectionResult.warnings);
    }

    return result;
  }

  /**
   * Validate a single field against its schema.
   * @private
   */
  _validateField(value, schema, path) {
    var result = {
      valid: true,
      errors: [],
      warnings: []
    };

    // Type check
    if (!this._checkType(value, schema.type)) {
      result.valid = false;
      result.errors.push('Field "' + path + '" must be of type ' + schema.type + ', got ' + typeof value);
      return result;
    }

    // Allowed values check
    if (schema.allowedValues && schema.allowedValues.indexOf(value) === -1) {
      result.valid = false;
      result.errors.push('Field "' + path + '" has invalid value "' + value + '". Allowed values: ' + schema.allowedValues.join(', '));
    }

    // Object properties validation
    if (schema.type === 'object' && schema.properties && value !== null) {
      for (var propKey in schema.properties) {
        var propSchema = schema.properties[propKey];
        var propValue = value[propKey];

        if (propValue === undefined) {
          if (propSchema.required) {
            result.valid = false;
            result.errors.push('Missing required field: ' + path + '.' + propKey);
          }
          continue;
        }

        var propResult = this._validateField(propValue, propSchema, path + '.' + propKey);
        if (!propResult.valid) {
          result.valid = false;
          result.errors = result.errors.concat(propResult.errors);
        }
        result.warnings = result.warnings.concat(propResult.warnings);
      }
    }

    // Array items validation
    if (schema.type === 'array' && schema.items && Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        var itemResult = this._validateField(value[i], schema.items, path + '[' + i + ']');
        if (!itemResult.valid) {
          result.valid = false;
          result.errors = result.errors.concat(itemResult.errors);
        }
        result.warnings = result.warnings.concat(itemResult.warnings);
      }
    }

    return result;
  }

  /**
   * Check if a value matches the expected type.
   * @private
   */
  _checkType(value, type) {
    switch (type) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !isNaN(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'array':
        return Array.isArray(value);
      default:
        return true;
    }
  }

  /**
   * Get the default configuration object.
   * @public
   * @returns {object}
   */
  getDefaults() {
    var defaults = {};

    for (var key in this._schema) {
      defaults[key] = this._getSchemaDefaults(this._schema[key]);
    }

    return defaults;
  }

  /**
   * Get default values from a schema.
   * @private
   */
  _getSchemaDefaults(schema) {
    var result = schema.default !== undefined ? schema.default : null;

    if (schema.type === 'object' && schema.properties) {
      result = {};
      for (var key in schema.properties) {
        var propDefault = this._getSchemaDefaults(schema.properties[key]);
        if (propDefault !== null) {
          result[key] = propDefault;
        }
      }
    }

    return result;
  }
}

module.exports = ConfigValidator;
