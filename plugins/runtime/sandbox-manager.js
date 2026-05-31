/**
 * SandboxManager - Worker Thread lifecycle management for plugin sandboxing
 *
 * Manages the creation, activation, execution, and termination of Worker Threads
 * for external (npm/local) plugins. Core plugins are not sandboxed.
 *
 * Architecture:
 *   Main Thread                          Worker Thread
 *   ┌──────────────────────┐            ┌──────────────────────┐
 *   │ SandboxManager        │            │ Sandbox Worker        │
 *   │  ├─ createWorker()    │ postMessage│  Plugin.onActivate()  │
 *   │  ├─ activateInSandbox├───────────>│  Plugin.handle() etc  │
 *   │  ├─ terminateWorker()│            │  SandboxContext proxy  │
 *   │  └─ auditLogger       │<───────────│  result / error       │
 *   └──────────────────────┘            └──────────────────────┘
 *
 * RPC protocol:
 *   Main -> Worker: { type: 'rpc-request', id, method, args }
 *   Worker -> Main: { type: 'rpc-response', id, result?, error? }
 *   Worker -> Main: { type: 'activated' } | { type: 'activation-error', error }
 *   Main -> Worker: { type: 'terminate' }
 *
 * @module sandbox-manager
 */

// FILE-SIZE-MONITOR: 590 lines (as of 2026-05-31)
// SPLIT-THRESHOLD: 800 lines — if exceeded, consider splitting into:
//   - sandbox-core.js (Worker Thread lifecycle management)
//   - sandbox-rpc.js (RPC communication, message handling)

'use strict';

var path = require('path');
var workerThreads = require('worker_threads');
var AuditLogger = require('./audit-logger');
var capabilities = require('../contracts/capabilities');
var isCapabilityAllowed = capabilities.isCapabilityAllowed;
var shouldSandbox = capabilities.shouldSandbox;
var sandboxContext = require('./sandbox-context');
var callService = sandboxContext.callService;

/**
 * @typedef {object} WorkerEntry
 * @property {Worker} worker   - Worker Thread instance
 * @property {string} plugin   - plugin name
 * @property {string} sourceType - 'npm' | 'local'
 * @property {number} threadId - worker thread ID
 * @property {boolean} active  - whether the worker is currently active
 */

/**
 * SandboxManager manages Worker Thread lifecycle for external plugins.
 * @experimental 沙箱功能处于实验阶段，API 可能在未来版本中变更
 */
class SandboxManager {
  /**
   * @experimental
   * @param {object} [options]
   * @param {object} [options.auditLogger]  - AuditLogger instance (created if not provided)
   * @param {string} [options.logDir]       - directory for audit logs (used if creating AuditLogger)
   * @param {object} [options.logger]       - Logger instance for internal logging
   * @param {string} [options.sandboxScriptPath] - path to sandbox worker script (default: auto-detected)
   */
  constructor(options) {
    options = options || {};
    this._logger = options.logger || null;
    this._sandboxScriptPath = options.sandboxScriptPath || null;

    // Initialize audit logger
    if (options.auditLogger) {
      this._auditLogger = options.auditLogger;
    } else {
      this._auditLogger = new AuditLogger({
        logDir: options.logDir,
        logger: this._logger,
      });
    }

    /** @type {Map<string, WorkerEntry>} plugin name -> worker entry */
    this._workers = new Map();

    /** @type {Map<string, Function>} pending RPC response handlers */
    this._pendingRpc = new Map();

    /** @type {number} RPC call ID counter */
    this._rpcIdCounter = 0;
  }

  // --- Public API ---

  /**
   * Check if a plugin should run in a sandbox.
   *
   * @public
   * @param {string} sourceType - 'core' | 'npm' | 'local'
   * @returns {boolean} true if the plugin should be sandboxed
   */
  requiresSandbox(sourceType) {
    return shouldSandbox(sourceType);
  }

