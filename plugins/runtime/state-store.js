/**
 * StateStore - File-backed key-value state storage for AI Agent Harness
 *
 * Features:
 *   - get(key) / set(key, value) / delete(key)
 *   - JSON file persistence via filesystem adapter
 *   - Auto-creates state file on first write
 *   - In-memory caching to minimize disk reads
 */

'use strict';

var fs = require('fs');
var path = require('path');

/**
 * Filesystem adapter for StateStore.
 * Reads/writes a JSON file to disk.
 */
class FileSystemAdapter {
  /**
   * @param {string} filePath - absolute path to the state file
   */
  constructor(filePath) {
    this.filePath = filePath;
  }

  /**
   * Read the entire state from disk.
   * @returns {object} parsed JSON state, or empty object if file missing/corrupt
   */
  read() {
    try {
      var content = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      // File does not exist or is invalid JSON - return empty state
      return {};
    }
  }

  /**
   * Write the entire state to disk.
   * Creates parent directories if needed.
   * @param {object} data - serializable state object
   */
  write(data) {
    var dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}

/**
 * In-memory adapter for StateStore (useful for testing).
 */
class MemoryAdapter {
  constructor() {
    this._data = {};
  }

  read() {
    return this._data;
  }

  write(data) {
    this._data = data;
  }
}

class StateStore {
  /**
   * @param {object} [options]
   * @param {string} [options.filePath] - path to state file (default: .claude-state in cwd)
   * @param {object} [options.adapter]  - custom adapter (for testing); overrides filePath
   */
  constructor(options) {
    options = options || {};

    if (options.adapter) {
      this._adapter = options.adapter;
    } else {
      var filePath = options.filePath || path.join(process.cwd(), '.claude-state');
      this._adapter = new FileSystemAdapter(filePath);
    }

    /** @type {object|null} cached state, null means not loaded yet */
    this._cache = null;
    /** @type {Map<string, Function[]>} key -> subscribers */
    this._subscribers = new Map();
  }

  // --- public API ---

  /**
   * Get a value by key.
   * @param {string} key - dot-notation key, e.g. 'harness.state'
   * @returns {Promise<*|undefined>}
   */
  async get(key) {
    var data = this._load();
    return this._getNested(data, key);
  }

  /**
   * Set a value by key.
   * @param {string} key - dot-notation key
   * @param {*} value
   * @returns {Promise<void>}
   */
  async set(key, value) {
    var data = this._load();
    var oldValue = this._getNested(data, key);
    this._setNested(data, key, value);
    this._cache = data;
    this._adapter.write(data);

    // Notify subscribers
    var subs = this._subscribers.get(key);
    if (subs) {
      var self = this;
      subs.forEach(function (cb) {
        try {
          cb(key, oldValue, value);
        } catch (err) {
          console.error('[StateStore] Subscriber error for key "' + key + '":', err.message);
        }
      });
    }
  }

  /**
   * Delete a key.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(key) {
    var data = this._load();
    this._deleteNested(data, key);
    this._cache = data;
    this._adapter.write(data);
  }

  /**
   * Subscribe to changes on a key.
   * @param {string} key
   * @param {Function} callback - callback(key, oldValue, newValue)
   * @returns {{ unsubscribe: Function }}
   */
  subscribe(key, callback) {
    if (!this._subscribers.has(key)) {
      this._subscribers.set(key, []);
    }
    this._subscribers.get(key).push(callback);

    var self = this;
    return {
      unsubscribe: function () {
        var subs = self._subscribers.get(key);
        if (subs) {
          var idx = subs.indexOf(callback);
          if (idx !== -1) subs.splice(idx, 1);
          if (subs.length === 0) self._subscribers.delete(key);
        }
      },
    };
  }

  /**
   * Get all keys currently stored.
   * @returns {Promise<string[]>}
   */
  async keys() {
    var data = this._load();
    return this._flattenKeys(data, '');
  }

  /**
   * Force reload from disk on next access.
   */
  invalidate() {
    this._cache = null;
  }

  // --- internal helpers ---

  /**
   * Load state (with caching).
   * @returns {object}
   */
  _load() {
    if (this._cache === null) {
      this._cache = this._adapter.read();
    }
    return this._cache;
  }

  /**
   * Get a nested value using dot-notation key.
   * @param {object} obj
   * @param {string} key - e.g. 'harness.state'
   * @returns {*|undefined}
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
   * Set a nested value using dot-notation key.
   * Creates intermediate objects as needed.
   * @param {object} obj
   * @param {string} key
   * @param {*} value
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
   * Delete a nested value using dot-notation key.
   * @param {object} obj
   * @param {string} key
   */
  _deleteNested(obj, key) {
    var parts = key.split('.');
    var current = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (typeof current[parts[i]] !== 'object' || current[parts[i]] === null) {
        return; // path doesn't exist, nothing to delete
      }
      current = current[parts[i]];
    }
    delete current[parts[parts.length - 1]];
  }

  /**
   * Recursively flatten an object into dot-notation keys.
   * @param {object} obj
   * @param {string} prefix
   * @returns {string[]}
   */
  _flattenKeys(obj, prefix) {
    var keys = [];
    if (typeof obj !== 'object' || obj === null) return keys;

    var self = this;
    Object.keys(obj).forEach(function (k) {
      var fullKey = prefix ? prefix + '.' + k : k;
      if (typeof obj[k] === 'object' && obj[k] !== null && !Array.isArray(obj[k])) {
        keys = keys.concat(self._flattenKeys(obj[k], fullKey));
      } else {
        keys.push(fullKey);
      }
    });
    return keys;
  }
}

module.exports = { StateStore, FileSystemAdapter, MemoryAdapter };
