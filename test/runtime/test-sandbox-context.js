/**
 * Unit tests for WP-117-2: SandboxContext (RPC proxy layer)
 *
 * Tests:
 *   - createSandboxProxy() creates a complete proxy object
 *   - RPC calls through mock message port
 *   - createMainThreadBridge() dispatches to real services
 *   - callService() method routing
 *
 * Run with: node --test test/runtime/test-sandbox-context.js
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

var sandboxContext = require('../../plugins/runtime/sandbox-context');
var createSandboxProxy = sandboxContext.createSandboxProxy;
var createMainThreadBridge = sandboxContext.createMainThreadBridge;
var callService = sandboxContext.callService;

// ---------------------------------------------------------------------------
// Mock MessagePort for testing RPC without Worker Threads
// ---------------------------------------------------------------------------

/**
 * Create a pair of connected mock message ports for testing.
 * Messages sent on one port are delivered to handlers on the same port.
 *
 * @returns {{ port: object }}
 */
function createMockPort() {
  var handlers = [];

  var port = {
    postMessage: function (msg) {
      // Deliver message to all registered handlers
      for (var i = 0; i < handlers.length; i++) {
        handlers[i](msg);
      }
    },
    on: function (event, handler) {
      if (event === 'message') {
        handlers.push(handler);
      }
    },
    off: function (event, handler) {
      if (event === 'message') {
        var idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      }
    },
    _handlers: handlers,
  };

  return port;
}

/**
 * Create a bridged pair of ports that simulate request-response across threads.
 * The proxyPort is used by the sandbox proxy.
 * The bridgePort is used by the main thread bridge.
 *
 * Messages sent on proxyPort are received by bridgePort and vice versa.
 *
 * @returns {{ proxyPort: object, bridgePort: object }}
 */
function createBridgedPorts() {
  var proxyHandlers = [];
  var bridgeHandlers = [];

  var proxyPort = {
    postMessage: function (msg) {
      // Messages from proxy go to bridge handlers
      for (var i = 0; i < bridgeHandlers.length; i++) {
        bridgeHandlers[i](msg);
      }
    },
    on: function (event, handler) {
      if (event === 'message') proxyHandlers.push(handler);
    },
    off: function (event, handler) {
      if (event === 'message') {
        var idx = proxyHandlers.indexOf(handler);
        if (idx !== -1) proxyHandlers.splice(idx, 1);
      }
    },
  };

  var bridgePort = {
    postMessage: function (msg) {
      // Messages from bridge go to proxy handlers
      for (var i = 0; i < proxyHandlers.length; i++) {
        proxyHandlers[i](msg);
      }
    },
    on: function (event, handler) {
      if (event === 'message') bridgeHandlers.push(handler);
    },
    off: function (event, handler) {
      if (event === 'message') {
        var idx = bridgeHandlers.indexOf(handler);
        if (idx !== -1) bridgeHandlers.splice(idx, 1);
      }
    },
  };

  return { proxyPort: proxyPort, bridgePort: bridgePort };
}

// ---------------------------------------------------------------------------
// createSandboxProxy()
// ---------------------------------------------------------------------------

test.describe('createSandboxProxy()', function () {
  test('should create proxy with pluginName', function () {
    var port = createMockPort();
    var proxy = createSandboxProxy('my-plugin', port);
    assert.equal(proxy.pluginName, 'my-plugin');
  });

  test('should have eventBus.emit method', function () {
    var port = createMockPort();
    var proxy = createSandboxProxy('p', port);
    assert.equal(typeof proxy.eventBus.emit, 'function');
  });

  test('should have stateStore methods', function () {
    var port = createMockPort();
    var proxy = createSandboxProxy('p', port);
    assert.equal(typeof proxy.stateStore.get, 'function');
    assert.equal(typeof proxy.stateStore.set, 'function');
    assert.equal(typeof proxy.stateStore.delete, 'function');
  });

  test('should have logger methods', function () {
    var port = createMockPort();
    var proxy = createSandboxProxy('p', port);
    assert.equal(typeof proxy.logger.info, 'function');
    assert.equal(typeof proxy.logger.warn, 'function');
    assert.equal(typeof proxy.logger.error, 'function');
  });

  test('should have config.get method', function () {
    var port = createMockPort();
    var proxy = createSandboxProxy('p', port);
    assert.equal(typeof proxy.config.get, 'function');
  });

  test('should have getProvider method', function () {
    var port = createMockPort();
    var proxy = createSandboxProxy('p', port);
    assert.equal(typeof proxy.getProvider, 'function');
  });

  test('getPlugin should return undefined', function () {
    var port = createMockPort();
    var proxy = createSandboxProxy('p', port);
    assert.equal(proxy.getPlugin('other'), undefined);
  });
});

// ---------------------------------------------------------------------------
// RPC through bridged ports
// ---------------------------------------------------------------------------

