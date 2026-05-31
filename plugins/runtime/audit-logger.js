/**
 * AuditLogger - JSONL audit log persistence for plugin sandboxing
 *
 * Writes structured audit events to a JSONL (JSON Lines) file.
 * Each line is a complete JSON object representing one audit event.
 *
 * Event types (from design doc section 3.5.2):
 *   - sandbox.create    — Worker Thread created
 *   - sandbox.terminate — Worker Thread terminated
 *   - plugin.load       — plugin loaded (with capability review)
 *   - capability.check  — runtime capability check (allow/deny)
 *   - capability.violation — plugin attempted undeclared capability
 *
 * File path: ${targetRoot}/.claude/logs/audit-${YYYYMMDD}.jsonl
 *
 * @module audit-logger
 */

'use strict';

var fs = require('fs');
var path = require('path');
var Logger = require('./logger');
var logger = new Logger();

/**
 * @typedef {object} AuditEntry
 * @property {string} timestamp    - ISO 8601 timestamp
 * @property {string} event        - event type
 * @property {string} plugin       - plugin name
 * @property {string} [sourceType] - plugin source type (core/npm/local)
 * @property {string} [capability] - requested capability (for capability events)
 * @property {string} decision     - allow | deny | warn | error
 * @property {string} [detail]     - additional detail
 * @property {string} [sessionId]  - session identifier for correlation
 */

/**
 * AuditLogger writes structured audit events to JSONL files.
 * @public
 */
class AuditLogger {
  /**
   * @public
   * @param {object} [options]
   * @param {string} [options.logDir]    - directory for audit log files (default: .claude/logs under cwd)
   * @param {string} [options.sessionId] - session identifier for correlation
   * @param {object} [options.logger]    - optional Logger instance for internal logging
   */
  constructor(options) {
    options = options || {};
    this._logDir = options.logDir || path.join(process.cwd(), '.claude', 'logs');
    this._sessionId = options.sessionId || '';
    this._logger = options.logger || null;
    this._currentDate = '';
    this._buffer = [];
    this._flushTimer = null;
    this._flushInterval = options.flushInterval || 1000; // 1 second default
    this._maxBufferSize = options.maxBufferSize || 100;
    this._destroyed = false;
  }

  // --- Public API ---

  /**
   * Log an audit event.
   * Events are buffered and flushed periodically or when the buffer is full.
   *
   * @public
   * @param {string} event     - event type (sandbox.create, capability.check, etc.)
   * @param {string} plugin    - plugin name
   * @param {object} [details] - additional fields to include in the entry
   * @returns {void}
   */
  log(event, plugin, details) {
    if (this._destroyed) {
      return;
    }

    var entry = {
      timestamp: new Date().toISOString(),
      event: event,
      plugin: plugin,
      decision: (details && details.decision) || 'allow',
    };

    if (details) {
      if (details.sourceType) entry.sourceType = details.sourceType;
      if (details.capability) entry.capability = details.capability;
      if (details.detail) entry.detail = details.detail;
      if (details.decision) entry.decision = details.decision;
    }

    if (this._sessionId) {
      entry.sessionId = this._sessionId;
    }

    this._buffer.push(entry);

    // Flush immediately if buffer is full
    if (this._buffer.length >= this._maxBufferSize) {
      this._flush();
    } else if (!this._flushTimer) {
      // Schedule a delayed flush
      var self = this;
      this._flushTimer = setTimeout(function () {
        self._flushTimer = null;
        self._flush();
      }, this._flushInterval);
      // Unref so the timer doesn't keep the process alive
      if (this._flushTimer.unref) {
        this._flushTimer.unref();
      }
    }
  }

  /**
   * Shorthand for logging a capability check event.
   *
   * @public
   * @param {string} plugin      - plugin name
   * @param {string} capability  - requested capability
   * @param {string} decision    - 'allow' | 'deny' | 'warn' | 'error'
   * @param {string} [detail]    - additional detail
   * @param {string} [sourceType] - plugin source type
   */
  logCapabilityCheck(plugin, capability, decision, detail, sourceType) {
    this.log('capability.check', plugin, {
      capability: capability,
      decision: decision,
      detail: detail || '',
      sourceType: sourceType || '',
    });
  }

