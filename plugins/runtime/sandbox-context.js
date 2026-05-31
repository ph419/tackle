/**
 * SandboxContext - Standalone RPC proxy context factory
 *
 * Provides two utilities:
 *   1. createSandboxProxy() - creates a PluginContext-like proxy object that
 *      forwards method calls through a message port (used inside Worker Threads)
 *   2. createMainThreadBridge() - creates a message handler for the main thread
 *      side that dispatches RPC calls to real services
 *
 * This module complements the inline SandboxContext in sandbox-worker.js by
 * providing a testable factory that can be used outside of Worker Threads.
 *
 * @module sandbox-context
 */

'use strict';

/**
 * Create a sandbox proxy object that mimics PluginContext interface.
 * All method calls are forwarded as RPC messages through the given port.
 *
 * This is the main-thread side factory for creating proxy objects
 * that can be tested without Worker Threads.
 *
 * @experimental
 * @param {string} pluginName - plugin name
 * @param {object} port - message port with postMessage/on/off methods
 * @returns {object} proxy context object
 */
function createSandboxProxy(pluginName, port) {
  var rpcId = 0;

  /**
   * Send an RPC call and wait for the response.
   * @param {string} method
   * @param {Array} args
   * @returns {Promise<any>}
   */
  function rpc(method, args) {
    var id = ++rpcId;

    return new Promise(function (resolve, reject) {
      var handler = function (msg) {
        if (msg.type === 'rpc-response' && msg.id === id) {
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
  }

  return {
    pluginName: pluginName,
    _rpc: rpc,

    eventBus: {
      emit: function (event, data) {
        return rpc('eventBus.emit', [event, data]);
      },
    },

    stateStore: {
      get: function (key) {
        return rpc('stateStore.get', [key]);
      },
      set: function (key, value) {
        return rpc('stateStore.set', [key, value]);
      },
      delete: function (key) {
        return rpc('stateStore.delete', [key]);
      },
    },

    logger: {
      info: function (msg) {
        return rpc('logger.info', [msg]);
      },
      warn: function (msg) {
        return rpc('logger.warn', [msg]);
      },
      error: function (msg) {
        return rpc('logger.error', [msg]);
      },
    },

    config: {
      get: function (key) {
        return rpc('config.get', [key]);
      },
    },

    getProvider: function (name) {
      return rpc('getProvider', [name]);
    },

    getPlugin: function () {
      return undefined; // Not supported in sandbox
    },
  };
}

/**
 * Create a main-thread RPC handler that dispatches calls to real services.
 *
 * @experimental
 * @param {object} services - { eventBus, stateStore, logger, configManager, getProvider }
 * @param {object} options
 * @param {Function} [options.onRpc] - callback for each RPC call (for testing/auditing)
 * @returns {Function} message handler function (to attach to worker/port 'message' event)
 */
function createMainThreadBridge(services, options) {
  options = options || {};

  /**
   * Message handler for RPC dispatch.
   *
   * @param {object} msg - RPC request message
   * @param {object} [respondTo] - object with postMessage method (e.g. Worker or test port)
   */
  return function handleRpcMessage(msg, respondTo) {
    if (!msg || msg.type !== 'rpc-request') return;

    var id = msg.id;
    var method = msg.method;
    var args = msg.args || [];

    // Notify callback
    if (options.onRpc) {
      options.onRpc(method, args);
    }

    // Execute the method
    try {
      var result = callService(services, method, args);

      if (result && typeof result.then === 'function') {
        result.then(function (resolved) {
          sendResponse(respondTo, id, resolved, null);
        }).catch(function (err) {
          sendResponse(respondTo, id, null, err.message);
        });
      } else {
        sendResponse(respondTo, id, result, null);
      }
    } catch (err) {
      sendResponse(respondTo, id, null, err.message);
    }
  };
}

/**
 * Call a service method by name.
 *
 * @internal
 * @param {object} services
 * @param {string} method
 * @param {Array} args
 * @returns {*}
 */
function callService(services, method, args) {
  // Known methods: if service is available, call it; if not, return undefined
  if (method === 'eventBus.emit') {
    return services.eventBus ? services.eventBus.emit(args[0], args[1]) : undefined;
  }
  if (method === 'stateStore.get') {
    return services.stateStore ? services.stateStore.get(args[0]) : undefined;
  }
  if (method === 'stateStore.set') {
    return services.stateStore ? services.stateStore.set(args[0], args[1]) : undefined;
  }
  if (method === 'stateStore.delete') {
    return services.stateStore ? services.stateStore.delete(args[0]) : undefined;
  }
  if (method === 'logger.info') {
    return services.logger ? services.logger.info(args[0]) : undefined;
  }
  if (method === 'logger.warn') {
    return services.logger ? services.logger.warn(args[0]) : undefined;
  }
  if (method === 'logger.error') {
    return services.logger ? services.logger.error(args[0]) : undefined;
  }
  if (method === 'config.get') {
    return services.configManager ? services.configManager.get(args[0]) : undefined;
  }
  if (method === 'getProvider') {
    return services.getProvider ? services.getProvider(args[0]) : undefined;
  }

  throw new Error('Unknown RPC method: ' + method);
}

/**
 * Send an RPC response.
 *
 * @internal
 * @param {object|null} respondTo - object with postMessage method
 * @param {number} id - RPC call ID
 * @param {*} result - result value
 * @param {string|null} error - error message
 */
function sendResponse(respondTo, id, result, error) {
  if (!respondTo) return;

  var response = {
    type: 'rpc-response',
    id: id,
  };

  if (error) {
    response.error = error;
  } else {
    response.result = result;
  }

  respondTo.postMessage(response);
}

module.exports = {
  createSandboxProxy: createSandboxProxy,
  createMainThreadBridge: createMainThreadBridge,
  callService: callService,
};
