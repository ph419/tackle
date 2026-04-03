/**
 * ConfigManager - Three-layer configuration management for AI Agent Harness
 *
 * Layer precedence (highest wins):
 *   1. Environment variables  (HARNESS_<KEY>)
 *   2. harness-config.yaml    (user/project-level)
 *   3. plugin defaults        (built into each plugin)
 *
 * Supports:
 *   - get(key) with dot-notation
 *   - getForPlugin(pluginName, key) with per-plugin override
 *   - setOverride(key, value) runtime override
 */

'use strict';

var fs = require('fs');
var path = require('path');

/**
 * Minimal YAML-like parser for simple key-value YAML files.
 * Handles nested structure via indentation (spaces only).
 * This is NOT a full YAML parser - it covers the subset used by harness-config.yaml.
 */
function parseSimpleYaml(content) {
  var result = {};
  var lines = content.split('\n');
  var stack = [{ obj: result, indent: -1 }];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Skip empty lines, comments, and document separators
    if (!line.trim() || line.trim().indexOf('#') === 0 || line.trim() === '---') {
      continue;
    }

    // Calculate indentation
    var indent = line.search(/\S/);
    if (indent < 0) continue;

    // Pop stack to find parent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    var parent = stack[stack.length - 1].obj;
    var trimmed = line.trim();

    // Check if it's a list item
    if (trimmed.indexOf('- ') === 0) {
      if (!Array.isArray(parent)) continue;
      var itemValue = parseValue(trimmed.substring(2));
      parent.push(itemValue);
      continue;
    }

    // Key-value pair
    var colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    var key = trimmed.substring(0, colonIdx).trim();
    var valuePart = trimmed.substring(colonIdx + 1).trim();

    if (valuePart === '' || valuePart === null) {
      // Nested object
      var child = {};
      parent[key] = child;
      stack.push({ obj: child, indent: indent });
    } else {
      parent[key] = parseValue(valuePart);
    }
  }

  return result;
}

/**
 * Parse a YAML scalar value.
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

  // Try number
  var num = Number(val);
  if (!isNaN(num) && val !== '') return num;

  return val;
}

class ConfigManager {
  /**
   * @param {object} [options]
   * @param {string} [options.configPath] - path to harness-config.yaml
   * @param {object} [options.defaults]   - plugin default configs { pluginName: { key: value } }
   */
  constructor(options) {
    options = options || {};
    /** @type {string} */
    this._configPath = options.configPath || path.join(this._findProjectRoot(), '.claude', 'config', 'harness-config.yaml');
    /** @type {object} plugin defaults */
    this._defaults = options.defaults || {};
    /** @type {object|null} parsed YAML config */
    this._yamlConfig = null;
    /** @type {object} runtime overrides */
    this._overrides = {};
  }

  // --- public API ---

  /**
   * Get a config value with three-layer resolution:
   *   runtime override > harness-config.yaml > plugin defaults
   *
   * @param {string} key - dot-notation key
   * @param {*} [defaultValue] - fallback if key not found in any layer
   * @returns {*}
   */
  get(key, defaultValue) {
    // Layer 1: runtime overrides
    var overrideVal = this._getNested(this._overrides, key);
    if (overrideVal !== undefined) {
      return overrideVal;
    }

    // Layer 2: environment variables (HARNESS_ prefix, double underscore for nesting)
    var envKey = 'HARNESS_' + key.toUpperCase().replace(/\./g, '__');
    if (process.env[envKey] !== undefined) {
      return parseValue(process.env[envKey]);
    }

    // Layer 3: harness-config.yaml
    var yamlVal = this._getNested(this._getYamlConfig(), key);
    if (yamlVal !== undefined) {
      return yamlVal;
    }

    return defaultValue;
  }

  /**
   * Get a config value for a specific plugin.
   * Resolution order:
   *   runtime override > env var > harness-config overrides section > harness-config root > plugin defaults
   *
   * @param {string} pluginName
   * @param {string} key
   * @param {*} [defaultValue]
   * @returns {*}
   */
  getForPlugin(pluginName, key, defaultValue) {
    // Try plugin-specific override first
    var pluginOverride = this.get('overrides.' + pluginName + '.' + key);
    if (pluginOverride !== undefined) {
      return pluginOverride;
    }

    // Try general get
    var generalVal = this.get(key);
    if (generalVal !== undefined) {
      return generalVal;
    }

    // Try plugin defaults
    var defaultVal = this._getNested(this._defaults, pluginName + '.' + key);
    if (defaultVal !== undefined) {
      return defaultVal;
    }

    return defaultValue;
  }

  /**
   * Set a runtime override. Takes highest priority.
   * @param {string} key
   * @param {*} value
   */
  setOverride(key, value) {
    this._setNested(this._overrides, key, value);
  }

  /**
   * Clear a runtime override.
   * @param {string} key
   */
  clearOverride(key) {
    this._deleteNested(this._overrides, key);
  }

  /**
   * Get the full parsed YAML config (for advanced usage).
   * @returns {object}
   */
  getAll() {
    return this._getYamlConfig();
  }

  /**
   * Create a scoped config getter for a specific plugin.
   * @param {string} pluginName
   * @returns {{ get: Function }}
   */
  forPlugin(pluginName) {
    var self = this;
    return {
      get: function (key, defaultValue) {
        return self.getForPlugin(pluginName, key, defaultValue);
      },
    };
  }

  // --- internal ---

  /**
   * Load and cache the YAML config.
   * @returns {object}
   */
  _getYamlConfig() {
    if (this._yamlConfig !== null) {
      return this._yamlConfig;
    }

    try {
      var content = fs.readFileSync(this._configPath, 'utf-8');
      this._yamlConfig = parseSimpleYaml(content);
    } catch (err) {
      // Config file not found or unreadable - use empty config
      this._yamlConfig = {};
    }

    return this._yamlConfig;
  }

  /**
   * Get nested value by dot-notation key.
   */
  _getNested(obj, key) {
    var parts = key.split('.');
    var current = obj;
    for (var i = 0; i < parts.length; i++) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = current[parts[i]];
    }
    return current;
  }

  /**
   * Set nested value by dot-notation key.
   */
  _setNested(obj, key, value) {
    var parts = key.split('.');
    var current = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (typeof current[parts[i]] !== 'object' || current[parts[i]] === null) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }

  /**
   * Delete nested value by dot-notation key.
   */
  _deleteNested(obj, key) {
    var parts = key.split('.');
    var current = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (typeof current[parts[i]] !== 'object' || current[parts[i]] === null) {
        return;
      }
      current = current[parts[i]];
    }
    delete current[parts[parts.length - 1]];
  }

  /**
   * Walk up from cwd to find the project root (directory containing task.md or CLAUDE.md).
   * Falls back to cwd if not found.
   * @returns {string}
   */
  _findProjectRoot() {
    var dir = process.cwd();
    for (var i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(dir, 'task.md')) || fs.existsSync(path.join(dir, 'CLAUDE.md'))) {
        return dir;
      }
      var parent = path.dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }
    return process.cwd();
  }
}

module.exports = ConfigManager;
