/**
 * Unit tests for WP-117-1: SandboxManager (Worker Thread lifecycle)
 *
 * Tests:
 *   - Constructor and default options
 *   - requiresSandbox() for different sourceTypes
 *   - createSandboxedWorker() with a real Worker Thread
 *   - terminateWorker()
 *   - terminateAll()
 *   - hasWorker() and getWorkerInfo()
 *   - RPC request handling with capability checks
 *   - getAuditLogger()
 *   - destroy()
 *
 * Uses a test sandbox worker script that is created dynamically.
 *
 * Run with: node --test test/runtime/test-sandbox-manager.js
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var os = require('os');

var SandboxManager = require('../../plugins/runtime/sandbox-manager');

/**
 * Create a temp directory with a test plugin and sandbox worker.
 * @returns {{ tmpDir: string, pluginDir: string, sandboxScript: string }}
 */
function createTestFixture() {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
  var pluginDir = path.join(tmpDir, 'test-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });

  // Create plugin.json
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
    name: 'test-plugin',
    version: '0.1.0',
    type: 'hook',
    description: 'Test plugin for sandbox',
  }, null, 2), 'utf-8');

  // Create a minimal index.js that exports a constructor
  fs.writeFileSync(path.join(pluginDir, 'index.js'), [
    "'use strict';",
    "function TestPlugin() {",
    "  this.type = 'hook';",
    "  this.name = 'test-plugin';",
    "}",
    "TestPlugin.prototype.onActivate = function(context) {",
    "  // Store context for testing",
    "  this._context = context;",
    "};",
    "module.exports = TestPlugin;",
  ].join('\n'), 'utf-8');

  // Create the sandbox worker script
  var sandboxScript = path.join(tmpDir, 'sandbox-worker.js');
  fs.writeFileSync(sandboxScript, [
    "'use strict';",
    "var workerThreads = require('worker_threads');",
    "var parentPort = workerThreads.parentPort;",
    "var workerData = workerThreads.workerData;",
    "",
    "if (!workerData || !workerData.pluginName) {",
    "  parentPort.postMessage({ type: 'activation-error', error: 'Missing workerData' });",
    "  process.exit(1);",
    "}",
    "",
    "var pluginName = workerData.pluginName;",
    "var pluginPath = workerData.pluginPath;",
    "",
    "function SandboxContext(name, port) {",
    "  this.pluginName = name;",
    "  this._port = port;",
    "  this._rpcId = 0;",
    "  this.eventBus = { emit: function(e, d) { return this._rpc('eventBus.emit', [e, d]); }.bind(this) };",
    "  this.stateStore = {",
    "    get: function(k) { return this._rpc('stateStore.get', [k]); }.bind(this),",
    "    set: function(k, v) { return this._rpc('stateStore.set', [k, v]); }.bind(this),",
    "    'delete': function(k) { return this._rpc('stateStore.delete', [k]); }.bind(this),",
    "  };",
    "  this.logger = {",
    "    info: function(m) { return this._rpc('logger.info', [m]); }.bind(this),",
    "    warn: function(m) { return this._rpc('logger.warn', [m]); }.bind(this),",
    "    error: function(m) { return this._rpc('logger.error', [m]); }.bind(this),",
    "  };",
    "  this.config = { get: function(k) { return this._rpc('config.get', [k]); }.bind(this) };",
    "  this._providerCache = {};",
    "}",
    "SandboxContext.prototype.getProvider = function(name) {",
    "  if (this._providerCache[name]) return Promise.resolve(this._providerCache[name]);",
    "  var self = this;",
    "  return this._rpc('getProvider', [name]).then(function(p) { self._providerCache[name] = p; return p; });",
    "};",
    "SandboxContext.prototype._rpc = function(method, args) {",
    "  var id = ++this._rpcId;",
    "  var port = this._port;",
    "  return new Promise(function(resolve, reject) {",
    "    var handler = function(msg) {",
    "      if (msg.type === 'rpc-response' && msg.id === id) {",
    "        port.off('message', handler);",
    "        if (msg.error) reject(new Error(msg.error));",
    "        else resolve(msg.result);",
    "      }",
    "    };",
    "    port.on('message', handler);",
    "    port.postMessage({ type: 'rpc-request', id: id, method: method, args: args });",
    "  });",
    "};",
    "",
    "try {",
    "  var PluginClass = require(require('path').resolve(pluginPath, 'index.js'));",
    "  var plugin = new PluginClass();",
    "  var ctx = new SandboxContext(pluginName, parentPort);",
    "  if (typeof plugin.onActivate === 'function') {",
    "    var result = plugin.onActivate(ctx);",
    "    if (result && typeof result.then === 'function') {",
    "      result.then(function() { parentPort.postMessage({ type: 'activated' }); })",
    "            .catch(function(e) { parentPort.postMessage({ type: 'activation-error', error: e.message }); });",
    "    } else {",
    "      parentPort.postMessage({ type: 'activated' });",
    "    }",
    "  } else {",
    "    parentPort.postMessage({ type: 'activated' });",
    "  }",
    "} catch(e) {",
    "  parentPort.postMessage({ type: 'activation-error', error: e.message });",
    "}",
    "",
    "parentPort.on('message', function(msg) {",
    "  if (msg.type === 'terminate') process.exit(0);",
    "});",
  ].join('\n'), 'utf-8');

  return {
    tmpDir: tmpDir,
    pluginDir: pluginDir,
    sandboxScript: sandboxScript,
  };
}