  /**
   * Create a sandboxed Worker Thread for a plugin and activate it.
   *
   * The plugin's onActivate() will be called inside the worker with a
   * SandboxContext proxy. All context method calls are forwarded via RPC
   * to the main thread, where capability checks are applied.
   *
   * @experimental
   * @param {object} options
   * @param {string} options.pluginName   - plugin name
   * @param {string} options.pluginPath   - absolute path to the plugin directory
   * @param {string} options.sourceType   - 'npm' | 'local'
   * @param {object} options.declaredCapabilities - capabilities from plugin.json
   * @param {object} options.mainThreadServices - { eventBus, stateStore, logger, configManager, getProvider }
   * @param {number} [options.timeout=30000] - activation timeout in ms
   * @returns {Promise<void>}
   */
  async createSandboxedWorker(options) {
    var pluginName = options.pluginName;
    var pluginPath = options.pluginPath;
    var sourceType = options.sourceType;
    var declaredCapabilities = options.declaredCapabilities || {};
    var mainThreadServices = options.mainThreadServices || {};
    var timeout = options.timeout || 30000;

    // Check if already sandboxed
    if (this._workers.has(pluginName)) {
      throw new Error('Plugin "' + pluginName + '" already has an active sandbox');
    }

    // Validate pluginPath (basic path traversal protection)
    var normalizedPath = path.normalize(pluginPath);
    if (!path.isAbsolute(normalizedPath)) {
      throw new Error('pluginPath must be absolute, got: ' + pluginPath);
    }
    var fs = require('fs');
    if (!fs.existsSync(normalizedPath)) {
      throw new Error('pluginPath does not exist: ' + normalizedPath);
    }
    var stat = fs.statSync(normalizedPath);
    if (!stat.isDirectory()) {
      throw new Error('pluginPath must be a directory, got: ' + normalizedPath);
    }
    pluginPath = normalizedPath;

    // Determine sandbox worker script path
    var sandboxScriptPath = this._getSandboxScriptPath();

    this._log('info', 'Creating sandbox for plugin "' + pluginName + '" (source: ' + sourceType + ')');

    // Create the Worker with plugin data
    var workerData = {
      pluginName: pluginName,
      pluginPath: pluginPath,
      sourceType: sourceType,
      capabilities: declaredCapabilities,
    };

    var worker;
    try {
      worker = new workerThreads.Worker(sandboxScriptPath, {
        workerData: workerData,
      });
    } catch (err) {
      this._auditLogger.logSandboxEvent('sandbox.create', pluginName,
        'failed: ' + err.message);
      throw new Error('Failed to create sandbox worker for "' + pluginName + '": ' + err.message);
    }

    var threadId = worker.threadId;

    // Store the worker entry
    var entry = {
      worker: worker,
      plugin: pluginName,
      sourceType: sourceType,
      threadId: threadId,
      active: false,
      declaredCapabilities: declaredCapabilities,
      mainThreadServices: mainThreadServices,
    };
    this._workers.set(pluginName, entry);

    // Set up message handler for RPC and lifecycle events
    var self = this;
    worker.on('message', function (msg) {
      self._handleWorkerMessage(pluginName, msg);
    });

    worker.on('error', function (err) {
      self._log('error', 'Sandbox worker error for "' + pluginName + '": ' + err.message);
      self._auditLogger.logSandboxEvent('sandbox.terminate', pluginName,
        'error: ' + err.message);
      self._workers.delete(pluginName);
    });

    worker.on('exit', function (code) {
      if (code !== 0) {
        self._log('warn', 'Sandbox worker for "' + pluginName + '" exited with code ' + code);
      }
      self._workers.delete(pluginName);
    });

    // Audit: sandbox created
    this._auditLogger.logSandboxEvent('sandbox.create', pluginName,
      'threadId=' + threadId + ', sourceType=' + sourceType);

    // Wait for activation with timeout
    return new Promise(function (resolve, reject) {
      var timeoutId = setTimeout(function () {
        self.terminateWorker(pluginName);
        reject(new Error('Sandbox activation timeout for "' + pluginName + '" after ' + timeout + 'ms'));
      }, timeout);

      var activationHandler = function (msg) {
        if (msg.type === 'activated') {
          clearTimeout(timeoutId);
          entry.active = true;
          self._log('info', 'Sandbox activated for plugin "' + pluginName + '" (threadId=' + threadId + ')');
          resolve();
        } else if (msg.type === 'activation-error') {
          clearTimeout(timeoutId);
          self.terminateWorker(pluginName);
          reject(new Error('Sandbox activation failed for "' + pluginName + '": ' + msg.error));
        }
      };

      // Store the activation handler temporarily
      entry._activationHandler = activationHandler;
    });
  }

