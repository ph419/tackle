/**
 * ConfigManager - Three-layer configuration management for AI Agent Harness
 *
 * @module config-manager
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
 *
 * S8/A3: this delegates to the shared `yaml-parser.parseSimpleYaml`, which
 * consolidates the 5 divergent YAML parsers that previously existed in the
 * codebase (config-manager, config-validator, hook-skill-gate,
 * provider-role-registry, and yaml-parser). The shared parser:
 *   - enforces MAX_YAML_SIZE / MAX_DEPTH (DoS guard the old copies lacked)
 *   - correctly parses top-level scalar arrays (B4 fix: `triggers:\n  - foo`
 *     previously parsed to `{}` empty object, losing data)
 *   - handles list-of-objects, nested objects, quoted strings, comments
 * The local `parseValue` is kept only for the env-var resolution path in
 * get(); YAML parsing now goes through the shared helper.
 * @internal
 */
function parseSimpleYaml(content) {
  // Re-require lazily to avoid a circular import at module-load time
  // (yaml-parser does not require config-manager, but keep it lazy for safety).
  var sharedParser = require('./yaml-parser');
  try {
    return sharedParser.parseSimpleYaml(content);
  } catch (_e) {
    // Oversize / over-depth → treat as empty config (do not crash callers)
    return {};
  }
}

/**
 * Parse a YAML scalar value.
 * B12: require length >= 2 before stripping quotes so a lone quote char is
 * not truncated to '' and an unbalanced leading quote is returned verbatim.
 * @internal
 */
function parseValue(val) {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === '~') return null;

  // Remove surrounding quotes (only when the value is fully wrapped)
  if (val.length >= 2 &&
      ((val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') ||
       (val.charAt(0) === "'" && val.charAt(val.length - 1) === "'"))) {
    return val.substring(1, val.length - 1);
  }

  // Try number
  var num = Number(val);
  if (!isNaN(num) && val !== '') return num;

  return val;
}

/**
 * ConfigManager class.
 * @public
 */
class ConfigManager {
  /**
   * @public
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
   * @public
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
   * @public
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
   * @public
   * @param {string} key
   * @param {*} value
   */
  setOverride(key, value) {
    this._setNested(this._overrides, key, value);
  }

  /**
   * Clear a runtime override.
   * @public
   * @param {string} key
   */
  clearOverride(key) {
    this._deleteNested(this._overrides, key);
  }

  /**
   * Get the full parsed YAML config (for advanced usage).
   * @public
   * @returns {object}
   */
  getAll() {
    return this._getYamlConfig();
  }

  /**
   * Create a scoped config getter for a specific plugin.
   * @public
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
   * @internal
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
   * @internal
   */
  _getNested(obj, key) {
    var parts = key.split('.');
    var current = obj;
    for (var i = 0; i < parts.length; i++) {
      // S7：拒绝原型污染段
      if (parts[i] === '__proto__' || parts[i] === 'constructor' || parts[i] === 'prototype') {
        return undefined;
      }
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = current[parts[i]];
    }
    return current;
  }

  /**
   * Set nested value by dot-notation key.
   * @internal
   */
  _setNested(obj, key, value) {
    var parts = key.split('.');
    var current = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      // S7：拒绝原型污染段，写入 __proto__/constructor/prototype 视为 no-op
      if (parts[i] === '__proto__' || parts[i] === 'constructor' || parts[i] === 'prototype') {
        return;
      }
      if (typeof current[parts[i]] !== 'object' || current[parts[i]] === null) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    var last = parts[parts.length - 1];
    if (last === '__proto__' || last === 'constructor' || last === 'prototype') {
      return;
    }
    current[last] = value;
  }

  /**
   * Delete nested value by dot-notation key.
   * @internal
   */
  _deleteNested(obj, key) {
    var parts = key.split('.');
    var current = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      // S7：拒绝原型污染段
      if (parts[i] === '__proto__' || parts[i] === 'constructor' || parts[i] === 'prototype') {
        return;
      }
      if (typeof current[parts[i]] !== 'object' || current[parts[i]] === null) {
        return;
      }
      current = current[parts[i]];
    }
    var last = parts[parts.length - 1];
    if (last === '__proto__' || last === 'constructor' || last === 'prototype') {
      return;
    }
    delete current[last];
  }

  /**
   * Walk up from cwd to find the project root (directory containing task.md or CLAUDE.md).
   * Falls back to cwd if not found.
   * @internal
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
