/**
 * Unit tests for HookDispatcher
 * Run with: node --test test/runtime/test-hook-dispatcher.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { HookDispatcher, ExecutionMode } = require('../../plugins/runtime/hook-dispatcher');
const { PluginType, PluginState } = require('../../plugins/contracts/plugin-interface');

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

function createMockHook(name, opts) {
  opts = opts || {};
  return {
    name: name,
    type: PluginType.HOOK,
    state: opts.state || PluginState.ACTIVATED,
    priority: opts.priority !== undefined ? opts.priority : 100,
    trigger: {
      event: opts.event || 'PreToolUse',
      tools: opts.tools || [],
      skills: opts.skills || [],
    },
    handle: opts.handle || (async function () {
      return { allowed: true };
    }),
  };
}

function createMockPluginLoader(plugins) {
  var pluginMap = {};
  plugins.forEach(function (p) { pluginMap[p.name] = p; });
  return {
    getPlugin: function (name) { return pluginMap[name] || null; },
    getLoadedNames: function () { return Object.keys(pluginMap); },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('HookDispatcher - Construction', () => {
  test('should construct with default options', () => {
    var dispatcher = new HookDispatcher();
    assert.ok(dispatcher);
    assert.strictEqual(dispatcher.getMode(), 'external');
  });

  test('should construct with pluginLoader and logger', () => {
    var loader = createMockPluginLoader([]);
    var logger = new MockLogger();
    var dispatcher = new HookDispatcher({ pluginLoader: loader, logger: logger });
    assert.ok(dispatcher);
    assert.strictEqual(dispatcher.canUseInternalMode(), true);
  });

  test('should construct with custom mode', () => {
    var dispatcher = new HookDispatcher({ mode: 'internal' });
    assert.strictEqual(dispatcher.getMode(), 'internal');
  });

  test('should construct with custom priorityThreshold', () => {
    var dispatcher = new HookDispatcher({ priorityThreshold: 500 });
    assert.strictEqual(dispatcher._priorityThreshold, 500);
  });
});

test.describe('HookDispatcher - dispatch (external mode)', () => {
  test('should return allowed in external mode', async () => {
    var dispatcher = new HookDispatcher();
    var result = await dispatcher.dispatch({ event: 'PreToolUse', tool: 'Edit' });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.mode, 'external');
    assert.deepStrictEqual(result.results, []);
  });

  test('should return allowed for null context', async () => {
    var dispatcher = new HookDispatcher();
    var result = await dispatcher.dispatch(null);
    assert.strictEqual(result.allowed, true);
  });

  test('should return allowed for context without event', async () => {
    var dispatcher = new HookDispatcher();
    var result = await dispatcher.dispatch({});
    assert.strictEqual(result.allowed, true);
  });

  test('should use context.mode override over default mode', async () => {
    var loader = createMockPluginLoader([]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader, mode: 'external' });
    var result = await dispatcher.dispatch({ event: 'PreToolUse', mode: 'internal' });
    // Internal mode with no hooks should return allowed with empty results
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.mode, 'internal');
  });
});

test.describe('HookDispatcher - dispatch (internal mode)', () => {
  test('should return allowed when no pluginLoader in internal mode', async () => {
    var dispatcher = new HookDispatcher({ mode: 'internal' });
    var result = await dispatcher.dispatch({ event: 'PreToolUse' });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.mode, 'internal');
  });

  test('should return allowed when no matching hooks found', async () => {
    var loader = createMockPluginLoader([]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader, mode: 'internal' });
    var result = await dispatcher.dispatch({ event: 'PreToolUse' });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.results.length, 0);
  });

  test('should dispatch to matching hook and return result', async () => {
    var hook = createMockHook('test-hook', { event: 'PreToolUse' });
    var loader = createMockPluginLoader([hook]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader, mode: 'internal' });

    var result = await dispatcher.dispatch({ event: 'PreToolUse', tool: 'Edit' });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].hook, 'test-hook');
  });

  test('should block when hook returns allowed=false', async () => {
    var hook = createMockHook('blocking-hook', {
      event: 'PreToolUse',
      handle: async function () {
        return { allowed: false, reason: 'not permitted' };
      },
    });
    var loader = createMockPluginLoader([hook]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader, mode: 'internal' });

    var result = await dispatcher.dispatch({ event: 'PreToolUse', tool: 'Edit' });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, 'not permitted');
  });

  test('should use default reason when hook disallows without reason', async () => {
    var hook = createMockHook('no-reason-hook', {
      event: 'PreToolUse',
      handle: async function () {
        return { allowed: false };
      },
    });
    var loader = createMockPluginLoader([hook]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader, mode: 'internal' });

    var result = await dispatcher.dispatch({ event: 'PreToolUse', tool: 'Edit' });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('Blocked by hook: no-reason-hook'));
  });

  test('should execute hooks in priority order (lower first)', async () => {
    var executionOrder = [];
    var hook1 = createMockHook('low-priority', {
      event: 'PreToolUse',
      priority: 10,
      handle: async function () {
        executionOrder.push('low');
        return { allowed: true };
      },
    });
    var hook2 = createMockHook('high-priority', {
      event: 'PreToolUse',
      priority: 200,
      handle: async function () {
        executionOrder.push('high');
        return { allowed: true };
      },
    });
    var loader = createMockPluginLoader([hook2, hook1]); // Out of order
    var dispatcher = new HookDispatcher({ pluginLoader: loader, mode: 'internal' });

    await dispatcher.dispatch({ event: 'PreToolUse', tool: 'Edit' });
    assert.deepStrictEqual(executionOrder, ['low', 'high']);
  });

  test('should continue executing hooks after one blocks', async () => {
    var executionOrder = [];
    var hook1 = createMockHook('blocker', {
      event: 'PreToolUse',
      handle: async function () {
        executionOrder.push('blocker');
        return { allowed: false, reason: 'blocked' };
      },
    });
    var hook2 = createMockHook('after-blocker', {
      event: 'PreToolUse',
      priority: 200,
      handle: async function () {
        executionOrder.push('after');
        return { allowed: true };
      },
    });
    var loader = createMockPluginLoader([hook1, hook2]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader, mode: 'internal' });

    var result = await dispatcher.dispatch({ event: 'PreToolUse' });
    assert.strictEqual(result.allowed, false);
    assert.deepStrictEqual(executionOrder, ['blocker', 'after']);
    assert.strictEqual(result.results.length, 2);
  });

  test('should skip inactive hooks', async () => {
    var hook = createMockHook('inactive-hook', {
      event: 'PreToolUse',
      state: PluginState.DEACTIVATED,
    });
    var loader = createMockPluginLoader([hook]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader, mode: 'internal' });

    var result = await dispatcher.dispatch({ event: 'PreToolUse' });
    assert.strictEqual(result.results.length, 0);
    assert.strictEqual(result.allowed, true);
  });

  test('should handle hook that throws error', async () => {
    var hook = createMockHook('error-hook', {
      event: 'PreToolUse',
      handle: async function () {
        throw new Error('hook crashed');
      },
    });
    var loader = createMockPluginLoader([hook]);
    var logger = new MockLogger();
    var dispatcher = new HookDispatcher({ pluginLoader: loader, logger: logger, mode: 'internal' });

    var result = await dispatcher.dispatch({ event: 'PreToolUse' });
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].error, 'hook crashed');
    assert.strictEqual(result.allowed, true); // Error does not block
  });
});

test.describe('HookDispatcher - _findMatchingHooks', () => {
  test('should match hook by event type', async () => {
    var hook = createMockHook('pre-hook', { event: 'PreToolUse' });
    var loader = createMockPluginLoader([hook]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader, mode: 'internal' });

    var result = await dispatcher.dispatch({ event: 'PreToolUse' });
    assert.strictEqual(result.results.length, 1);
  });

  test('should not match hook with different event type', async () => {
    var hook = createMockHook('session-hook', { event: 'SessionStart' });
    var loader = createMockPluginLoader([hook]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader, mode: 'internal' });

    var result = await dispatcher.dispatch({ event: 'PreToolUse' });
    assert.strictEqual(result.results.length, 0);
  });

  test('should match hook by tool filter', async () => {
    var hook = createMockHook('edit-only', {
      event: 'PreToolUse',
      tools: ['Edit', 'Write'],
    });
    var loader = createMockPluginLoader([hook]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader, mode: 'internal' });

    var result = await dispatcher.dispatch({ event: 'PreToolUse', tool: 'Edit' });
    assert.strictEqual(result.results.length, 1);
  });

  test('should not match hook when tool not in filter', async () => {
    var hook = createMockHook('edit-only', {
      event: 'PreToolUse',
      tools: ['Edit'],
    });
    var loader = createMockPluginLoader([hook]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader, mode: 'internal' });

    var result = await dispatcher.dispatch({ event: 'PreToolUse', tool: 'Bash' });
    assert.strictEqual(result.results.length, 0);
  });

  test('should match hook by skill filter', async () => {
    var hook = createMockHook('skill-filtered', {
      event: 'PostToolUse',
      skills: ['skill-task-creator'],
    });
    var loader = createMockPluginLoader([hook]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader, mode: 'internal' });

    var result = await dispatcher.dispatch({ event: 'PostToolUse', skill: 'skill-task-creator' });
    assert.strictEqual(result.results.length, 1);
  });

  test('should not match hook when skill not in filter', async () => {
    var hook = createMockHook('skill-filtered', {
      event: 'PostToolUse',
      skills: ['skill-task-creator'],
    });
    var loader = createMockPluginLoader([hook]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader, mode: 'internal' });

    var result = await dispatcher.dispatch({ event: 'PostToolUse', skill: 'other-skill' });
    assert.strictEqual(result.results.length, 0);
  });

  test('should skip non-hook plugins', async () => {
    var hook = createMockHook('real-hook', { event: 'PreToolUse' });
    var skill = { name: 'skill-plugin', type: PluginType.SKILL };
    var loader = createMockPluginLoader([hook, skill]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader, mode: 'internal' });

    var result = await dispatcher.dispatch({ event: 'PreToolUse' });
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].hook, 'real-hook');
  });
});

test.describe('HookDispatcher - Mode management', () => {
  test('setMode should update mode to internal', () => {
    var dispatcher = new HookDispatcher();
    dispatcher.setMode('internal');
    assert.strictEqual(dispatcher.getMode(), 'internal');
  });

  test('setMode should update mode to external', () => {
    var dispatcher = new HookDispatcher({ mode: 'internal' });
    dispatcher.setMode('external');
    assert.strictEqual(dispatcher.getMode(), 'external');
  });

  test('setMode should throw for invalid mode', () => {
    var dispatcher = new HookDispatcher();
    assert.throws(function () {
      dispatcher.setMode('invalid');
    }, /Invalid mode/);
  });

  test('canUseInternalMode should return false without pluginLoader', () => {
    var dispatcher = new HookDispatcher();
    assert.strictEqual(dispatcher.canUseInternalMode(), false);
  });

  test('canUseInternalMode should return true with pluginLoader', () => {
    var loader = createMockPluginLoader([]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader });
    assert.strictEqual(dispatcher.canUseInternalMode(), true);
  });
});

test.describe('HookDispatcher - getHookStats', () => {
  test('should return empty stats without pluginLoader', () => {
    var dispatcher = new HookDispatcher();
    var stats = dispatcher.getHookStats();
    assert.strictEqual(stats.total, 0);
    assert.deepStrictEqual(stats.byEvent, {});
    assert.deepStrictEqual(stats.byPriority, []);
  });

  test('should count hooks by event type', () => {
    var h1 = createMockHook('pre-hook-1', { event: 'PreToolUse' });
    var h2 = createMockHook('pre-hook-2', { event: 'PreToolUse' });
    var h3 = createMockHook('session-hook', { event: 'SessionStart' });
    var loader = createMockPluginLoader([h1, h2, h3]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader });

    var stats = dispatcher.getHookStats();
    assert.strictEqual(stats.total, 3);
    assert.strictEqual(stats.byEvent['PreToolUse'], 2);
    assert.strictEqual(stats.byEvent['SessionStart'], 1);
  });

  test('should list hooks sorted by priority', () => {
    var h1 = createMockHook('high', { event: 'PreToolUse', priority: 200 });
    var h2 = createMockHook('low', { event: 'PreToolUse', priority: 10 });
    var loader = createMockPluginLoader([h1, h2]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader });

    var stats = dispatcher.getHookStats();
    assert.strictEqual(stats.byPriority[0].name, 'low');
    assert.strictEqual(stats.byPriority[0].priority, 10);
    assert.strictEqual(stats.byPriority[1].name, 'high');
    assert.strictEqual(stats.byPriority[1].priority, 200);
  });

  test('should skip non-hook plugins in stats', () => {
    var hook = createMockHook('real-hook', { event: 'PreToolUse' });
    var validator = { name: 'validator-plugin', type: PluginType.VALIDATOR };
    var loader = createMockPluginLoader([hook, validator]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader });

    var stats = dispatcher.getHookStats();
    assert.strictEqual(stats.total, 1);
  });

  test('should handle hook without trigger gracefully', () => {
    var hook = { name: 'no-trigger', type: PluginType.HOOK, trigger: null };
    var loader = createMockPluginLoader([hook]);
    var dispatcher = new HookDispatcher({ pluginLoader: loader });

    var stats = dispatcher.getHookStats();
    assert.strictEqual(stats.total, 1);
    assert.strictEqual(stats.byEvent['unknown'], 1);
  });
});

test.describe('HookDispatcher - Logging', () => {
  test('should use logger when provided', async () => {
    var loader = createMockPluginLoader([]);
    var logger = new MockLogger();
    var dispatcher = new HookDispatcher({ pluginLoader: loader, logger: logger, mode: 'internal' });

    await dispatcher.dispatch({ event: 'PreToolUse' });
    var debugLogs = logger.logs.filter(function (l) { return l.level === 'debug'; });
    assert.ok(debugLogs.length > 0);
  });

  test('should use console fallback when no logger', async () => {
    var dispatcher = new HookDispatcher();
    // Should not throw
    var result = await dispatcher.dispatch({ event: 'PreToolUse' });
    assert.strictEqual(result.allowed, true);
  });
});

test.describe('HookDispatcher - Exports', () => {
  test('should export ExecutionMode constants', () => {
    assert.strictEqual(ExecutionMode.EXTERNAL, 'external');
    assert.strictEqual(ExecutionMode.INTERNAL, 'internal');
  });
});
