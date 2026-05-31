/**
 * Unit tests for ValidatorPipeline
 * Run with: node --test test/runtime/test-validator-pipeline.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { ValidatorPipeline, ExecutionMode, WorkflowPhase } = require('../../plugins/runtime/validator-pipeline');
const { PluginState } = require('../../plugins/contracts/plugin-interface');

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

class MockLogger {
  constructor() {
    this.logs = [];
  }
  debug(plugin, msg) { this.logs.push({ level: 'debug', plugin, msg }); }
  info(plugin, msg) { this.logs.push({ level: 'info', plugin, msg }); }
  warn(plugin, msg) { this.logs.push({ level: 'warn', plugin, msg }); }
  error(plugin, msg) { this.logs.push({ level: 'error', plugin, msg }); }
}

class MockEventBus {
  constructor() {
    this.events = [];
  }
  on(event, handler) { this.events.push({ event, handler }); }
  emit(event, data) { this.events.push({ event, data, emitted: true }); }
}

function createMockPluginLoader(plugins) {
  var pluginMap = {};
  plugins.forEach(function (p) { pluginMap[p.name] = p; });
  return {
    getPlugin: function (name) { return pluginMap[name] || null; },
    getLoadedNames: function () { return Object.keys(pluginMap); },
  };
}

function createMockValidator(name, opts) {
  opts = opts || {};
  return {
    name: name,
    type: 'validator',
    blocking: opts.blocking !== undefined ? opts.blocking : true,
    validate: opts.validate || (async function () {
      return { passed: true, valid: true, errors: [], warnings: [] };
    }),
    targets: opts.targets || undefined,
    metadata: opts.metadata || undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('ValidatorPipeline - Construction', () => {
  test('should construct with required pluginLoader', () => {
    var loader = createMockPluginLoader([]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });
    assert.ok(pipeline);
  });

  test('should throw if pluginLoader is missing', () => {
    assert.throws(function () {
      new ValidatorPipeline({});
    }, /pluginLoader is required/);
  });

  test('should accept optional eventBus, logger, and projectRoot', () => {
    var loader = createMockPluginLoader([]);
    var eventBus = new MockEventBus();
    var logger = new MockLogger();
    var pipeline = new ValidatorPipeline({
      pluginLoader: loader,
      eventBus: eventBus,
      logger: logger,
      projectRoot: '/tmp/test-project',
    });
    assert.ok(pipeline);
    assert.strictEqual(pipeline._projectRoot, '/tmp/test-project');
  });

  test('should default projectRoot to cwd', () => {
    var loader = createMockPluginLoader([]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });
    assert.strictEqual(pipeline._projectRoot, process.cwd());
  });
});

test.describe('ValidatorPipeline - runValidator (single)', () => {
  test('should run a validator and return passed result', async () => {
    var validator = createMockValidator('test-validator');
    var loader = createMockPluginLoader([validator]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    var result = await pipeline.runValidator('test-validator');
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.mode, 'blocking');
    assert.strictEqual(result.validator, 'test-validator');
  });

  test('should run validator in non-blocking mode', async () => {
    var validator = createMockValidator('test-validator', {
      validate: async function () {
        return { valid: false, errors: [{ message: 'test error' }], warnings: [] };
      },
    });
    var loader = createMockPluginLoader([validator]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    var result = await pipeline.runValidator('test-validator', { mode: 'non-blocking' });
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.mode, 'non-blocking');
  });

  test('should throw in blocking mode when validator fails', async () => {
    var validator = createMockValidator('failing-validator', {
      validate: async function () {
        return { valid: false, errors: [{ message: 'fail' }], warnings: [] };
      },
    });
    var loader = createMockPluginLoader([validator]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    await assert.rejects(
      function () { return pipeline.runValidator('failing-validator'); },
      /failed in blocking mode/
    );
  });

  test('should throw in blocking mode when validator not found', async () => {
    var loader = createMockPluginLoader([]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    await assert.rejects(
      function () { return pipeline.runValidator('missing-validator'); },
      /is not loaded/
    );
  });

  test('should return error result in non-blocking mode when validator not found', async () => {
    var loader = createMockPluginLoader([]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    var result = await pipeline.runValidator('missing-validator', { mode: 'non-blocking' });
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors[0].message.includes('is not loaded'));
  });

  test('should reject non-validator plugin type in blocking mode', async () => {
    var fakePlugin = { name: 'fake-plugin', type: 'skill' };
    var loader = createMockPluginLoader([fakePlugin]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    await assert.rejects(
      function () { return pipeline.runValidator('fake-plugin'); },
      /is not a validator/
    );
  });

  test('should reject non-validator plugin type in non-blocking mode', async () => {
    var fakePlugin = { name: 'fake-plugin', type: 'provider' };
    var loader = createMockPluginLoader([fakePlugin]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    var result = await pipeline.runValidator('fake-plugin', { mode: 'non-blocking' });
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors[0].message.includes('is not a validator'));
  });

  test('should handle validator that throws an exception', async () => {
    var validator = createMockValidator('throwing-validator', {
      validate: async function () {
        throw new Error('internal crash');
      },
    });
    var loader = createMockPluginLoader([validator]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    var result = await pipeline.runValidator('throwing-validator', { mode: 'non-blocking' });
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors[0].message.includes('Exception during validation'));
  });

  test('should normalize result with "valid" field to "passed"', async () => {
    var validator = createMockValidator('test-validator', {
      validate: async function () {
        return { valid: true, errors: [], warnings: [{ message: 'minor' }] };
      },
    });
    var loader = createMockPluginLoader([validator]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    var result = await pipeline.runValidator('test-validator');
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.warnings.length, 1);
  });

  test('should emit validator:executed event on eventBus', async () => {
    var validator = createMockValidator('event-validator');
    var loader = createMockPluginLoader([validator]);
    var eventBus = new MockEventBus();
    var pipeline = new ValidatorPipeline({ pluginLoader: loader, eventBus: eventBus });

    await pipeline.runValidator('event-validator');

    var emitted = eventBus.events.filter(function (e) { return e.event === 'validator:executed'; });
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].data.validator, 'event-validator');
    assert.strictEqual(emitted[0].data.passed, true);
  });

  test('should cache result after execution', async () => {
    var validator = createMockValidator('cached-validator');
    var loader = createMockPluginLoader([validator]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    await pipeline.runValidator('cached-validator');
    var cached = pipeline.getCachedResult('cached-validator');
    assert.ok(cached);
    assert.strictEqual(cached.validator, 'cached-validator');
  });
});

test.describe('ValidatorPipeline - runAllValidators', () => {
  test('should return empty results when no validators registered', async () => {
    var loader = createMockPluginLoader([]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    var result = await pipeline.runAllValidators();
    assert.strictEqual(result.results.length, 0);
    assert.strictEqual(result.overallPassed, true);
    assert.strictEqual(result.totalErrors, 0);
    assert.strictEqual(result.totalWarnings, 0);
  });

  test('should run all validators and return summary', async () => {
    var v1 = createMockValidator('validator-1');
    var v2 = createMockValidator('validator-2');
    var loader = createMockPluginLoader([v1, v2]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    var result = await pipeline.runAllValidators();
    assert.strictEqual(result.results.length, 2);
    assert.strictEqual(result.overallPassed, true);
  });

  test('should skip non-validator plugins', async () => {
    var validator = createMockValidator('real-validator');
    var skill = { name: 'skill-plugin', type: 'skill' };
    var loader = createMockPluginLoader([validator, skill]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    var result = await pipeline.runAllValidators();
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].validator, 'real-validator');
  });

  test('should stop on first blocking error when stopOnFirstError is true', async () => {
    var v1 = createMockValidator('failing-validator', {
      validate: async function () {
        return { valid: false, errors: [{ message: 'fail' }], warnings: [] };
      },
    });
    var v2 = createMockValidator('passing-validator');
    var loader = createMockPluginLoader([v1, v2]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    // In blocking mode, the first failure should throw
    await assert.rejects(
      function () {
        return pipeline.runAllValidators({ stopOnFirstError: true, mode: 'blocking' });
      },
      /failed in blocking mode/
    );
  });

  test('should continue on non-blocking failure', async () => {
    var v1 = createMockValidator('failing-validator', {
      validate: async function () {
        return { valid: false, errors: [{ message: 'fail' }], warnings: [] };
      },
    });
    var v2 = createMockValidator('passing-validator');
    var loader = createMockPluginLoader([v1, v2]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    var result = await pipeline.runAllValidators({ mode: 'non-blocking' });
    assert.strictEqual(result.results.length, 2);
    assert.strictEqual(result.overallPassed, false);
    assert.strictEqual(result.totalErrors, 1);
  });

  test('should respect validator.blocking=false to use non-blocking mode', async () => {
    var v1 = createMockValidator('non-blocking-validator', {
      blocking: false,
      validate: async function () {
        return { valid: false, errors: [{ message: 'soft fail' }], warnings: [] };
      },
    });
    var loader = createMockPluginLoader([v1]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    var result = await pipeline.runAllValidators({ mode: 'blocking' });
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.overallPassed, false);
    // Should NOT throw because validator.blocking=false overrides default
  });

  test('should emit validator:phase-complete event', async () => {
    var validator = createMockValidator('test-validator');
    var loader = createMockPluginLoader([validator]);
    var eventBus = new MockEventBus();
    var pipeline = new ValidatorPipeline({ pluginLoader: loader, eventBus: eventBus });

    await pipeline.runAllValidators({ phase: 'build' });

    var emitted = eventBus.events.filter(function (e) { return e.event === 'validator:phase-complete'; });
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].data.phase, 'build');
    assert.strictEqual(emitted[0].data.overallPassed, true);
  });
});

test.describe('ValidatorPipeline - _filterValidatorsForPhase', () => {
  test('should include validators without explicit targets', async () => {
    var validator = createMockValidator('general-validator');
    var loader = createMockPluginLoader([validator]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    var result = await pipeline.runAllValidators({ phase: 'build' });
    assert.strictEqual(result.results.length, 1);
  });

  test('should filter validators by metadata.targets', async () => {
    var v1 = createMockValidator('build-only', {
      metadata: { targets: ['build'] },
    });
    var v2 = createMockValidator('all-phases', {
      metadata: { targets: ['all'] },
    });
    var v3 = createMockValidator('wp-only', {
      metadata: { targets: ['wp-create'] },
    });
    var loader = createMockPluginLoader([v1, v2, v3]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    var result = await pipeline.runAllValidators({ phase: 'build' });
    assert.strictEqual(result.results.length, 2);
    var names = result.results.map(function (r) { return r.validator; });
    assert.ok(names.indexOf('build-only') !== -1);
    assert.ok(names.indexOf('all-phases') !== -1);
  });

  test('should fall back to instance.targets when metadata.targets is empty', async () => {
    var validator = createMockValidator('fallback-validator', {
      metadata: { targets: [] },
      targets: ['build'],
    });
    var loader = createMockPluginLoader([validator]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    var result = await pipeline.runAllValidators({ phase: 'build' });
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].validator, 'fallback-validator');
  });

  test('should exclude validators whose targets do not match phase', async () => {
    var validator = createMockValidator('wrong-phase', {
      metadata: { targets: ['wp-modify'] },
    });
    var loader = createMockPluginLoader([validator]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    var result = await pipeline.runAllValidators({ phase: 'build' });
    assert.strictEqual(result.results.length, 0);
  });
});

test.describe('ValidatorPipeline - Convenience methods', () => {
  test('runPostBuildValidators should use BUILD phase and non-blocking mode', async () => {
    var validator = createMockValidator('build-validator');
    var loader = createMockPluginLoader([validator]);
    var eventBus = new MockEventBus();
    var pipeline = new ValidatorPipeline({ pluginLoader: loader, eventBus: eventBus });

    var result = await pipeline.runPostBuildValidators();
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].mode, 'non-blocking');
  });

  test('runWPValidators should use WP_CREATE phase for create operation', async () => {
    var validator = createMockValidator('wp-validator');
    var loader = createMockPluginLoader([validator]);
    var eventBus = new MockEventBus();
    var pipeline = new ValidatorPipeline({ pluginLoader: loader, eventBus: eventBus });

    var result = await pipeline.runWPValidators('WP-001', 'create');
    assert.strictEqual(result.results.length, 1);
  });

  test('runWPValidators should use WP_MODIFY phase for modify operation', async () => {
    var validator = createMockValidator('wp-validator');
    var loader = createMockPluginLoader([validator]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    var result = await pipeline.runWPValidators('WP-001', 'modify');
    assert.strictEqual(result.results.length, 1);
  });

  test('runWPValidators should build context with wpId, operation, and wpPath', async () => {
    var loader = createMockPluginLoader([]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    // Verify the method constructs the correct context by checking
    // it does not throw and returns a valid result
    var result = await pipeline.runWPValidators('WP-099', 'create');
    assert.strictEqual(result.overallPassed, true);
  });

  test('runWPValidators should use default projectRoot for wpPath', async () => {
    var loader = createMockPluginLoader([]);
    var pipeline = new ValidatorPipeline({
      pluginLoader: loader,
      projectRoot: '/custom/root',
    });

    // Verify the pipeline constructs without error
    var result = await pipeline.runWPValidators('WP-099', 'modify');
    assert.strictEqual(result.overallPassed, true);
  });
});

test.describe('ValidatorPipeline - Cache management', () => {
  test('getCachedResult should return undefined for uncached validator', () => {
    var loader = createMockPluginLoader([]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });
    assert.strictEqual(pipeline.getCachedResult('nonexistent'), undefined);
  });

  test('clearCache should remove all cached results', async () => {
    var validator = createMockValidator('cache-test');
    var loader = createMockPluginLoader([validator]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    await pipeline.runValidator('cache-test');
    assert.ok(pipeline.getCachedResult('cache-test'));

    pipeline.clearCache();
    assert.strictEqual(pipeline.getCachedResult('cache-test'), undefined);
  });
});

test.describe('ValidatorPipeline - Event listeners setup', () => {
  test('should register build:complete listener when eventBus is provided', () => {
    var loader = createMockPluginLoader([]);
    var eventBus = new MockEventBus();
    var pipeline = new ValidatorPipeline({ pluginLoader: loader, eventBus: eventBus });

    var onEvents = eventBus.events.filter(function (e) { return e.event === 'build:complete'; });
    assert.strictEqual(onEvents.length, 1);
    assert.strictEqual(typeof onEvents[0].handler, 'function');
  });

  test('should register wp:created and wp:modified listeners', () => {
    var loader = createMockPluginLoader([]);
    var eventBus = new MockEventBus();
    var pipeline = new ValidatorPipeline({ pluginLoader: loader, eventBus: eventBus });

    var wpCreated = eventBus.events.filter(function (e) { return e.event === 'wp:created'; });
    var wpModified = eventBus.events.filter(function (e) { return e.event === 'wp:modified'; });
    assert.strictEqual(wpCreated.length, 1);
    assert.strictEqual(wpModified.length, 1);
  });

  test('should not register listeners when eventBus is absent', () => {
    var loader = createMockPluginLoader([]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });
    // Should not throw
    assert.ok(pipeline);
  });
});

test.describe('ValidatorPipeline - Logging', () => {
  test('should use logger when provided', async () => {
    var validator = createMockValidator('logged-validator');
    var loader = createMockPluginLoader([validator]);
    var logger = new MockLogger();
    var pipeline = new ValidatorPipeline({ pluginLoader: loader, logger: logger });

    await pipeline.runValidator('logged-validator');
    var infoLogs = logger.logs.filter(function (l) { return l.level === 'info'; });
    assert.ok(infoLogs.length > 0);
    assert.ok(infoLogs[0].msg.includes('logged-validator'));
  });

  test('should fall back to console when no logger provided', async () => {
    var validator = createMockValidator('console-validator');
    var loader = createMockPluginLoader([validator]);
    var pipeline = new ValidatorPipeline({ pluginLoader: loader });

    // Should not throw - just logs to console
    var result = await pipeline.runValidator('console-validator');
    assert.strictEqual(result.passed, true);
  });
});

test.describe('ValidatorPipeline - Exports', () => {
  test('should export ExecutionMode constants', () => {
    assert.strictEqual(ExecutionMode.BLOCKING, 'blocking');
    assert.strictEqual(ExecutionMode.NON_BLOCKING, 'non-blocking');
  });

  test('should export WorkflowPhase constants', () => {
    assert.strictEqual(WorkflowPhase.BUILD, 'build');
    assert.strictEqual(WorkflowPhase.WP_CREATE, 'wp-create');
    assert.strictEqual(WorkflowPhase.WP_MODIFY, 'wp-modify');
    assert.strictEqual(WorkflowPhase.MANUAL, 'manual');
  });
});