  /**
   * Shorthand for logging a sandbox lifecycle event.
   *
   * @public
   * @param {string} event    - 'sandbox.create' | 'sandbox.terminate'
   * @param {string} plugin   - plugin name
   * @param {string} [detail] - additional detail (e.g. thread ID, termination reason)
   */
  logSandboxEvent(event, plugin, detail) {
    this.log(event, plugin, {
      decision: 'allow',
      detail: detail || '',
    });
  }

  /**
   * Shorthand for logging a plugin load event.
   *
   * @public
   * @param {string} plugin      - plugin name
   * @param {string} sourceType  - plugin source type
   * @param {string} decision    - 'allow' | 'deny'
   * @param {string} [detail]    - capability review summary
   */
  logPluginLoad(plugin, sourceType, decision, detail) {
    this.log('plugin.load', plugin, {
      sourceType: sourceType,
      decision: decision,
      detail: detail || '',
    });
  }

  /**
   * Force-flush all buffered entries to disk.
   * @public
   */
  flush() {
    this._flush();
  }

  /**
   * Destroy the audit logger, flushing any remaining entries.
   * After calling destroy(), no more events can be logged.
   * @public
   */
  destroy() {
    this._destroyed = true;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this._flush();
  }

  /**
   * Query audit log entries from the current day's log file.
   *
   * @public
   * @param {object} [filter]
   * @param {string} [filter.event]    - filter by event type
   * @param {string} [filter.plugin]   - filter by plugin name
   * @param {string} [filter.decision] - filter by decision
   * @param {number} [filter.limit]    - max entries to return
   * @returns {AuditEntry[]}
   */
  query(filter) {
    filter = filter || {};
    var entries = this._readLogFile();
    var results = entries;

    if (filter.event) {
      results = results.filter(function (e) { return e.event === filter.event; });
    }
    if (filter.plugin) {
      results = results.filter(function (e) { return e.plugin === filter.plugin; });
    }
    if (filter.decision) {
      results = results.filter(function (e) { return e.decision === filter.decision; });
    }
    if (filter.limit) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  /**
   * Get the log file path for a given date.
   *
   * @public
   * @param {Date} [date] - date object (default: today)
   * @returns {string} absolute path to the JSONL file
   */
  getLogFilePath(date) {
    date = date || new Date();
    var dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    return path.join(this._logDir, 'audit-' + dateStr + '.jsonl');
  }

  // --- Internal ---

  /**
   * Flush buffered entries to the JSONL file.
   * @private
   */
  _flush() {
    if (this._buffer.length === 0) return;

    var entries = this._buffer.splice(0, this._buffer.length);

    try {
      // Ensure log directory exists
      if (!fs.existsSync(this._logDir)) {
        fs.mkdirSync(this._logDir, { recursive: true });
      }

      var logPath = this.getLogFilePath();
      var lines = [];

      for (var i = 0; i < entries.length; i++) {
        lines.push(JSON.stringify(entries[i]));
      }

      fs.appendFileSync(logPath, lines.join('\n') + '\n', 'utf-8');
    } catch (err) {
      this._internalLog('error', 'Failed to write audit log: ' + err.message);
    }
  }

  /**
   * Read all entries from today's log file.
   * @private
   * @returns {AuditEntry[]}
   */
  _readLogFile() {
    var logPath = this.getLogFilePath();

    if (!fs.existsSync(logPath)) {
      return [];
    }

    try {
      var content = fs.readFileSync(logPath, 'utf-8');
      var lines = content.split('\n').filter(function (line) {
        return line.trim().length > 0;
      });

      var entries = [];
      for (var i = 0; i < lines.length; i++) {
        try {
          entries.push(JSON.parse(lines[i]));
        } catch (parseErr) {
          // Skip malformed lines
        }
      }
      return entries;
    } catch (err) {
      this._internalLog('error', 'Failed to read audit log: ' + err.message);
      return [];
    }
  }

  /**
   * Internal logging helper.
   * @private
   */
  _internalLog(level, message) {
    if (this._logger && typeof this._logger[level] === 'function') {
      this._logger[level]('audit-logger', message);
    } else {
      logger[level]('audit-logger', message);
    }
  }
}

module.exports = AuditLogger;
