/**
 * Logger - Plugin-level logging service for AI Agent Harness
 *
 * Features:
 *   - debug / info / warn / error log levels
 *   - Per-plugin log segregation
 *   - History query interface for debugging
 *   - No external dependencies
 */

'use strict';

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  /**
   * @param {object} [options]
   * @param {string} [options.level='info'] - minimum log level
   * @param {number} [options.maxHistory=500] - max history entries to retain
   */
  constructor(options) {
    options = options || {};
    this._minLevel = LOG_LEVELS[options.level] !== undefined
      ? LOG_LEVELS[options.level]
      : LOG_LEVELS.info;
    this._maxHistory = options.maxHistory || 500;
    this._history = [];
  }

  // --- public API ---

  /**
   * Log a debug message.
   * @param {string} plugin - plugin name
   * @param {string} message
   * @param {object} [data]
   */
  debug(plugin, message, data) {
    this._log('debug', plugin, message, data);
  }

  /**
   * Log an info message.
   * @param {string} plugin
   * @param {string} message
   * @param {object} [data]
   */
  info(plugin, message, data) {
    this._log('info', plugin, message, data);
  }

  /**
   * Log a warning message.
   * @param {string} plugin
   * @param {string} message
   * @param {object} [data]
   */
  warn(plugin, message, data) {
    this._log('warn', plugin, message, data);
  }

  /**
   * Log an error message.
   * @param {string} plugin
   * @param {string} message
   * @param {object} [data]
   */
  error(plugin, message, data) {
    this._log('error', plugin, message, data);
  }

  /**
   * Query log history.
   * @param {object} [filter]
   * @param {string} [filter.plugin]   - filter by plugin name
   * @param {string} [filter.level]    - filter by level (debug/info/warn/error)
   * @param {number} [filter.since]    - timestamp lower bound (ms)
   * @param {number} [filter.until]    - timestamp upper bound (ms)
   * @param {number} [filter.limit]    - max entries to return
   * @returns {object[]}
   */
  query(filter) {
    filter = filter || {};
    let results = this._history;

    if (filter.plugin) {
      results = results.filter(function (e) { return e.plugin === filter.plugin; });
    }
    if (filter.level) {
      var levelNum = LOG_LEVELS[filter.level];
      if (levelNum !== undefined) {
        results = results.filter(function (e) { return LOG_LEVELS[e.level] >= levelNum; });
      }
    }
    if (filter.since) {
      results = results.filter(function (e) { return e.timestamp >= filter.since; });
    }
    if (filter.until) {
      results = results.filter(function (e) { return e.timestamp <= filter.until; });
    }
    if (filter.limit) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  /**
   * Clear all history entries.
   */
  clear() {
    this._history = [];
  }

  /**
   * Create a child logger bound to a specific plugin name.
   * The child logger exposes debug/info/warn/error without needing the plugin arg.
   * @param {string} pluginName
   * @returns {object} child logger with debug/info/warn/error methods
   */
  createChild(pluginName) {
    var self = this;
    return {
      debug: function (message, data) { self.debug(pluginName, message, data); },
      info: function (message, data) { self.info(pluginName, message, data); },
      warn: function (message, data) { self.warn(pluginName, message, data); },
      error: function (message, data) { self.error(pluginName, message, data); },
    };
  }

  // --- internal ---

  _log(level, plugin, message, data) {
    var levelNum = LOG_LEVELS[level];
    if (levelNum === undefined) {
      return;
    }
    if (levelNum < this._minLevel) {
      return;
    }

    var entry = {
      level: level,
      plugin: plugin || 'system',
      message: message,
      timestamp: Date.now(),
    };
    if (data !== undefined) {
      entry.data = data;
    }

    this._history.push(entry);
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }

    // Also write to console for immediate visibility
    var prefix = '[' + entry.timestamp + '] [' + level.toUpperCase() + '] [' + entry.plugin + ']';
    if (level === 'error') {
      console.error(prefix, message, data !== undefined ? data : '');
    } else if (level === 'warn') {
      console.warn(prefix, message, data !== undefined ? data : '');
    } else {
      console.log(prefix, message, data !== undefined ? data : '');
    }
  }
}

module.exports = Logger;