  /**
   * Terminate a sandboxed worker.
   *
   * @experimental
   * @param {string} pluginName - plugin name
   * @param {string} [reason]   - termination reason for audit
   * @returns {Promise<void>}
   */
  async terminateWorker(pluginName, reason) {
    var entry = this._workers.get(pluginName);
    if (!entry) {
      return; // Already terminated or never created
    }

    this._log('info', 'Terminating sandbox for plugin "' + pluginName + '"' +
      (reason ? ' (reason: ' + reason + ')' : ''));

    try {
      // Send terminate signal
      entry.worker.postMessage({ type: 'terminate' });

      // Give the worker a short grace period, then force terminate
      await Promise.race([
        new Promise(function (resolve) {
          entry.worker.on('exit', function () { resolve(); });
          // Also handle the case where exit doesn't fire quickly
          setTimeout(function () { resolve(); }, 2000);
        }),
        entry.worker.terminate(),
      ]);
    } catch (err) {
      // Force terminate on error
      try {
        await entry.worker.terminate();
      } catch (terminateErr) {
        // Ignore
      }
    }

    this._auditLogger.logSandboxEvent('sandbox.terminate', pluginName,
      'reason=' + (reason || 'normal') + ', threadId=' + entry.threadId);

    // Clean up activation handler reference to prevent memory leak
    delete entry._activationHandler;

    this._workers.delete(pluginName);
  }

  /**
   * Terminate all active sandbox workers.
   *
   * @experimental
   * @returns {Promise<void>}
   */
  async terminateAll() {
    var names = Array.from(this._workers.keys());
    var self = this;

    for (var i = 0; i < names.length; i++) {
      await self.terminateWorker(names[i], 'shutdown');
    }
  }

  /**
   * Check if a plugin has an active sandbox.
   *
   * @experimental
   * @param {string} pluginName
   * @returns {boolean}
   */
  hasWorker(pluginName) {
    return this._workers.has(pluginName);
  }

  /**
   * Get info about a sandboxed plugin.
   *
   * @experimental
   * @param {string} pluginName
   * @returns {{ threadId: number, sourceType: string, active: boolean }|null}
   */
  getWorkerInfo(pluginName) {
    var entry = this._workers.get(pluginName);
    if (!entry) return null;
    return {
      threadId: entry.threadId,
      sourceType: entry.sourceType,
      active: entry.active,
    };
  }

  /**
   * Get the AuditLogger instance.
   * @experimental
   * @returns {AuditLogger}
   */
  getAuditLogger() {
    return this._auditLogger;
  }

  /**
   * Destroy the SandboxManager, terminating all workers and flushing audit logs.
   * @experimental
   */
  destroy() {
    // Synchronous cleanup for process exit
    var names = Array.from(this._workers.keys());
    for (var i = 0; i < names.length; i++) {
      var entry = this._workers.get(names[i]);
      try {
        entry.worker.terminate();
      } catch (err) {
        // Ignore
      }
    }
    this._workers.clear();

    if (this._auditLogger) {
      this._auditLogger.destroy();
    }
  }

  // --- Internal ---

  /**
   * Handle an incoming message from a worker thread.
   *
   * @param {string} pluginName
   * @param {object} msg
   * @private
   */
  _handleWorkerMessage(pluginName, msg) {
    var entry = this._workers.get(pluginName);
    if (!entry) return;

    // Activation response
    if (msg.type === 'activated' || msg.type === 'activation-error') {
      if (entry._activationHandler) {
        entry._activationHandler(msg);
        delete entry._activationHandler;
      }
      return;
    }

    // RPC request from worker
    if (msg.type === 'rpc-request') {
      this._handleRpcRequest(pluginName, msg);
      return;
    }
  }