test.describe('SandboxContext RPC through bridged ports', function () {
  test('should complete RPC round-trip for stateStore.get', function (t, done) {
    var ports = createBridgedPorts();

    var proxy = createSandboxProxy('test-plugin', ports.proxyPort);

    var services = {
      stateStore: {
        get: function (key) {
          return Promise.resolve('value-for-' + key);
        },
      },
    };

    // Wire up the bridge: when bridgePort receives a message, process it
    // and send response back via bridgePort
    var bridge = createMainThreadBridge(services);

    ports.bridgePort.on('message', function (msg) {
      // Simulate the main thread receiving the RPC request
      // Pass the bridge port as respondTo for sending back the response
      bridge(msg, ports.bridgePort);
    });

    proxy.stateStore.get('test-key').then(function (result) {
      assert.equal(result, 'value-for-test-key');
      done();
    }).catch(done);
  });

  test('should complete RPC round-trip for eventBus.emit', function (t, done) {
    var ports = createBridgedPorts();
    var proxy = createSandboxProxy('test-plugin', ports.proxyPort);
    var emittedEvent = null;
    var emittedData = null;

    var services = {
      eventBus: {
        emit: function (event, data) {
          emittedEvent = event;
          emittedData = data;
          return undefined;
        },
      },
    };

    var bridge = createMainThreadBridge(services);

    ports.bridgePort.on('message', function (msg) {
      bridge(msg, ports.bridgePort);
    });

    proxy.eventBus.emit('plugin:loaded', { name: 'test' }).then(function () {
      assert.equal(emittedEvent, 'plugin:loaded');
      assert.deepEqual(emittedData, { name: 'test' });
      done();
    }).catch(done);
  });

  test('should complete RPC round-trip for logger.info', function (t, done) {
    var ports = createBridgedPorts();
    var proxy = createSandboxProxy('test-plugin', ports.proxyPort);
    var logged = null;

    var services = {
      logger: {
        info: function (msg) { logged = msg; },
      },
    };

    var bridge = createMainThreadBridge(services);

    ports.bridgePort.on('message', function (msg) {
      bridge(msg, ports.bridgePort);
    });

    proxy.logger.info('hello world').then(function () {
      assert.equal(logged, 'hello world');
      done();
    }).catch(done);
  });

  test('should handle RPC error response', function (t, done) {
    var ports = createBridgedPorts();
    var proxy = createSandboxProxy('test-plugin', ports.proxyPort);

    var services = {
      stateStore: {
        get: function () {
          throw new Error('store not available');
        },
      },
    };

    var bridge = createMainThreadBridge(services);

    ports.bridgePort.on('message', function (msg) {
      bridge(msg, ports.bridgePort);
    });

    proxy.stateStore.get('key').then(function () {
      done(new Error('should have thrown'));
    }).catch(function (err) {
      assert.ok(err.message.indexOf('store not available') !== -1);
      done();
    });
  });

  test('should handle unknown RPC method', function (t, done) {
    var ports = createBridgedPorts();
    var proxy = createSandboxProxy('test-plugin', ports.proxyPort);

    var bridge = createMainThreadBridge({});

    ports.bridgePort.on('message', function (msg) {
      bridge(msg, ports.bridgePort);
    });

    // Directly call _rpc with an unknown method
    proxy._rpc('unknown.method', []).then(function () {
      done(new Error('should have thrown'));
    }).catch(function (err) {
      assert.ok(err.message.indexOf('Unknown RPC method') !== -1);
      done();
    });
  });

  test('should handle async service methods', function (t, done) {
    var ports = createBridgedPorts();
    var proxy = createSandboxProxy('test-plugin', ports.proxyPort);

    var services = {
      getProvider: function (name) {
        return Promise.resolve({ name: name, type: 'mock' });
      },
    };

    var bridge = createMainThreadBridge(services);

    ports.bridgePort.on('message', function (msg) {
      bridge(msg, ports.bridgePort);
    });

    proxy.getProvider('my-provider').then(function (result) {
      assert.equal(result.name, 'my-provider');
      assert.equal(result.type, 'mock');
      done();
    }).catch(done);
  });
});

// ---------------------------------------------------------------------------
// createMainThreadBridge()
// ---------------------------------------------------------------------------

test.describe('createMainThreadBridge()', function () {
  test('should ignore non-RPC messages', function () {
    var bridge = createMainThreadBridge({});
    // Should not throw
    bridge({ type: 'other' });
    bridge(null);
    bridge(undefined);
    assert.ok(true);
  });

  test('should call onRpc callback', function () {
    var calls = [];
    var bridge = createMainThreadBridge({}, {
      onRpc: function (method, args) {
        calls.push({ method: method, args: args });
      },
    });

    bridge({
      type: 'rpc-request',
      id: 1,
      method: 'logger.info',
      args: ['hello'],
    }, { postMessage: function () {} });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'logger.info');
    assert.deepEqual(calls[0].args, ['hello']);
  });
});

// ---------------------------------------------------------------------------
// callService()
// ---------------------------------------------------------------------------

test.describe('callService()', function () {
  test('should route eventBus.emit', function () {
    var result = null;
    callService({
      eventBus: { emit: function (e, d) { result = { event: e, data: d }; } },
    }, 'eventBus.emit', ['test-event', { foo: 'bar' }]);
    assert.equal(result.event, 'test-event');
  });

  test('should route stateStore.get', function () {
    var result = callService({
      stateStore: { get: function (k) { return 'val-' + k; } },
    }, 'stateStore.get', ['mykey']);
    assert.equal(result, 'val-mykey');
  });

  test('should route stateStore.set', function () {
    var stored = null;
    callService({
      stateStore: { set: function (k, v) { stored = { k: k, v: v }; } },
    }, 'stateStore.set', ['key', 42]);
    assert.equal(stored.k, 'key');
    assert.equal(stored.v, 42);
  });

  test('should route logger.info', function () {
    var logged = null;
    callService({
      logger: { info: function (m) { logged = m; } },
    }, 'logger.info', ['test message']);
    assert.equal(logged, 'test message');
  });

  test('should throw on unknown method', function () {
    assert.throws(function () {
      callService({}, 'unknown.method', []);
    }, /Unknown RPC method/);
  });

  test('should return undefined when service is null', function () {
    var result = callService({ eventBus: null }, 'eventBus.emit', ['e', 'd']);
    assert.equal(result, undefined);
  });
});