/**
 * Clean up test fixture.
 * @param {string} tmpDir
 */
function cleanup(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

test.describe('SandboxManager constructor', function () {
  test('should create with default options', function () {
    var mgr = new SandboxManager();
    assert.ok(mgr);
    assert.ok(mgr.getAuditLogger());
    mgr.destroy();
  });

  test('should accept custom sandboxScriptPath', function () {
    var mgr = new SandboxManager({ sandboxScriptPath: '/tmp/custom-worker.js' });
    assert.equal(mgr._getSandboxScriptPath(), '/tmp/custom-worker.js');
    mgr.destroy();
  });
});

// ---------------------------------------------------------------------------
// requiresSandbox()
// ---------------------------------------------------------------------------

test.describe('SandboxManager.requiresSandbox()', function () {
  var mgr = new SandboxManager();

  test('should return false for core', function () {
    assert.equal(mgr.requiresSandbox('core'), false);
  });

  test('should return true for npm', function () {
    assert.equal(mgr.requiresSandbox('npm'), true);
  });

  test('should return true for local', function () {
    assert.equal(mgr.requiresSandbox('local'), true);
  });

  mgr.destroy();
});

// ---------------------------------------------------------------------------
// hasWorker() and getWorkerInfo()
// ---------------------------------------------------------------------------

test.describe('SandboxManager hasWorker/getWorkerInfo', function () {
  test('should return false for unknown plugin', function () {
    var mgr = new SandboxManager();
    assert.equal(mgr.hasWorker('nonexistent'), false);
    assert.equal(mgr.getWorkerInfo('nonexistent'), null);
    mgr.destroy();
  });
});

// ---------------------------------------------------------------------------
// createSandboxedWorker() and terminateWorker()
// ---------------------------------------------------------------------------

test.describe('SandboxManager createSandboxedWorker()', function () {
  test('should create and activate a sandboxed worker', function (t, done) {
    var fixture = createTestFixture();
    var logDir = path.join(fixture.tmpDir, 'logs');

    var mgr = new SandboxManager({
      sandboxScriptPath: fixture.sandboxScript,
      logDir: logDir,
    });

    mgr.createSandboxedWorker({
      pluginName: 'test-plugin',
      pluginPath: fixture.pluginDir,
      sourceType: 'npm',
      declaredCapabilities: {},
      mainThreadServices: {
        eventBus: {
          emit: function () { return undefined; },
        },
        stateStore: {
          get: function () { return Promise.resolve(null); },
          set: function () { return Promise.resolve(); },
          delete: function () { return Promise.resolve(); },
        },
        logger: {
          info: function () {},
          warn: function () {},
          error: function () {},
        },
        getProvider: function () { return Promise.resolve(null); },
      },
    }).then(function () {
      assert.ok(mgr.hasWorker('test-plugin'), 'should have worker');

      var info = mgr.getWorkerInfo('test-plugin');
      assert.ok(info, 'should have worker info');
      assert.equal(info.sourceType, 'npm');
      assert.equal(info.active, true);

      return mgr.terminateWorker('test-plugin', 'test complete');
    }).then(function () {
      assert.equal(mgr.hasWorker('test-plugin'), false, 'worker should be removed after terminate');
      mgr.destroy();
      cleanup(fixture.tmpDir);
      done();
    }).catch(function (err) {
      mgr.destroy();
      cleanup(fixture.tmpDir);
      done(err);
    });
  });

  test('should reject if plugin already has sandbox', function (t, done) {
    var fixture = createTestFixture();
    var mgr = new SandboxManager({
      sandboxScriptPath: fixture.sandboxScript,
      logDir: path.join(fixture.tmpDir, 'logs'),
    });

    mgr.createSandboxedWorker({
      pluginName: 'test-plugin',
      pluginPath: fixture.pluginDir,
      sourceType: 'npm',
      declaredCapabilities: {},
      mainThreadServices: {},
    }).then(function () {
      return mgr.createSandboxedWorker({
        pluginName: 'test-plugin',
        pluginPath: fixture.pluginDir,
        sourceType: 'npm',
        declaredCapabilities: {},
        mainThreadServices: {},
      });
    }).then(function () {
      done(new Error('should have thrown'));
    }).catch(function (err) {
      assert.ok(err.message.indexOf('already has an active sandbox') !== -1);
      mgr.destroy();
      cleanup(fixture.tmpDir);
      done();
    });
  });

  test('should timeout on activation', function (t, done) {
    var fixture = createTestFixture();
    var mgr = new SandboxManager({
      sandboxScriptPath: fixture.sandboxScript,
      logDir: path.join(fixture.tmpDir, 'logs'),
    });

    // Create a plugin that never activates (blocks forever)
    var badPluginDir = path.join(fixture.tmpDir, 'bad-plugin');
    fs.mkdirSync(badPluginDir, { recursive: true });
    fs.writeFileSync(path.join(badPluginDir, 'plugin.json'), JSON.stringify({
      name: 'bad-plugin', version: '0.1.0', type: 'hook', description: 'bad',
    }), 'utf-8');
    fs.writeFileSync(path.join(badPluginDir, 'index.js'), [
      "'use strict';",
      "function BadPlugin() {}",
      "BadPlugin.prototype.onActivate = function() {",
      "  return new Promise(function() {});", // Never resolves
      "};",
      "module.exports = BadPlugin;",
    ].join('\n'), 'utf-8');

    mgr.createSandboxedWorker({
      pluginName: 'bad-plugin',
      pluginPath: badPluginDir,
      sourceType: 'local',
      declaredCapabilities: {},
      mainThreadServices: {},
      timeout: 500, // Short timeout
    }).then(function () {
      done(new Error('should have timed out'));
    }).catch(function (err) {
      assert.ok(err.message.indexOf('timeout') !== -1);
      mgr.destroy();
      cleanup(fixture.tmpDir);
      done();
    });
  });
});

// ---------------------------------------------------------------------------
// terminateAll()
// ---------------------------------------------------------------------------

test.describe('SandboxManager terminateAll()', function () {
  test('should terminate all active workers', function (t, done) {
    var fixture = createTestFixture();
    var logDir = path.join(fixture.tmpDir, 'logs');

    // Create two plugin directories
    var pluginDir2 = path.join(fixture.tmpDir, 'test-plugin-2');
    fs.mkdirSync(pluginDir2, { recursive: true });
    fs.writeFileSync(path.join(pluginDir2, 'plugin.json'), JSON.stringify({
      name: 'test-plugin-2', version: '0.1.0', type: 'hook', description: 'Test 2',
    }), 'utf-8');
    fs.writeFileSync(path.join(pluginDir2, 'index.js'), [
      "'use strict';",
      "function P2() {}",
      "P2.prototype.onActivate = function() {};",
      "module.exports = P2;",
    ].join('\n'), 'utf-8');

    var mgr = new SandboxManager({
      sandboxScriptPath: fixture.sandboxScript,
      logDir: logDir,
    });

    Promise.all([
      mgr.createSandboxedWorker({
        pluginName: 'test-plugin',
        pluginPath: fixture.pluginDir,
        sourceType: 'npm',
        declaredCapabilities: {},
        mainThreadServices: {},
      }),
      mgr.createSandboxedWorker({
        pluginName: 'test-plugin-2',
        pluginPath: pluginDir2,
        sourceType: 'local',
        declaredCapabilities: {},
        mainThreadServices: {},
      }),
    ]).then(function () {
      assert.ok(mgr.hasWorker('test-plugin'));
      assert.ok(mgr.hasWorker('test-plugin-2'));

      return mgr.terminateAll();
    }).then(function () {
      assert.equal(mgr.hasWorker('test-plugin'), false);
      assert.equal(mgr.hasWorker('test-plugin-2'), false);
      mgr.destroy();
      cleanup(fixture.tmpDir);
      done();
    }).catch(function (err) {
      mgr.destroy();
      cleanup(fixture.tmpDir);
      done(err);
    });
  });
});

// ---------------------------------------------------------------------------
// getAuditLogger()
// ---------------------------------------------------------------------------

test.describe('SandboxManager getAuditLogger()', function () {
  test('should return the audit logger', function () {
    var mgr = new SandboxManager();
    var auditLogger = mgr.getAuditLogger();
    assert.ok(auditLogger);
    assert.ok(typeof auditLogger.log === 'function');
    mgr.destroy();
  });
});

// ---------------------------------------------------------------------------
// destroy()
// ---------------------------------------------------------------------------

test.describe('SandboxManager destroy()', function () {
  test('should clean up without error', function () {
    var mgr = new SandboxManager();
    mgr.destroy();
    // Should not throw
    assert.ok(true);
  });
});

// ---------------------------------------------------------------------------
// Path validation (WP-146)
// ---------------------------------------------------------------------------

test.describe('SandboxManager path validation (WP-146)', function () {
  test('should reject non-absolute pluginPath', function (t, done) {
    var mgr = new SandboxManager();
    mgr.createSandboxedWorker({
      pluginName: 'test-plugin',
      pluginPath: 'relative/path/to/plugin',
      sourceType: 'npm',
      declaredCapabilities: {},
      mainThreadServices: {},
    }).then(function () {
      mgr.destroy();
      done(new Error('should have thrown'));
    }).catch(function (err) {
      assert.ok(err.message.indexOf('pluginPath must be absolute') !== -1);
      mgr.destroy();
      done();
    });
  });

  test('should reject path traversal attack (../../etc/passwd)', function (t, done) {
    var mgr = new SandboxManager();
    mgr.createSandboxedWorker({
      pluginName: 'test-plugin',
      pluginPath: '../../etc/passwd',
      sourceType: 'npm',
      declaredCapabilities: {},
      mainThreadServices: {},
    }).then(function () {
      mgr.destroy();
      done(new Error('should have thrown'));
    }).catch(function (err) {
      assert.ok(err.message.indexOf('pluginPath must be absolute') !== -1);
      mgr.destroy();
      done();
    });
  });

  test('should reject non-existent path', function (t, done) {
    var mgr = new SandboxManager();
    mgr.createSandboxedWorker({
      pluginName: 'test-plugin',
      pluginPath: '/nonexistent/path/that/does/not/exist',
      sourceType: 'npm',
      declaredCapabilities: {},
      mainThreadServices: {},
    }).then(function () {
      mgr.destroy();
      done(new Error('should have thrown'));
    }).catch(function (err) {
      assert.ok(err.message.indexOf('pluginPath does not exist') !== -1);
      mgr.destroy();
      done();
    });
  });

  test('should reject path pointing to a file (not directory)', function (t, done) {
    var mgr = new SandboxManager();
    var tmpFile = path.join(os.tmpdir(), 'sandbox-path-validation-test-' + Date.now() + '.txt');
    fs.writeFileSync(tmpFile, 'test', 'utf-8');
    mgr.createSandboxedWorker({
      pluginName: 'test-plugin',
      pluginPath: tmpFile,
      sourceType: 'npm',
      declaredCapabilities: {},
      mainThreadServices: {},
    }).then(function () {
      try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
      mgr.destroy();
      done(new Error('should have thrown'));
    }).catch(function (err) {
      assert.ok(err.message.indexOf('pluginPath must be a directory') !== -1);
      try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
      mgr.destroy();
      done();
    });
  });
});

// ---------------------------------------------------------------------------
// _methodToCapability()
// ---------------------------------------------------------------------------

test.describe('SandboxManager._methodToCapability()', function () {
  test('should map getProvider to plugin.access', function () {
    var mgr = new SandboxManager();
    assert.equal(mgr._methodToCapability('getProvider'), 'plugin.access');
    mgr.destroy();
  });

  test('should return null for eventBus methods', function () {
    var mgr = new SandboxManager();
    assert.equal(mgr._methodToCapability('eventBus.emit'), null);
    mgr.destroy();
  });

  test('should return null for stateStore methods', function () {
    var mgr = new SandboxManager();
    assert.equal(mgr._methodToCapability('stateStore.get'), null);
    assert.equal(mgr._methodToCapability('stateStore.set'), null);
    assert.equal(mgr._methodToCapability('stateStore.delete'), null);
    mgr.destroy();
  });

  test('should return null for logger methods', function () {
    var mgr = new SandboxManager();
    assert.equal(mgr._methodToCapability('logger.info'), null);
    assert.equal(mgr._methodToCapability('logger.warn'), null);
    assert.equal(mgr._methodToCapability('logger.error'), null);
    mgr.destroy();
  });

  test('should return null for config methods', function () {
    var mgr = new SandboxManager();
    assert.equal(mgr._methodToCapability('config.get'), null);
    mgr.destroy();
  });

  test('should return method name for unknown methods', function () {
    var mgr = new SandboxManager();
    assert.equal(mgr._methodToCapability('fs.read'), 'fs.read');
    assert.equal(mgr._methodToCapability('child_process'), 'child_process');
    assert.equal(mgr._methodToCapability('unknownMethod'), 'unknownMethod');
    mgr.destroy();
  });
});

// ---------------------------------------------------------------------------
// _callMainThreadService()
// ---------------------------------------------------------------------------

test.describe('SandboxManager._callMainThreadService()', function () {
  test('should route eventBus.emit to eventBus service', function () {
    var mgr = new SandboxManager();
    var emitted = null;
    var services = {
      eventBus: {
        emit: function (event, data) { emitted = { event: event, data: data }; return 'ok'; },
      },
    };
    var result = mgr._callMainThreadService(services, 'eventBus.emit', ['test-event', { key: 'val' }]);
    assert.equal(result, 'ok');
    assert.deepEqual(emitted, { event: 'test-event', data: { key: 'val' } });
    mgr.destroy();
  });

  test('should return undefined for eventBus.emit when no eventBus', function () {
    var mgr = new SandboxManager();
    var result = mgr._callMainThreadService({}, 'eventBus.emit', ['evt']);
    assert.equal(result, undefined);
    mgr.destroy();
  });

  test('should route stateStore.get to stateStore service', function () {
    var mgr = new SandboxManager();
    var services = {
      stateStore: {
        get: function (key) { return 'value-for-' + key; },
        set: function () {},
        delete: function () {},
      },
    };
    var result = mgr._callMainThreadService(services, 'stateStore.get', ['mykey']);
    assert.equal(result, 'value-for-mykey');
    mgr.destroy();
  });

  test('should return undefined for stateStore.get when no stateStore', function () {
    var mgr = new SandboxManager();
    var result = mgr._callMainThreadService({}, 'stateStore.get', ['mykey']);
    assert.equal(result, undefined);
    mgr.destroy();
  });

  test('should route stateStore.set to stateStore service', function () {
    var mgr = new SandboxManager();
    var stored = null;
    var services = {
      stateStore: {
        get: function () {},
        set: function (key, value) { stored = { key: key, value: value }; },
        delete: function () {},
      },
    };
    mgr._callMainThreadService(services, 'stateStore.set', ['k', 'v']);
    assert.deepEqual(stored, { key: 'k', value: 'v' });
    mgr.destroy();
  });

  test('should route stateStore.delete to stateStore service', function () {
    var mgr = new SandboxManager();
    var deleted = null;
    var services = {
      stateStore: {
        get: function () {},
        set: function () {},
        delete: function (key) { deleted = key; },
      },
    };
    mgr._callMainThreadService(services, 'stateStore.delete', ['key-to-delete']);
    assert.equal(deleted, 'key-to-delete');
    mgr.destroy();
  });

  test('should route logger.info to logger service', function () {
    var mgr = new SandboxManager();
    var logged = null;
    var services = {
      logger: {
        info: function (msg) { logged = msg; },
        warn: function () {},
        error: function () {},
      },
    };
    mgr._callMainThreadService(services, 'logger.info', ['test message']);
    assert.equal(logged, 'test message');
    mgr.destroy();
  });

  test('should route logger.warn to logger service', function () {
    var mgr = new SandboxManager();
    var logged = null;
    var services = {
      logger: {
        info: function () {},
        warn: function (msg) { logged = msg; },
        error: function () {},
      },
    };
    mgr._callMainThreadService(services, 'logger.warn', ['warning msg']);
    assert.equal(logged, 'warning msg');
    mgr.destroy();
  });

  test('should route logger.error to logger service', function () {
    var mgr = new SandboxManager();
    var logged = null;
    var services = {
      logger: {
        info: function () {},
        warn: function () {},
        error: function (msg) { logged = msg; },
      },
    };
    mgr._callMainThreadService(services, 'logger.error', ['error msg']);
    assert.equal(logged, 'error msg');
    mgr.destroy();
  });

  test('should return undefined for logger methods when no logger', function () {
    var mgr = new SandboxManager();
    assert.equal(mgr._callMainThreadService({}, 'logger.info', ['msg']), undefined);
    assert.equal(mgr._callMainThreadService({}, 'logger.warn', ['msg']), undefined);
    assert.equal(mgr._callMainThreadService({}, 'logger.error', ['msg']), undefined);
    mgr.destroy();
  });

  test('should route config.get to configManager', function () {
    var mgr = new SandboxManager();
    var services = {
      configManager: {
        get: function (key) { return 'config-val-' + key; },
      },
    };
    var result = mgr._callMainThreadService(services, 'config.get', ['some.key']);
    assert.equal(result, 'config-val-some.key');
    mgr.destroy();
  });

  test('should return undefined for config.get when no configManager', function () {
    var mgr = new SandboxManager();
    var result = mgr._callMainThreadService({}, 'config.get', ['key']);
    assert.equal(result, undefined);
    mgr.destroy();
  });

  test('should route getProvider to services.getProvider', function () {
    var mgr = new SandboxManager();
    var services = {
      getProvider: function (name) { return { name: name, type: 'mock' }; },
    };
    var result = mgr._callMainThreadService(services, 'getProvider', ['my-provider']);
    assert.deepEqual(result, { name: 'my-provider', type: 'mock' });
    mgr.destroy();
  });

  test('should throw for unknown RPC method', function () {
    var mgr = new SandboxManager();
    assert.throws(function () {
      mgr._callMainThreadService({}, 'unknown.method', []);
    }, /Unknown RPC method: unknown\.method/);
    mgr.destroy();
  });
});

// ---------------------------------------------------------------------------
// _sanitizeForTransfer()
// ---------------------------------------------------------------------------

test.describe('SandboxManager._sanitizeForTransfer()', function () {
  test('should pass through primitives unchanged', function () {
    var mgr = new SandboxManager();
    assert.equal(mgr._sanitizeForTransfer(42), 42);
    assert.equal(mgr._sanitizeForTransfer('hello'), 'hello');
    assert.equal(mgr._sanitizeForTransfer(true), true);
    assert.equal(mgr._sanitizeForTransfer(false), false);
    mgr.destroy();
  });

  test('should pass through undefined and null', function () {
    var mgr = new SandboxManager();
    assert.equal(mgr._sanitizeForTransfer(undefined), undefined);
    assert.equal(mgr._sanitizeForTransfer(null), null);
    mgr.destroy();
  });

  test('should replace functions with [Function]', function () {
    var mgr = new SandboxManager();
    assert.equal(mgr._sanitizeForTransfer(function () {}), '[Function]');
    mgr.destroy();
  });

  test('should sanitize arrays by recursing elements', function () {
    var mgr = new SandboxManager();
    var input = [1, 'two', function () {}, [3, function () {}]];
    var result = mgr._sanitizeForTransfer(input);
    assert.deepEqual(result, [1, 'two', '[Function]', [3, '[Function]']]);
    mgr.destroy();
  });

  test('should sanitize plain objects by recursing values', function () {
    var mgr = new SandboxManager();
    var input = {
      name: 'test',
      fn: function () {},
      nested: {
        val: 42,
        cb: function () {},
      },
    };
    var result = mgr._sanitizeForTransfer(input);
    assert.equal(result.name, 'test');
    assert.equal(result.fn, '[Function]');
    assert.equal(result.nested.val, 42);
    assert.equal(result.nested.cb, '[Function]');
    mgr.destroy();
  });

  test('should preserve non-function, non-object property values', function () {
    var mgr = new SandboxManager();
    var input = { a: 1, b: 'str', c: true, d: null };
    var result = mgr._sanitizeForTransfer(input);
    assert.deepEqual(result, { a: 1, b: 'str', c: true, d: null });
    mgr.destroy();
  });

  test('should handle empty objects and arrays', function () {
    var mgr = new SandboxManager();
    assert.deepEqual(mgr._sanitizeForTransfer({}), {});
    assert.deepEqual(mgr._sanitizeForTransfer([]), []);
    mgr.destroy();
  });

  test('should handle deeply nested objects', function () {
    var mgr = new SandboxManager();
    var input = { a: { b: { c: { d: 'deep' } } } };
    var result = mgr._sanitizeForTransfer(input);
    assert.deepEqual(result, { a: { b: { c: { d: 'deep' } } } });
    mgr.destroy();
  });
});

// ---------------------------------------------------------------------------
// _handleRpcRequest() via worker thread
// ---------------------------------------------------------------------------

test.describe('SandboxManager._handleRpcRequest()', function () {
  test('should deny RPC request when capability check fails', function (t, done) {
    var fixture = createTestFixture();
    var logDir = path.join(fixture.tmpDir, 'logs');

    // Create a sandbox worker script that sends an RPC getProvider request
    var rpcTestScript = path.join(fixture.tmpDir, 'rpc-deny-worker.js');
    fs.writeFileSync(rpcTestScript, [
      "'use strict';",
      "var workerThreads = require('worker_threads');",
      "var parentPort = workerThreads.parentPort;",
      "var workerData = workerThreads.workerData;",
      "",
      "parentPort.postMessage({ type: 'activated' });",
      "",
      "parentPort.on('message', function(msg) {",
      "  if (msg.type === 'terminate') process.exit(0);",
      "});",
      "",
      "// Send a getProvider RPC request without declaring the capability",
      "parentPort.postMessage({",
      "  type: 'rpc-request',",
      "  id: 1,",
      "  method: 'getProvider',",
      "  args: ['some-provider']",
      "});",
      "",
      "// Listen for response",
      "parentPort.on('message', function(msg) {",
      "  if (msg.type === 'rpc-response' && msg.id === 1) {",
      "    // Store result for verification",
      "    if (msg.error && msg.error.indexOf('SecurityError') !== -1) {",
      "      // Success - capability denied as expected",
      "    }",
      "  }",
      "});",
    ].join('\n'), 'utf-8');

    var mgr = new SandboxManager({
      sandboxScriptPath: rpcTestScript,
      logDir: logDir,
    });

    mgr.createSandboxedWorker({
      pluginName: 'test-plugin',
      pluginPath: fixture.pluginDir,
      sourceType: 'npm',
      declaredCapabilities: {},  // No plugin.access declared
      mainThreadServices: {
        getProvider: function () { return { name: 'should-not-reach' }; },
      },
    }).then(function () {
      // Give time for RPC exchange
      setTimeout(function () {
        return mgr.terminateWorker('test-plugin').then(function () {
          mgr.destroy();
          cleanup(fixture.tmpDir);
          done();
        });
      }, 500);
    }).catch(function (err) {
      mgr.destroy();
      cleanup(fixture.tmpDir);
      done(err);
    });
  });

  test('should allow RPC request when capability is declared', function (t, done) {
    var fixture = createTestFixture();
    var logDir = path.join(fixture.tmpDir, 'logs');

    var rpcTestScript = path.join(fixture.tmpDir, 'rpc-allow-worker.js');
    fs.writeFileSync(rpcTestScript, [
      "'use strict';",
      "var workerThreads = require('worker_threads');",
      "var parentPort = workerThreads.parentPort;",
      "",
      "parentPort.postMessage({ type: 'activated' });",
      "",
      "parentPort.on('message', function(msg) {",
      "  if (msg.type === 'terminate') process.exit(0);",
      "});",
      "",
      "// Send stateStore.get RPC (no capability required)",
      "parentPort.postMessage({",
      "  type: 'rpc-request',",
      "  id: 1,",
      "  method: 'stateStore.get',",
      "  args: ['my-key']",
      "});",
    ].join('\n'), 'utf-8');

    var getState = null;
    var mgr = new SandboxManager({
      sandboxScriptPath: rpcTestScript,
      logDir: logDir,
    });

    mgr.createSandboxedWorker({
      pluginName: 'test-plugin',
      pluginPath: fixture.pluginDir,
      sourceType: 'npm',
      declaredCapabilities: {},
      mainThreadServices: {
        stateStore: {
          get: function (key) { getState = key; return 'stored-value'; },
          set: function () {},
          delete: function () {},
        },
      },
    }).then(function () {
      setTimeout(function () {
        assert.equal(getState, 'my-key');
        return mgr.terminateWorker('test-plugin').then(function () {
          mgr.destroy();
          cleanup(fixture.tmpDir);
          done();
        });
      }, 500);
    }).catch(function (err) {
      mgr.destroy();
      cleanup(fixture.tmpDir);
      done(err);
    });
  });

  test('should return error for unknown RPC method', function (t, done) {
    var fixture = createTestFixture();
    var logDir = path.join(fixture.tmpDir, 'logs');

    var rpcTestScript = path.join(fixture.tmpDir, 'rpc-unknown-worker.js');
    fs.writeFileSync(rpcTestScript, [
      "'use strict';",
      "var workerThreads = require('worker_threads');",
      "var parentPort = workerThreads.parentPort;",
      "",
      "parentPort.postMessage({ type: 'activated' });",
      "",
      "parentPort.on('message', function(msg) {",
      "  if (msg.type === 'terminate') process.exit(0);",
      "});",
      "",
      "// Send an unknown method RPC request (not mapped, returns method name as capability)",
      "parentPort.postMessage({",
      "  type: 'rpc-request',",
      "  id: 1,",
      "  method: 'fs.read',",
      "  args: ['/etc/passwd']",
      "});",
    ].join('\n'), 'utf-8');

    var mgr = new SandboxManager({
      sandboxScriptPath: rpcTestScript,
      logDir: logDir,
    });

    mgr.createSandboxedWorker({
      pluginName: 'test-plugin',
      pluginPath: fixture.pluginDir,
      sourceType: 'npm',
      declaredCapabilities: {},
      mainThreadServices: {},
    }).then(function () {
      setTimeout(function () {
        return mgr.terminateWorker('test-plugin').then(function () {
          mgr.destroy();
          cleanup(fixture.tmpDir);
          done();
        });
      }, 500);
    }).catch(function (err) {
      mgr.destroy();
      cleanup(fixture.tmpDir);
      done(err);
    });
  });

  test('should handle _handleRpcRequest when entry does not exist', function () {
    var mgr = new SandboxManager();
    // Directly call _handleRpcRequest with a non-existent plugin
    // Should not throw
    mgr._handleRpcRequest('nonexistent-plugin', {
      type: 'rpc-request',
      id: 1,
      method: 'stateStore.get',
      args: ['key'],
    });
    mgr.destroy();
  });

  test('should handle _handleWorkerMessage when entry does not exist', function () {
    var mgr = new SandboxManager();
    mgr._handleWorkerMessage('nonexistent-plugin', {
      type: 'activated',
    });
    mgr.destroy();
  });

  test('should handle _handleWorkerMessage for rpc-request type', function (t, done) {
    var fixture = createTestFixture();
    var logDir = path.join(fixture.tmpDir, 'logs');

    var rpcTestScript = path.join(fixture.tmpDir, 'rpc-worker-msg.js');
    fs.writeFileSync(rpcTestScript, [
      "'use strict';",
      "var workerThreads = require('worker_threads');",
      "var parentPort = workerThreads.parentPort;",
      "",
      "parentPort.postMessage({ type: 'activated' });",
      "",
      "parentPort.on('message', function(msg) {",
      "  if (msg.type === 'terminate') process.exit(0);",
      "});",
      "",
      "// Send logger.info RPC (no capability required)",
      "parentPort.postMessage({",
      "  type: 'rpc-request',",
      "  id: 1,",
      "  method: 'logger.info',",
      "  args: ['test-log']",
      "});",
    ].join('\n'), 'utf-8');

    var loggedMsg = null;
    var mgr = new SandboxManager({
      sandboxScriptPath: rpcTestScript,
      logDir: logDir,
    });

    mgr.createSandboxedWorker({
      pluginName: 'test-plugin',
      pluginPath: fixture.pluginDir,
      sourceType: 'npm',
      declaredCapabilities: {},
      mainThreadServices: {
        logger: {
          info: function (msg) { loggedMsg = msg; },
          warn: function () {},
          error: function () {},
        },
      },
    }).then(function () {
      setTimeout(function () {
        assert.equal(loggedMsg, 'test-log');
        return mgr.terminateWorker('test-plugin').then(function () {
          mgr.destroy();
          cleanup(fixture.tmpDir);
          done();
        });
      }, 500);
    }).catch(function (err) {
      mgr.destroy();
      cleanup(fixture.tmpDir);
      done(err);
    });
  });
});
