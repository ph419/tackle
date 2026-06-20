/**
 * Test script for HookDispatcher internal mode.
 * Tests HOOK-001-A1: hook-skill-gate can be called programmatically via internal mode.
 */

'use strict';

var path = require('path');
var PluginLoader = require('../plugins/runtime/plugin-loader');
var Logger = require('../plugins/runtime/logger');

async function main() {
  console.log('=== HookDispatcher Internal Mode Test ===\n');

  // 1. Create PluginLoader with minimal services
  var logger = new Logger({ level: 'info' });
  var loader = new PluginLoader({
    registryPath: path.join(__dirname, '..', 'plugins', 'plugin-registry.json'),
    logger: logger,
  });

  // 2. Load all plugins (includes hook-skill-gate)
  console.log('Loading plugins...\n');
  var loaded = await loader.loadAll();
  console.log('Loaded plugins: ' + loaded.join(', ') + '\n');

  // 3. Get HookDispatcher
  var dispatcher = loader.getHookDispatcher();
  if (!dispatcher) {
    console.error('FAIL: HookDispatcher not initialized');
    process.exit(1);
  }
  console.log('HookDispatcher initialized\n');

  // 4. Test HOOK-001-A1: Internal mode call to hook-skill-gate
  console.log('Test HOOK-001-A1: Internal mode PreToolUse dispatch');
  var result = await loader.dispatchHook({
    event: 'PreToolUse',
    tool: 'Edit',
  });

  console.log('Result:');
  console.log('  allowed:', result.allowed);
  console.log('  mode:', result.mode);
  console.log('  results:', result.results ? result.results.length : 0, 'hook(s) executed');

  if (result.mode === 'internal') {
    console.log('\nPASS: Internal mode executed successfully');
  } else {
    console.log('\nFAIL: Expected internal mode, got', result.mode);
    process.exit(1);
  }

  // 5. Test HOOK-001-A3: PostToolUse dispatch
  console.log('\nTest HOOK-001-A3: Internal mode PostToolUse dispatch');
  var postResult = await loader.dispatchHook({
    event: 'PostToolUse',
    tool: 'Skill',
    skill: 'skill-task-creator',
  });

  console.log('Result:');
  console.log('  allowed:', postResult.allowed);
  console.log('  mode:', postResult.mode);

  if (postResult.mode === 'internal') {
    console.log('\nPASS: PostToolUse internal mode executed successfully');
  } else {
    console.log('\nFAIL: Expected internal mode for PostToolUse');
    process.exit(1);
  }

  // 6. Test HOOK-001-T3: Unregistered event type
  console.log('\nTest HOOK-001-T3: Unregistered event type');
  var unregResult = await loader.dispatchHook({
    event: 'NonExistentEvent',
  });

  console.log('Result:');
  console.log('  allowed:', unregResult.allowed);
  console.log('  results:', unregResult.results ? unregResult.results.length : 0);

  if (unregResult.allowed === true && (!unregResult.results || unregResult.results.length === 0)) {
    console.log('\nPASS: Unregistered event handled gracefully');
  } else {
    console.log('\nFAIL: Unregistered event should return allowed=true with empty results');
    process.exit(1);
  }

  console.log('\n=== All Tests Passed ===');
  process.exit(0);
}

main().catch(function (err) {
  console.error('Test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
