/**
 * Unit tests for PluginLoader
 * Run with: node --test test/runtime/test-plugin-loader.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Mock runtime components for testing
class MockEventBus {
  constructor() {
    this.events = [];
  }
  emit(event, data) {
    this.events.push({ event, data });
  }
}

class MockLogger {
  constructor() {
    this.logs = [];
  }
  debug(plugin, msg) { this.logs.push({ level: 'debug', plugin, msg }); }
  info(plugin, msg) { this.logs.push({ level: 'info', plugin, msg }); }
  warn(plugin, msg) { this.logs.push({ level: 'warn', plugin, msg }); }
  error(plugin, msg) { this.logs.push({ level: 'error', plugin, msg }); }
  createChild(name) {
    const child = { logs: [] };
    ['debug', 'info', 'warn', 'error'].forEach(level => {
      child[level] = (msg) => this.logs.push({ level, plugin: name, msg });
    });
    return child;
  }
}

class MockStateStore {
  constructor() {
    this.data = {};
  }
  async get(key) { return this.data[key]; }
  async set(key, value) { this.data[key] = value; }
}

class MockConfigManager {
  constructor() {
    this.data = {};
  }
  get(key, defaultValue) { return this.data[key] !== undefined ? this.data[key] : defaultValue; }
  setOverride(key, value) { this.data[key] = value; }
}

// Helper to create a test registry
function createTestRegistry(tmpDir, plugins) {
  const registryPath = path.join(tmpDir, 'plugin-registry.json');
  const registry = {
    version: '1.0.0',
    plugins: plugins.map(p => ({
      name: p.name,
      source: p.source || p.name,
      enabled: p.enabled !== false,
      config: p.config || {}
    }))
  };
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');

  // Get absolute path to plugin-interface for dynamic requires
  const pluginInterfacePath = path.resolve(__dirname, '../../plugins/contracts/plugin-interface.js').replace(/\\/g, '/');

  // Create plugin directories and plugin.json files
  const coreDir = path.join(tmpDir, 'core');
  if (!fs.existsSync(coreDir)) {
    fs.mkdirSync(coreDir, { recursive: true });
  }

  plugins.forEach(p => {
    const pluginDir = path.join(coreDir, p.source || p.name);
    if (!fs.existsSync(pluginDir)) {
      fs.mkdirSync(pluginDir, { recursive: true });
    }

    const pluginJson = {
      name: p.name,
      version: p.version || '0.0.1',
      type: p.type || 'skill',
      description: p.description || 'Test plugin',
      triggers: p.triggers || [],
      metadata: p.metadata || {}
    };

    if (p.provides) {
      pluginJson.provides = p.provides;
    }

    // Persist top-level `dependencies` string array (canonical plugin.json schema, B2).
    // When set on the plugin.json itself (not just config), the loader must read it.
    if (p.dependencies) {
      pluginJson.dependencies = p.dependencies;
    }

    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify(pluginJson, null, 2),
      'utf-8'
    );

    // Create index.js for non-skill plugins
    if (p.type !== 'skill') {
      const PluginInterface = require('../../plugins/contracts/plugin-interface');
      const content = `
'use strict';
const { ${p.type === 'hook' ? 'HookPlugin' : p.type === 'validator' ? 'ValidatorPlugin' : 'ProviderPlugin'} } = require('${pluginInterfacePath}');

class Test${p.type.charAt(0).toUpperCase() + p.type.slice(1)} extends ${p.type === 'hook' ? 'HookPlugin' : p.type === 'validator' ? 'ValidatorPlugin' : 'ProviderPlugin'} {
  constructor() {
    super();
    this.name = '${p.name}';
    this.version = '${p.version || '0.0.1'}';
  }

  ${p.type === 'provider' ? 'async factory(context) { return { test: true }; }' : ''}
  ${p.type === 'hook' ? 'async handle(context) { return { allowed: true }; }' : ''}
  ${p.type === 'validator' ? 'async validate(context) { return { passed: true, errors: [], warnings: [] }; }' : ''}
}

module.exports = Test${p.type.charAt(0).toUpperCase() + p.type.slice(1)};
`;
      fs.writeFileSync(path.join(pluginDir, 'index.js'), content, 'utf-8');
    }
  });

  return registryPath;
}

test.describe('PluginLoader - Construction', () => {
  test('should construct with required dependencies', () => {
    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const eventBus = new MockEventBus();
    const stateStore = new MockStateStore();
    const configManager = new MockConfigManager();
    const logger = new MockLogger();

    const loader = new PluginLoader({
      eventBus, stateStore, configManager, logger
    });

    assert.ok(loader, 'loader created');
    assert.strictEqual(loader.isLoaded('anything'), false, 'no plugins loaded initially');
  });

  test('should construct with minimal options', () => {
    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const loader = new PluginLoader({});

    assert.ok(loader, 'loader created with minimal options');
  });
});

test.describe('PluginLoader - Load All', () => {
  test('should load plugins from empty registry', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, []);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    const loaded = await loader.loadAll();

    assert.deepStrictEqual(loaded, [], 'no plugins loaded from empty registry');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should load skill plugins', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'test-skill', type: 'skill', triggers: ['test'] }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const eventBus = new MockEventBus();
    const logger = new MockLogger();
    const loader = new PluginLoader({
      registryPath,
      eventBus,
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger
    });

    const loaded = await loader.loadAll();

    assert.deepStrictEqual(loaded, ['test-skill'], 'skill plugin loaded');
    assert.strictEqual(loader.isLoaded('test-skill'), true, 'plugin is loaded');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should skip disabled plugins', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'enabled-plugin', type: 'skill' },
      { name: 'disabled-plugin', type: 'skill', enabled: false }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    const loaded = await loader.loadAll();

    assert.deepStrictEqual(loaded, ['enabled-plugin'], 'only enabled plugin loaded');
    assert.strictEqual(loader.isLoaded('disabled-plugin'), false, 'disabled plugin not loaded');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should emit plugin:loaded events', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'test-plugin', type: 'skill' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const eventBus = new MockEventBus();
    const loader = new PluginLoader({
      registryPath,
      eventBus,
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    await loader.loadAll();

    // Both plugin:loaded and plugin:activated events are emitted
    assert.strictEqual(eventBus.events.length, 2, 'two events emitted (loaded and activated)');
    assert.strictEqual(eventBus.events[0].event, 'plugin:loaded');
    assert.strictEqual(eventBus.events[1].event, 'plugin:activated');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

test.describe('PluginLoader - Topological Sort', () => {
  test('should load plugins in dependency order', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'plugin-c', type: 'skill', config: { dependencies: { plugins: ['plugin-b'] } } },
      { name: 'plugin-a', type: 'skill' },
      { name: 'plugin-b', type: 'skill', config: { dependencies: { plugins: ['plugin-a'] } } }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const logger = new MockLogger();
    const loadOrder = [];
    const originalLog = logger.info.bind(logger);
    logger.info = (plugin, msg) => {
      if (msg.includes('Load order resolved')) {
        const match = msg.match(/Load order resolved: (.+)/);
        if (match) loadOrder.push(...match[1].split(', '));
      }
      originalLog(plugin, msg);
    };

    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger
    });

    await loader.loadAll();

    assert.deepStrictEqual(loadOrder, ['plugin-a', 'plugin-b', 'plugin-c'], 'plugins loaded in dependency order');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should detect circular dependencies', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'plugin-a', type: 'skill', config: { dependencies: { plugins: ['plugin-b'] } } },
      { name: 'plugin-b', type: 'skill', config: { dependencies: { plugins: ['plugin-a'] } } }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    await assert.rejects(
      () => loader.loadAll(),
      (err) => err.message.includes('Circular dependency')
    );

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

test.describe('PluginLoader - Activation', () => {
  test('should activate loaded plugin', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'test-plugin', type: 'skill' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const eventBus = new MockEventBus();
    const loader = new PluginLoader({
      registryPath,
      eventBus,
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    await loader.loadAll();

    const plugin = loader.getPlugin('test-plugin');
    assert.ok(plugin, 'plugin loaded');
    assert.strictEqual(plugin.state, 'activated', 'plugin activated');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should emit plugin:activated event', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'test-plugin', type: 'skill' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const eventBus = new MockEventBus();
    const loader = new PluginLoader({
      registryPath,
      eventBus,
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    await loader.loadAll();

    const activatedEvents = eventBus.events.filter(e => e.event === 'plugin:activated');
    assert.strictEqual(activatedEvents.length, 1, 'plugin:activated event emitted');
    assert.strictEqual(activatedEvents[0].data.pluginName, 'test-plugin');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

test.describe('PluginLoader - Provider Plugins', () => {
  test('should register provider factory output', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'test-provider', type: 'provider', provides: ['provider:test'], version: '1.0.0' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    await loader.loadAll();

    const provider = loader.getProvider('test');
    assert.ok(provider, 'provider registered');
    assert.strictEqual(provider.test, true, 'factory output registered');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

test.describe('PluginLoader - Query Methods', () => {
  test('getPlugin() should return loaded plugin', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'test-plugin', type: 'skill' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    await loader.loadAll();

    const plugin = loader.getPlugin('test-plugin');
    assert.ok(plugin, 'plugin returned');
    assert.strictEqual(plugin.name, 'test-plugin');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('getPlugin() should return undefined for non-existent plugin', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, []);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    await loader.loadAll();

    const plugin = loader.getPlugin('non-existent');
    assert.strictEqual(plugin, undefined, 'undefined for non-existent plugin');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('getLoadedNames() should return all loaded plugin names', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'plugin-a', type: 'skill' },
      { name: 'plugin-b', type: 'skill' },
      { name: 'plugin-c', type: 'skill' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    await loader.loadAll();

    const names = loader.getLoadedNames();
    names.sort();
    assert.deepStrictEqual(names, ['plugin-a', 'plugin-b', 'plugin-c'], 'all loaded names returned');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

test.describe('PluginLoader - Deactivation', () => {
  test('should deactivate loaded plugin', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'test-plugin', type: 'skill' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    await loader.loadAll();
    assert.strictEqual(loader.getPlugin('test-plugin').state, 'activated');

    await loader.deactivate('test-plugin');
    assert.strictEqual(loader.getPlugin('test-plugin').state, 'deactivated', 'plugin deactivated');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('deactivateAll() should deactivate all plugins in reverse order', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'plugin-a', type: 'skill' },
      { name: 'plugin-b', type: 'skill' },
      { name: 'plugin-c', type: 'skill' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    await loader.loadAll();
    await loader.deactivateAll();

    assert.strictEqual(loader.getPlugin('plugin-a').state, 'deactivated');
    assert.strictEqual(loader.getPlugin('plugin-b').state, 'deactivated');
    assert.strictEqual(loader.getPlugin('plugin-c').state, 'deactivated');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

test.describe('PluginLoader - External Plugin Loading (sourceType)', () => {
  test('should load local plugin via sourceType=local with absolute path', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const externalDir = path.join(tmpDir, 'external-plugins', 'ext-skill');
    fs.mkdirSync(externalDir, { recursive: true });

    // Create plugin.json in external directory
    fs.writeFileSync(
      path.join(externalDir, 'plugin.json'),
      JSON.stringify({
        name: 'ext-skill',
        version: '1.0.0',
        type: 'skill',
        description: 'External skill plugin'
      }, null, 2),
      'utf-8'
    );

    // Create registry with sourceType=local and absolute path
    const registryPath = path.join(tmpDir, 'plugin-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({
      version: '1.0.0',
      plugins: [{
        name: 'ext-skill',
        source: externalDir,
        sourceType: 'local',
        enabled: true,
        config: {}
      }]
    }, null, 2), 'utf-8');

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    const loaded = await loader.loadAll();

    assert.deepStrictEqual(loaded, ['ext-skill'], 'external local plugin loaded');
    assert.strictEqual(loader.isLoaded('ext-skill'), true);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should load local plugin via sourceType=local with relative path', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryDir = path.join(tmpDir, 'plugins');
    const externalDir = path.join(tmpDir, 'external-plugins', 'ext-skill');
    fs.mkdirSync(externalDir, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });

    // Create plugin.json in external directory
    fs.writeFileSync(
      path.join(externalDir, 'plugin.json'),
      JSON.stringify({
        name: 'ext-skill',
        version: '1.0.0',
        type: 'skill',
        description: 'External skill plugin'
      }, null, 2),
      'utf-8'
    );

    // Create registry with relative path (relative to registry dir)
    const registryPath = path.join(registryDir, 'plugin-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({
      version: '1.0.0',
      plugins: [{
        name: 'ext-skill',
        source: '../external-plugins/ext-skill',
        sourceType: 'local',
        enabled: true,
        config: {}
      }]
    }, null, 2), 'utf-8');

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    const loaded = await loader.loadAll();

    assert.deepStrictEqual(loaded, ['ext-skill'], 'external local plugin loaded via relative path');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should give clear error for invalid sourceType', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = path.join(tmpDir, 'plugin-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({
      version: '1.0.0',
      plugins: [{
        name: 'bad-plugin',
        source: 'bad-plugin',
        sourceType: 'ftp',
        enabled: true,
        config: {}
      }]
    }, null, 2), 'utf-8');

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const logger = new MockLogger();
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger
    });

    const loaded = await loader.loadAll();

    // Plugin should fail to load (error logged, not thrown)
    assert.deepStrictEqual(loaded, [], 'invalid sourceType plugin not loaded');

    // Check error was logged
    const errorLogs = logger.logs.filter(l => l.level === 'error' && l.msg.includes('Invalid sourceType'));
    assert.ok(errorLogs.length > 0, 'error logged for invalid sourceType');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should give clear error for unresolvable npm package', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = path.join(tmpDir, 'plugin-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({
      version: '1.0.0',
      plugins: [{
        name: 'npm-plugin',
        source: 'nonexistent-tackle-plugin-xyz-999',
        sourceType: 'npm',
        enabled: true,
        config: {}
      }]
    }, null, 2), 'utf-8');

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const logger = new MockLogger();
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger
    });

    const loaded = await loader.loadAll();

    assert.deepStrictEqual(loaded, [], 'unresolvable npm plugin not loaded');

    // Check error was logged
    const errorLogs = logger.logs.filter(l => l.level === 'error' && l.msg.includes('Failed to resolve npm'));
    assert.ok(errorLogs.length > 0, 'error logged for unresolvable npm package');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should load core plugins and local plugins together', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const externalDir = path.join(tmpDir, 'external-plugins', 'ext-skill');
    fs.mkdirSync(externalDir, { recursive: true });

    // Create external plugin
    fs.writeFileSync(
      path.join(externalDir, 'plugin.json'),
      JSON.stringify({
        name: 'ext-skill',
        version: '1.0.0',
        type: 'skill',
        description: 'External skill plugin'
      }, null, 2),
      'utf-8'
    );

    // Create registry with both core and local plugins
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'core-skill', type: 'skill' }
    ]);

    // Read and add external plugin entry
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    registry.plugins.push({
      name: 'ext-skill',
      source: externalDir,
      sourceType: 'local',
      enabled: true,
      config: {}
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    const loaded = await loader.loadAll();
    loaded.sort();

    assert.deepStrictEqual(loaded, ['core-skill', 'ext-skill'], 'both core and local plugins loaded');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('S3: should warn when loading a third-party plugin via require()', async () => {
    // The sandbox is decorative; loading a non-Skill npm/local plugin runs its
    // constructor in the main process. The loader must surface a warn log so
    // operators know the plugin has full process privileges.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-s3-'));
    const externalDir = path.join(tmpDir, 'external-plugins', 'ext-hook');
    fs.mkdirSync(externalDir, { recursive: true });

    const pluginInterfacePath = path.resolve(__dirname, '../../plugins/contracts/plugin-interface.js').replace(/\\/g, '/');

    fs.writeFileSync(
      path.join(externalDir, 'plugin.json'),
      JSON.stringify({
        name: 'ext-hook',
        version: '1.0.0',
        type: 'hook',
        description: 'External hook'
      }, null, 2),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(externalDir, 'index.js'),
      `'use strict';
const { HookPlugin } = require('${pluginInterfacePath}');
class ExtHook extends HookPlugin {
  constructor() { super(); this.name = 'ext-hook'; this.version = '1.0.0'; }
  async handle(context) { return { allowed: true }; }
}
module.exports = ExtHook;
`,
      'utf-8'
    );

    const registryPath = createTestRegistry(tmpDir, [
      { name: 'core-skill', type: 'skill' }
    ]);
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    registry.plugins.push({
      name: 'ext-hook',
      source: externalDir,
      sourceType: 'local',
      enabled: true,
      config: {}
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const logger = new MockLogger();
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger
    });

    await loader.loadAll();

    // S3: a warn log must mention the third-party plugin + decorative sandbox
    const warnLogs = logger.logs.filter(
      l => l.level === 'warn' &&
        l.msg.includes('ext-hook') &&
        l.msg.includes('sandbox is decorative')
    );
    assert.ok(warnLogs.length > 0, 'warn emitted for third-party plugin load (S3)');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('S3: should NOT warn when loading a core plugin', async () => {
    // Core plugins are first-party and trusted; no decorative-sandbox warning.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-s3-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'core-skill', type: 'skill' },
      { name: 'core-provider', type: 'provider', provides: ['provider:core'], version: '1.0.0' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const logger = new MockLogger();
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger
    });

    await loader.loadAll();

    const sandboxWarns = logger.logs.filter(l => l.level === 'warn' && l.msg.includes('sandbox is decorative'));
    assert.strictEqual(sandboxWarns.length, 0, 'no decorative-sandbox warning for core plugins (S3)');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

test.describe('PluginLoader - Provider Dependency Chain', () => {
  test('should load plugin after its provider dependency', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'consumer-plugin', type: 'skill', config: { dependencies: { providers: ['provider:state-store'] } } },
      { name: 'provider-state-store', type: 'provider', provides: ['provider:state-store'], version: '1.0.0' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const logger = new MockLogger();
    const loadOrder = [];
    const originalLog = logger.info.bind(logger);
    logger.info = (plugin, msg) => {
      if (msg.includes('Load order resolved')) {
        const match = msg.match(/Load order resolved: (.+)/);
        if (match) loadOrder.push(...match[1].split(', '));
      }
      originalLog(plugin, msg);
    };

    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger
    });

    await loader.loadAll();

    const providerIndex = loadOrder.indexOf('provider-state-store');
    const consumerIndex = loadOrder.indexOf('consumer-plugin');
    assert.ok(providerIndex < consumerIndex, 'provider should be loaded before consumer');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should resolve provider dependency using short name without prefix', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'consumer-plugin', type: 'skill', config: { dependencies: { providers: ['state-store'] } } },
      { name: 'provider-state-store', type: 'provider', provides: ['provider:state-store'], version: '1.0.0' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const logger = new MockLogger();
    const loadOrder = [];
    const originalLog = logger.info.bind(logger);
    logger.info = (plugin, msg) => {
      if (msg.includes('Load order resolved')) {
        const match = msg.match(/Load order resolved: (.+)/);
        if (match) loadOrder.push(...match[1].split(', '));
      }
      originalLog(plugin, msg);
    };

    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger
    });

    await loader.loadAll();

    const providerIndex = loadOrder.indexOf('provider-state-store');
    const consumerIndex = loadOrder.indexOf('consumer-plugin');
    assert.ok(providerIndex < consumerIndex, 'provider loaded before consumer with short name');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should detect circular provider dependencies', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));

    // Provider A depends on Provider B, Provider B depends on Provider A
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'provider-a', type: 'provider', provides: ['provider:a'], version: '1.0.0', config: { dependencies: { providers: ['provider:b'] } } },
      { name: 'provider-b', type: 'provider', provides: ['provider:b'], version: '1.0.0', config: { dependencies: { providers: ['provider:a'] } } }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    await assert.rejects(
      () => loader.loadAll(),
      (err) => err.message.includes('Circular dependency')
    );

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should handle mixed plugin and provider dependencies', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'consumer-plugin', type: 'skill', config: { dependencies: { plugins: ['base-plugin'], providers: ['provider:state-store'] } } },
      { name: 'base-plugin', type: 'skill' },
      { name: 'provider-state-store', type: 'provider', provides: ['provider:state-store'], version: '1.0.0' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const logger = new MockLogger();
    const loadOrder = [];
    const originalLog = logger.info.bind(logger);
    logger.info = (plugin, msg) => {
      if (msg.includes('Load order resolved')) {
        const match = msg.match(/Load order resolved: (.+)/);
        if (match) loadOrder.push(...match[1].split(', '));
      }
      originalLog(plugin, msg);
    };

    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger
    });

    await loader.loadAll();

    const baseIndex = loadOrder.indexOf('base-plugin');
    const providerIndex = loadOrder.indexOf('provider-state-store');
    const consumerIndex = loadOrder.indexOf('consumer-plugin');
    assert.ok(baseIndex < consumerIndex, 'base plugin loaded before consumer');
    assert.ok(providerIndex < consumerIndex, 'provider loaded before consumer');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should warn when provider dependency is not satisfied', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'consumer-plugin', type: 'skill', config: { dependencies: { providers: ['provider:nonexistent'] } } }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const logger = new MockLogger();
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger
    });

    // Should not throw, but warn
    await loader.loadAll();

    const warnLogs = logger.logs.filter(l => l.level === 'warn' && l.msg.includes('which is not provided by any plugin'));
    assert.ok(warnLogs.length > 0, 'warning logged for unsatisfied provider dependency');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should handle multi-level provider dependency chain', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
    // Provider C depends on Provider B, Provider B depends on Provider A
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'provider-c', type: 'provider', provides: ['provider:c'], version: '1.0.0', config: { dependencies: { providers: ['provider:b'] } } },
      { name: 'provider-a', type: 'provider', provides: ['provider:a'], version: '1.0.0' },
      { name: 'provider-b', type: 'provider', provides: ['provider:b'], version: '1.0.0', config: { dependencies: { providers: ['provider:a'] } } }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const logger = new MockLogger();
    const loadOrder = [];
    const originalLog = logger.info.bind(logger);
    logger.info = (plugin, msg) => {
      if (msg.includes('Load order resolved')) {
        const match = msg.match(/Load order resolved: (.+)/);
        if (match) loadOrder.push(...match[1].split(', '));
      }
      originalLog(plugin, msg);
    };

    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger
    });

    await loader.loadAll();

    const indexA = loadOrder.indexOf('provider-a');
    const indexB = loadOrder.indexOf('provider-b');
    const indexC = loadOrder.indexOf('provider-c');
    assert.ok(indexA < indexB, 'provider-a loaded before provider-b');
    assert.ok(indexB < indexC, 'provider-b loaded before provider-c');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should register third-party provider and resolve its dependency', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));

    // Create an external (third-party) provider plugin
    const externalDir = path.join(tmpDir, 'external-plugins', 'ext-provider');
    fs.mkdirSync(externalDir, { recursive: true });

    const pluginInterfacePath = path.resolve(__dirname, '../../plugins/contracts/plugin-interface.js').replace(/\\/g, '/');

    fs.writeFileSync(
      path.join(externalDir, 'plugin.json'),
      JSON.stringify({
        name: 'ext-provider',
        version: '1.0.0',
        type: 'provider',
        description: 'Third-party provider',
        provides: ['provider:ext-service']
      }, null, 2),
      'utf-8'
    );

    fs.writeFileSync(
      path.join(externalDir, 'index.js'),
      `'use strict';
const { ProviderPlugin } = require('${pluginInterfacePath}');

class ExtProvider extends ProviderPlugin {
  constructor() {
    super();
    this.name = 'ext-provider';
    this.version = '1.0.0';
  }

  async factory(context) { return { extService: true }; }
}

module.exports = ExtProvider;
`,
      'utf-8'
    );

    // Create registry with a consumer depending on the third-party provider
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'consumer-skill', type: 'skill', config: { dependencies: { providers: ['provider:ext-service'] } } }
    ]);

    // Add the external provider to the registry
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    registry.plugins.push({
      name: 'ext-provider',
      source: externalDir,
      sourceType: 'local',
      enabled: true,
      config: {}
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const logger = new MockLogger();
    const loadOrder = [];
    const originalLog = logger.info.bind(logger);
    logger.info = (plugin, msg) => {
      if (msg.includes('Load order resolved')) {
        const match = msg.match(/Load order resolved: (.+)/);
        if (match) loadOrder.push(...match[1].split(', '));
      }
      originalLog(plugin, msg);
    };

    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger
    });

    const loaded = await loader.loadAll();

    assert.ok(loaded.includes('ext-provider'), 'third-party provider loaded');
    assert.ok(loaded.includes('consumer-skill'), 'consumer skill loaded');

    const extIndex = loadOrder.indexOf('ext-provider');
    const consumerIndex = loadOrder.indexOf('consumer-skill');
    assert.ok(extIndex < consumerIndex, 'third-party provider loaded before consumer');

    // Verify the provider is registered and accessible
    const provider = loader.getProvider('ext-service');
    assert.ok(provider, 'third-party provider registered');
    assert.strictEqual(provider.extService, true, 'factory output correct');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// Helper to capture load order via the logger
function captureLoadOrder(logger) {
  const loadOrder = [];
  const originalLog = logger.info.bind(logger);
  logger.info = (plugin, msg) => {
    if (msg.includes('Load order resolved')) {
      const match = msg.match(/Load order resolved: (.+)/);
      if (match) loadOrder.push(...match[1].split(', '));
    }
    originalLog(plugin, msg);
  };
  return loadOrder;
}

test.describe('PluginLoader - B2 regression: top-level plugin.json dependencies', () => {
  // B2: plugin.json's canonical schema is `"dependencies": ["provider:state-store"]`
  // (top-level string array), but the loader only read config.dependencies.{plugins,providers}.
  // Result: the dependency graph contained no edges for real-world plugins, so a
  // provider could load AFTER a consumer that needs it.
  test('should read top-level dependencies string array from plugin.json', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-b2-'));
    const registryPath = createTestRegistry(tmpDir, [
      // hook-skill-gate depends on provider:state-store, declared at top level of plugin.json
      { name: 'hook-skill-gate', type: 'hook', provides: ['hook:skill-gate'], dependencies: ['provider:state-store'] },
      { name: 'provider-state-store', type: 'provider', provides: ['provider:state-store'], version: '1.0.0' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const logger = new MockLogger();
    const loadOrder = captureLoadOrder(logger);

    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger
    });

    await loader.loadAll();

    const providerIndex = loadOrder.indexOf('provider-state-store');
    const hookIndex = loadOrder.indexOf('hook-skill-gate');
    assert.ok(providerIndex !== -1 && hookIndex !== -1, 'both plugins loaded');
    assert.ok(providerIndex < hookIndex, 'provider must load before hook that depends on it (B2)');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should resolve short provider name in top-level dependencies', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-b2-'));
    const registryPath = createTestRegistry(tmpDir, [
      // Short form (no "provider:" prefix) must also resolve
      { name: 'consumer', type: 'skill', dependencies: ['state-store'] },
      { name: 'provider-state-store', type: 'provider', provides: ['provider:state-store'], version: '1.0.0' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const logger = new MockLogger();
    const loadOrder = captureLoadOrder(logger);

    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger
    });

    await loader.loadAll();

    const providerIndex = loadOrder.indexOf('provider-state-store');
    const consumerIndex = loadOrder.indexOf('consumer');
    assert.ok(providerIndex < consumerIndex, 'provider loaded before consumer via short name (B2)');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should support string-form `provides` (not just array)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-b2-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'consumer', type: 'skill', dependencies: ['provider:solo'] },
      // provides declared as a single string, not an array
      { name: 'provider-solo', type: 'provider', provides: 'provider:solo', version: '1.0.0' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const logger = new MockLogger();
    const loadOrder = captureLoadOrder(logger);

    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger
    });

    await loader.loadAll();

    const providerIndex = loadOrder.indexOf('provider-solo');
    const consumerIndex = loadOrder.indexOf('consumer');
    assert.ok(providerIndex < consumerIndex, 'string-form provides recognized (B2)');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should build correct dependency graph for the real hook-skill-gate plugin', async () => {
    // Reproduces the original PoC: hook-skill-gate depends on provider:state-store
    // but provider-state-store appeared AFTER hook-skill-gate in load order due to
    // _buildDependencyGraph reading the wrong schema. Verify the loader can introspect
    // _buildDependencyGraph directly.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-b2-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'hook-skill-gate', type: 'hook', provides: ['hook:skill-gate'], dependencies: ['provider:state-store'] },
      { name: 'provider-state-store', type: 'provider', provides: ['provider:state-store'], version: '1.0.0' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger: new MockLogger()
    });

    // Read registry and prime internal configs like loadAll() does
    loader._registry = loader._readRegistry();
    const names = loader._getPluginNames();
    const graph = loader._buildDependencyGraph(names);

    // hook-skill-gate must have an edge to provider-state-store (previously was [])
    assert.ok(graph.has('hook-skill-gate'), 'hook-skill-gate in graph');
    const gateDeps = graph.get('hook-skill-gate');
    assert.ok(gateDeps.indexOf('provider-state-store') !== -1,
      'hook-skill-gate must depend on provider-state-store (got: ' + JSON.stringify(gateDeps) + ')');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should keep reading legacy config.dependencies.{plugins,providers}', async () => {
    // Backward compatibility: existing tests rely on the object form.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-b2-'));
    const registryPath = createTestRegistry(tmpDir, [
      { name: 'consumer-plugin', type: 'skill', config: { dependencies: { plugins: ['base-plugin'], providers: ['provider:state-store'] } } },
      { name: 'base-plugin', type: 'skill' },
      { name: 'provider-state-store', type: 'provider', provides: ['provider:state-store'], version: '1.0.0' }
    ]);

    const PluginLoader = require('../../plugins/runtime/plugin-loader');
    const logger = new MockLogger();
    const loadOrder = captureLoadOrder(logger);

    const loader = new PluginLoader({
      registryPath,
      eventBus: new MockEventBus(),
      stateStore: new MockStateStore(),
      configManager: new MockConfigManager(),
      logger
    });

    await loader.loadAll();

    assert.ok(loadOrder.indexOf('base-plugin') < loadOrder.indexOf('consumer-plugin'), 'legacy plugin dep honored');
    assert.ok(loadOrder.indexOf('provider-state-store') < loadOrder.indexOf('consumer-plugin'), 'legacy provider dep honored');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

