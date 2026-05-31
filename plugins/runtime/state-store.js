/**
 * StateStore - File-backed key-value state storage for AI Agent Harness
 *
 * @module state-store
 *
 * Features:
 *   - get(key) / set(key, value) / delete(key)
 *   - JSON file persistence via filesystem adapter
 *   - Auto-creates state file on first write
 *   - In-memory caching to minimize disk reads
 *   - Atomic writes using write-to-temp + rename pattern
 *   - Automatic corruption recovery with backup
 *
 * SECURITY NOTES:
 *   - File permissions set to 0600 (owner read/write only)
 *   - Directory permissions set to 0700 (owner read/write/execute only)
 *   - Unique temp file names prevent collision attacks
 *
 * CONCURRENCY NOTES:
 *   - This implementation is NOT safe for concurrent writes from multiple processes.
 *   - Concurrent writes may result in last-write-wins data loss.
 *   - For multi-process scenarios, consider using an external lock file or database.
 *   - Single-process concurrent operations are safe due to Node.js single-threaded nature.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var Logger = require('./logger');
var logger = new Logger();

/**
 * Filesystem adapter for StateStore.
 * Reads/writes a JSON file to disk with fault tolerance.
 * @internal
 */
class FileSystemAdapter {
  /**
   * @param {string} filePath - absolute path to the state file
   * @param {object} [logger] - optional logger instance
   */
  constructor(filePath, logger) {
    this.filePath = filePath;
    this.logger = logger;
  }

  /**
   * Log a warning message if logger is available.
   * @param {string} msg
   */
  _warn(msg) {
    if (this.logger && this.logger.warn) {
      this.logger.warn('[StateStore] ' + msg);
    } else {
      logger.warn('state-store', msg);
    }
  }

  /**
   * Read the entire state from disk.
   * @returns {object} parsed JSON state, or empty object if file missing/corrupt
   */
  read() {
    // Check if file exists first
    if (!fs.existsSync(this.filePath)) {
      // File doesn't exist - auto-create empty state
      return {};
    }

    try {
      var content = fs.readFileSync(this.filePath, 'utf-8');

      // Check for empty file
      if (!content || content.trim() === '') {
        this._warn('State file is empty, initializing empty state');
        return {};
      }

      return JSON.parse(content);
    } catch (err) {
      // File exists but content is corrupt
      var backupPath = this.filePath + '.corrupt.' + Date.now();
      try {
        fs.copyFileSync(this.filePath, backupPath);
        this._warn('Corrupt state file backed up to: ' + backupPath);
      } catch (backupErr) {
        // Backup failed, but continue with recovery
      }

      this._warn('State file is corrupt (invalid JSON), recovering with empty state');
      return {};
    }
  }

  /**
   * Write the entire state to disk using atomic write pattern.
   * Creates parent directories if needed.
   * Uses write-to-temp + rename for atomicity.
   *
   * SECURITY: Uses unique temp file names to prevent collision and
   * sets secure file permissions (owner read/write only).
   *
   * @param {object} data - serializable state object
   */
  write(data) {
    var dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      // Create directory with secure permissions (owner read/write/execute only)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Atomic write: write to temp file with unique name, then rename
    // Use PID and timestamp for uniqueness to prevent collisions in concurrent scenarios
    var tempPath = this.filePath + '.tmp.' + process.pid + '.' + Date.now();
    var content = JSON.stringify(data, null, 2);

    try {
      // Write to temp file with secure permissions (owner read/write only)
      fs.writeFileSync(tempPath, content, {
        encoding: 'utf-8',
        mode: 0o600
      });

      // Atomic rename (overwrites target if exists)
      // This is atomic on most filesystems (POSIX, Windows)
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      // Clean up temp file if something went wrong
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (cleanupErr) {
        // Ignore cleanup errors
      }
      throw err;
    }
  }
}

/**
 * In-memory adapter for StateStore (useful for testing).
 * @public
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

/**
 * StateStore - file-backed key-value state storage.
 * @public
 */
class StateStore {
  /**
   * @public
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
      this._adapter = new FileSystemAdapter(filePath, options.logger);
    }

    /** @type {object|null} cached state, null means not loaded yet */
    this._cache = null;
    /** @type {Map<string, Function[]>} key -> subscribers */
    this._subscribers = new Map();
    /** @type {object} logger instance */
    this._logger = options.logger;
  }

  // --- public API ---

  /**
   * Get a value by key.
   * @public
   * @param {string} key - dot-notation key, e.g. 'harness.state'
   * @returns {Promise<*|undefined>}
   */
  async get(key) {
    var data = this._load();
    return this._getNested(data, key);
  }

  /**
   * Set a value by key.
   * @public
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
          logger.error('state-store', 'Subscriber error for key "' + key + '": ' + err.message);
        }
      });
    }
  }

  /**
   * Delete a key.
   * @public
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
   * @public
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
   * @public
   * @returns {Promise<string[]>}
   */
  async keys() {
    var data = this._load();
    return this._flattenKeys(data, '');
  }

  /**
   * Force reload from disk on next access.
   * @public
   */
  invalidate() {
    this._cache = null;
  }

  // --- internal helpers ---

  /**
   * Load state (with caching).
   * @internal
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
   * @internal
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
   * @internal
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
   * @internal
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
   * @internal
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

// Export both as named exports (for destructuring) and as default
// Add static properties to StateStore class for convenience access
StateStore.FileSystemAdapter = FileSystemAdapter;
StateStore.MemoryAdapter = MemoryAdapter;

// Export both as named exports (for destructuring) and as default
module.exports = {
  StateStore: StateStore,
  FileSystemAdapter: FileSystemAdapter,
  MemoryAdapter: MemoryAdapter
};

// Also export as default for direct require compatibility
module.exports.StateStore = StateStore;
module.exports.FileSystemAdapter = FileSystemAdapter;
module.exports.MemoryAdapter = MemoryAdapter;