  /**
   * Handle an RPC request from a sandboxed worker.
   * Applies capability checks before forwarding to main thread services.
   *
   * @param {string} pluginName
   * @param {object} msg - { id, method, args }
   * @private
   */
  _handleRpcRequest(pluginName, msg) {
    var entry = this._workers.get(pluginName);
    if (!entry) return;

    var id = msg.id;
    var method = msg.method;
    var args = msg.args || [];
    var worker = entry.worker;
    var sourceType = entry.sourceType;
    var declaredCapabilities = entry.declaredCapabilities;
    var services = entry.mainThreadServices;

    // Map RPC method names to required capabilities
    var requiredCapability = this._methodToCapability(method);

    if (requiredCapability) {
      var check = isCapabilityAllowed(sourceType, requiredCapability, declaredCapabilities);

      if (!check.allowed) {
        // Deny the request
        worker.postMessage({
          type: 'rpc-response',
          id: id,
          error: 'SecurityError: ' + check.reason,
        });

        this._auditLogger.logCapabilityCheck(
          pluginName,
          requiredCapability,
          'deny',
          check.reason + ' (method: ' + method + ')',
          sourceType
        );

        // Also log a capability violation event
        this._auditLogger.log('capability.violation', pluginName, {
          capability: requiredCapability,
          decision: 'deny',
          detail: 'RPC method "' + method + '" blocked: ' + check.reason,
          sourceType: sourceType,
        });

        return;
      }
    }

    // Execute the method on the main thread
    try {
      var result = this._callMainThreadService(services, method, args);

      // Handle async results
      if (result && typeof result.then === 'function') {
        var self = this;
        result.then(function (resolved) {
          worker.postMessage({
            type: 'rpc-response',
            id: id,
            result: self._sanitizeForTransfer(resolved),
          });
        }).catch(function (err) {
          worker.postMessage({
            type: 'rpc-response',
            id: id,
            error: err.message,
          });
        });
      } else {
        worker.postMessage({
          type: 'rpc-response',
          id: id,
          result: this._sanitizeForTransfer(result),
        });
      }

      // Audit the allowed call
      this._auditLogger.logCapabilityCheck(
        pluginName,
        requiredCapability || method,
        'allow',
        'method: ' + method,
        sourceType
      );
    } catch (err) {
      worker.postMessage({
        type: 'rpc-response',
        id: id,
        error: err.message,
      });

      this._auditLogger.logCapabilityCheck(
        pluginName,
        requiredCapability || method,
        'error',
        err.message,
        sourceType
      );
    }
  }

  /**
   * Map an RPC method name to the required capability.
   * Returns null for methods that are always allowed (eventBus.emit, stateStore, logger).
   *
   * @param {string} method
   * @returns {string|null}
   * @private
   */
  _methodToCapability(method) {
    // Methods that require specific capabilities
    if (method === 'getProvider') return 'plugin.access';

    // Basic services are always allowed — no capability check needed
    if (method.indexOf('eventBus.') === 0) return null;
    if (method.indexOf('stateStore.') === 0) return null;
    if (method.indexOf('logger.') === 0) return null;
    if (method.indexOf('config.') === 0) return null;

    // Unknown method — deny
    return method;
  }

  /**
   * Call a method on main thread services based on the RPC method name.
   * Delegates to the shared callService function from sandbox-context.
   *
   * @param {object} services - main thread services
   * @param {string} method   - RPC method name
   * @param {Array} args      - method arguments
   * @returns {*}
   * @private
   */
  _callMainThreadService(services, method, args) {
    return callService(services, method, args);
  }

  /**
   * Sanitize a value for transfer across the Worker Thread boundary.
   * Functions and non-serializable values are replaced with placeholders.
   *
   * Handles the following value types:
   *   - undefined/null: returned as-is
   *   - function: replaced with the string '[Function]'
   *   - primitives (string, number, boolean): returned as-is
   *   - arrays: each element is recursively sanitized via `.map()`
   *   - plain objects: each own enumerable property is inspected;
   *     function values become '[Function]', object values recurse,
   *     primitives are kept verbatim
   *
   * @param {*} value - the value to sanitize for structured clone transfer
   * @returns {*} a sanitized copy safe for `postMessage()` serialization
   * @private
   */
  _sanitizeForTransfer(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;

    if (typeof value === 'function') {
      return '[Function]';
    }

    if (typeof value !== 'object') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(this._sanitizeForTransfer.bind(this));
    }

    // Plain object — recurse
    var result = {};
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (typeof value[k] === 'function') {
        result[k] = '[Function]';
      } else if (typeof value[k] === 'object' && value[k] !== null) {
        result[k] = this._sanitizeForTransfer(value[k]);
      } else {
        result[k] = value[k];
      }
    }
    return result;
  }

  /**
   * Get the path to the sandbox worker script.
   * Defaults to sandbox-worker.js in the same directory as this module.
   *
   * @returns {string} absolute path to the sandbox worker script
   * @private
   */
  _getSandboxScriptPath() {
    if (this._sandboxScriptPath) {
      return this._sandboxScriptPath;
    }
    return path.join(__dirname, 'sandbox-worker.js');
  }

  /**
   * Internal logging helper. Delegates to the injected logger when available,
   * otherwise falls back to console.log with a prefixed tag.
   *
   * @param {'info'|'warn'|'error'} level - log severity level
   * @param {string} message - human-readable log message
   * @private
   */
  _log(level, message) {
    if (this._logger && typeof this._logger[level] === 'function') {
      this._logger[level]('sandbox-manager', message);
    }
  }
}

module.exports = SandboxManager;
