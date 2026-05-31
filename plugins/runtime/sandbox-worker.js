/**
 * sandbox-worker.js - Worker Thread script for sandboxed plugin execution
 *
 * This script runs inside a Worker Thread and:
 *   1. Receives plugin metadata via workerData
 *   2. Creates a SandboxContext proxy for the plugin
 *   3. Loads the plugin module
 *   4. Calls plugin.onActivate(sandboxContext)
 *   5. Forwards all context method calls via postMessage RPC to the main thread
 *
 * This file is loaded by SandboxManager as the Worker entry point.
 *
 * @module sandbox-worker
 */

'use strict';

var workerThreads = require('worker_threads');
var parentPort = workerThreads.parentPort;
var workerData = workerThreads.workerData;

if (!workerData || !workerData.pluginName) {
  parentPort.postMessage({
    type: 'activation-error',
    error: 'Missing workerData.pluginName',
  });
  // Exit with error
  process.exit(1);
}

var pluginName = workerData.pluginName;
var pluginPath = workerData.pluginPath;
var sourceType = workerData.sourceType;
var declaredCapabilities = workerData.capabilities || {};

// ---------------------------------------------------------------------------
// SandboxContext - RPC proxy layer (runs inside worker)
// ---------------------------------------------------------------------------

/**
 * SandboxContext provides a PluginContext-compatible interface inside the worker.
 * All method calls are forwarded to the main thread via postMessage RPC.
 *
 * @internal 此函数仅在 Worker Thread 内部使用
 * @param {string} name - plugin name
 * @param {MessagePort} port - parent port for communication
 */
function SandboxContext(name, port) {
  this.pluginName = name;
  this._port = port;
  this._rpcId = 0;

  // Proxy eventBus: emit only (subscribe requires main-thread coordination)
  this.eventBus = {
    emit: function (event, data) {
      return this._rpc('eventBus.emit', [event, data]);
    }.bind(this),
  };

  // Proxy stateStore
  this.stateStore = {
    get: function (key) {
      return this._rpc('stateStore.get', [key]);
    }.bind(this),
    set: function (key, value) {
      return this._rpc('stateStore.set', [key, value]);
    }.bind(this),
    delete: function (key) {
      return this._rpc('stateStore.delete', [key]);
    }.bind(this),
  };

  // Proxy logger
  this.logger = {
    info: function (msg) {
      return this._rpc('logger.info', [msg]);
    }.bind(this),
    warn: function (msg) {
      return this._rpc('logger.warn', [msg]);
    }.bind(this),
    error: function (msg) {
      return this._rpc('logger.error', [msg]);
    }.bind(this),
  };

  // config (read-only)
  this.config = {
    get: function (key) {
      return this._rpc('config.get', [key]);
    }.bind(this),
  };

  // Provider cache
  this._providerCache = {};
}

/**
 * Get a provider by name (via RPC to main thread).
 *
 * @internal
 * @param {string} name - provider name
 * @returns {Promise<object>}
 */
SandboxContext.prototype.getProvider = function (name) {
  if (this._providerCache[name]) {
    return Promise.resolve(this._providerCache[name]);
  }

  var self = this;
  return this._rpc('getProvider', [name]).then(function (provider) {
    self._providerCache[name] = provider;
    return provider;
  });
};

/**
 * Get another plugin by name (not supported in sandbox — returns undefined).
 *
 * @param {string} _name
 * @returns {undefined}
 */
SandboxContext.prototype.getPlugin = function (_name) {
  // Cross-plugin access not supported in sandbox for security
  return undefined;
};

/**
 * Send an RPC request to the main thread and wait for the response.
 *
 * @param {string} method - method name
 * @param {Array} args - arguments (must be serializable)
 * @returns {Promise<any>}
 */
SandboxContext.prototype._rpc = function (method, args) {
  var id = ++this._rpcId;
  var port = this._port;
  var timeout = 30000;

  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      port.off('message', handler);
      reject(new Error('RPC timeout for ' + method + ' after ' + timeout + 'ms'));
    }, timeout);

    var handler = function (msg) {
      if (msg.type === 'rpc-response' && msg.id === id) {
        clearTimeout(timer);
        port.off('message', handler);
        if (msg.error) {
          reject(new Error(msg.error));
        } else {
          resolve(msg.result);
        }
      }
    };

    port.on('message', handler);
    port.postMessage({
      type: 'rpc-request',
      id: id,
      method: method,
      args: args,
    });
  });
};

// ---------------------------------------------------------------------------
// Load and activate the plugin
// ---------------------------------------------------------------------------

try {
  // Require the plugin module
  var indexJsPath = require('path').resolve(pluginPath, 'index.js');
  var PluginClass = require(indexJsPath);

  if (typeof PluginClass !== 'function') {
    throw new Error('Plugin "' + pluginName + '" does not export a constructor function');
  }

  var pluginInstance = new PluginClass();
  var context = new SandboxContext(pluginName, parentPort);

  // Call onActivate
  if (typeof pluginInstance.onActivate === 'function') {
    var activateResult = pluginInstance.onActivate(context);

    // Handle async onActivate
    if (activateResult && typeof activateResult.then === 'function') {
      activateResult.then(function () {
        parentPort.postMessage({ type: 'activated' });
      }).catch(function (err) {
        parentPort.postMessage({
          type: 'activation-error',
          error: err.message,
        });
      });
    } else {
      parentPort.postMessage({ type: 'activated' });
    }
  } else {
    parentPort.postMessage({ type: 'activated' });
  }
} catch (err) {
  parentPort.postMessage({
    type: 'activation-error',
    error: 'Failed to load plugin "' + pluginName + '": ' + err.message,
  });
}

// Handle terminate signal from main thread
parentPort.on('message', function (msg) {
  if (msg.type === 'terminate') {
    process.exit(0);
  }
});
