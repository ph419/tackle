/**
 * Unit tests for WP-112: A1-1 安全最小集
 *
 * Tests:
 *   1. confirmInstall() in commands/install.js
 *   2. External plugin source warnings in harness-build.js._buildPlugin()
 *   3. validateCapabilities() in plugins/runtime/plugin-validator.js
 *
 * Run with: node --test test/runtime/test-wp112-security.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// Test confirmInstall()
// ---------------------------------------------------------------------------

const { confirmInstall, CAPABILITY_LEVELS } = require('../../commands/install');

test.describe('WP-112: confirmInstall()', () => {
  test('should auto-approve when capabilities are empty', async () => {
    const result = await confirmInstall('test-plugin', { capabilities: {} });
    assert.strictEqual(result, true, 'empty capabilities auto-approve');
  });

  test('should auto-approve when capabilities are missing', async () => {
    const result = await confirmInstall('test-plugin', {});
    assert.strictEqual(result, true, 'missing capabilities auto-approve');
  });

  test('should auto-approve when capabilities is null', async () => {
    const result = await confirmInstall('test-plugin', { capabilities: null });
    assert.strictEqual(result, true, 'null capabilities auto-approve');
  });

  test('should reject in non-interactive mode without TACKLE_ASSUME_YES', async () => {
    const prevEnv = process.env.TACKLE_ASSUME_YES;
    delete process.env.TACKLE_ASSUME_YES;

    const result = await confirmInstall('test-plugin', {
      capabilities: { filesystem: true },
    }, { isNonInteractive: true });

    assert.strictEqual(result, false, 'rejects in non-interactive without env');

    if (prevEnv !== undefined) process.env.TACKLE_ASSUME_YES = prevEnv;
  });

  test('should approve in non-interactive mode with TACKLE_ASSUME_YES=1', async () => {
    const prevEnv = process.env.TACKLE_ASSUME_YES;
    process.env.TACKLE_ASSUME_YES = '1';

    const result = await confirmInstall('test-plugin', {
      capabilities: { filesystem: true },
    }, { isNonInteractive: true });

    assert.strictEqual(result, true, 'approves with TACKLE_ASSUME_YES=1');

    if (prevEnv !== undefined) {
      process.env.TACKLE_ASSUME_YES = prevEnv;
    } else {
      delete process.env.TACKLE_ASSUME_YES;
    }
  });

  test('should approve in non-interactive mode with TACKLE_ASSUME_YES=true', async () => {
    const prevEnv = process.env.TACKLE_ASSUME_YES;
    process.env.TACKLE_ASSUME_YES = 'true';

    const result = await confirmInstall('test-plugin', {
      capabilities: { network: true },
    }, { isNonInteractive: true });

    assert.strictEqual(result, true, 'approves with TACKLE_ASSUME_YES=true');

    if (prevEnv !== undefined) {
      process.env.TACKLE_ASSUME_YES = prevEnv;
    } else {
      delete process.env.TACKLE_ASSUME_YES;
    }
  });

  test('should expose CAPABILITY_LEVELS with expected entries', () => {
    assert.ok(CAPABILITY_LEVELS.filesystem, 'has filesystem');
    assert.ok(CAPABILITY_LEVELS.network, 'has network');
    assert.ok(CAPABILITY_LEVELS.child_process, 'has child_process');
    assert.ok(CAPABILITY_LEVELS.env, 'has env');
  });
});

// ---------------------------------------------------------------------------
// Test validateCapabilities()
// ---------------------------------------------------------------------------

const PluginValidator = require('../../plugins/runtime/plugin-validator');

test.describe('WP-112: validateCapabilities()', () => {
  test('should return empty warnings for null capabilities', () => {
    const warnings = PluginValidator.validateCapabilities(null);
    assert.deepStrictEqual(warnings, [], 'no warnings for null');
  });

  test('should return empty warnings for undefined capabilities', () => {
    const warnings = PluginValidator.validateCapabilities(undefined);
    assert.deepStrictEqual(warnings, [], 'no warnings for undefined');
  });

  test('should return empty warnings for empty object', () => {
    const warnings = PluginValidator.validateCapabilities({});
    assert.deepStrictEqual(warnings, [], 'no warnings for empty object');
  });

  test('should return empty warnings for all known capabilities', () => {
    const caps = {
      filesystem: { read: ['/tmp'] },
      network: false,
      child_process: true,
      env: ['TACKLE_*'],
    };
    const warnings = PluginValidator.validateCapabilities(caps);
    assert.deepStrictEqual(warnings, [], 'no warnings for known capabilities');
  });

  test('should warn on unknown capability', () => {
    const caps = {
      filesystem: true,
      quantum: true,
    };
    const warnings = PluginValidator.validateCapabilities(caps);
    assert.strictEqual(warnings.length, 1, 'one warning for unknown capability');
    assert.strictEqual(warnings[0].field, 'capabilities.quantum', 'warning field name');
    assert.ok(warnings[0].message.includes('quantum'), 'warning mentions unknown name');
  });

  test('should warn on multiple unknown capabilities', () => {
    const caps = {
      foo: true,
      bar: true,
    };
    const warnings = PluginValidator.validateCapabilities(caps);
    assert.strictEqual(warnings.length, 2, 'two warnings');
  });

  test('should warn if capabilities is an array instead of object', () => {
    const warnings = PluginValidator.validateCapabilities(['filesystem']);
    assert.strictEqual(warnings.length, 1, 'one warning for array type');
    assert.ok(warnings[0].message.includes('must be an object'), 'message mentions correct type');
  });

  test('should expose KNOWN_CAPABILITIES list', () => {
    const known = PluginValidator.getKnownCapabilities();
    assert.ok(Array.isArray(known), 'returns array');
    assert.ok(known.indexOf('filesystem') !== -1, 'includes filesystem');
    assert.ok(known.indexOf('network') !== -1, 'includes network');
    assert.ok(known.indexOf('child_process') !== -1, 'includes child_process');
    assert.ok(known.indexOf('env') !== -1, 'includes env');
  });
});

// ---------------------------------------------------------------------------
// Test harness-build.js external plugin warnings
// ---------------------------------------------------------------------------

const HarnessBuild = require('../../plugins/runtime/harness-build');

test.describe('WP-112: harness-build external plugin warnings', () => {
  /**
   * Set up a test fixture with an external plugin.
   * Uses sourceType='local' with absolute path so resolve-plugin-path can find it.
   */
  function setupExternalPlugin(capabilities) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp112-test-'));

    // Create the external plugin directory outside of plugins/core/
    const externalDir = path.join(tmpDir, 'external-plugins', 'external-plugin');
    fs.mkdirSync(externalDir, { recursive: true });

    const meta = {
      name: 'external-plugin',
      version: '0.1.0',
      type: 'skill',
      description: 'External test plugin',
    };
    if (capabilities) {
      meta.capabilities = capabilities;
    }

    fs.writeFileSync(
      path.join(externalDir, 'plugin.json'),
      JSON.stringify(meta, null, 2),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(externalDir, 'skill.md'),
      '# external-plugin\n\nExternal test skill.',
      'utf-8'
    );

    // Create registry with local sourceType pointing at the external dir
    const registryPath = path.join(tmpDir, 'plugins', 'plugin-registry.json');
    const registryDir = path.dirname(registryPath);
    if (!fs.existsSync(registryDir)) {
      fs.mkdirSync(registryDir, { recursive: true });
    }

    const registry = {
      version: '1.0.0',
      plugins: [{
        name: 'external-plugin',
        source: externalDir,
        sourceType: 'local',
        enabled: true,
      }],
    };
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');

    // Create minimal plugins/core/ dir (required by HarnessBuild constructor)
    const coreDir = path.join(tmpDir, 'plugins', 'core');
    if (!fs.existsSync(coreDir)) {
      fs.mkdirSync(coreDir, { recursive: true });
    }

    // Create minimal config
    const configDir = path.join(tmpDir, '.claude', 'config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(configDir, 'harness-config.yaml'),
      '# Minimal test config\ncontext_window:\n  enabled: true\n',
      'utf-8'
    );

    return tmpDir;
  }

  test('should warn on external local plugin with capabilities', () => {
    const tmpDir = setupExternalPlugin({ filesystem: true, network: false });
    const builder = new HarnessBuild({ rootDir: tmpDir, verbose: true });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = function () {
      warnings.push(Array.prototype.slice.call(arguments).join(' '));
    };

    const result = builder.build();
    console.warn = origWarn;

    assert.strictEqual(result.success, true, 'build succeeds');

    const extWarnings = warnings.filter(function (w) {
      return w.indexOf('external plugin') !== -1;
    });
    assert.ok(extWarnings.length > 0, 'should have external plugin warnings');
    assert.ok(extWarnings.some(function (w) { return w.indexOf('local') !== -1; }), 'mentions local source');
    // capabilities appear on a separate warning line
    assert.ok(warnings.some(function (w) { return w.indexOf('filesystem') !== -1; }), 'mentions filesystem capability');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should warn on external local plugin without capabilities', () => {
    const tmpDir = setupExternalPlugin(null);
    const builder = new HarnessBuild({ rootDir: tmpDir, verbose: true });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = function () {
      warnings.push(Array.prototype.slice.call(arguments).join(' '));
    };

    const result = builder.build();
    console.warn = origWarn;

    assert.strictEqual(result.success, true, 'build succeeds');

    const extWarnings = warnings.filter(function (w) {
      return w.indexOf('external plugin') !== -1;
    });
    assert.ok(extWarnings.length > 0, 'should have external plugin warnings');
    // "No capabilities declared" appears on a separate warning line
    assert.ok(warnings.some(function (w) { return w.indexOf('No capabilities declared') !== -1; }), 'mentions no capabilities');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should warn on external plugin with env capability', () => {
    const tmpDir = setupExternalPlugin({ env: ['MY_VAR'] });
    const builder = new HarnessBuild({ rootDir: tmpDir, verbose: true });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = function () {
      warnings.push(Array.prototype.slice.call(arguments).join(' '));
    };

    const result = builder.build();
    console.warn = origWarn;

    assert.strictEqual(result.success, true, 'build succeeds');

    // env capability appears on a warning line
    assert.ok(warnings.some(function (w) { return w.indexOf('env') !== -1; }), 'mentions env capability');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should NOT warn on core plugin', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp112-core-'));
    const pluginsDir = path.join(tmpDir, 'plugins', 'core');
    const registryPath = path.join(tmpDir, 'plugins', 'plugin-registry.json');

    // Create registry
    if (!fs.existsSync(path.dirname(registryPath))) {
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    }
    fs.writeFileSync(registryPath, JSON.stringify({
      version: '1.0.0',
      plugins: [{
        name: 'core-plugin',
        source: 'core-plugin',
        sourceType: 'core',
        enabled: true,
      }],
    }, null, 2), 'utf-8');

    // Create core plugin
    fs.mkdirSync(path.join(pluginsDir, 'core-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'core-plugin', 'plugin.json'), JSON.stringify({
      name: 'core-plugin',
      version: '0.1.0',
      type: 'skill',
      description: 'Core test plugin',
    }, null, 2), 'utf-8');
    fs.writeFileSync(path.join(pluginsDir, 'core-plugin', 'skill.md'), '# core-plugin\n\nCore skill.', 'utf-8');

    // Create config
    const configDir = path.join(tmpDir, '.claude', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'harness-config.yaml'), '# test\ncontext_window:\n  enabled: true\n', 'utf-8');

    const builder = new HarnessBuild({ rootDir: tmpDir, verbose: true });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = function () {
      warnings.push(Array.prototype.slice.call(arguments).join(' '));
    };

    builder.build();
    console.warn = origWarn;

    const extWarnings = warnings.filter(function (w) {
      return w.indexOf('external plugin') !== -1;
    });
    assert.strictEqual(extWarnings.length, 0, 'no external plugin warnings for core');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test harness-build.js validate() integrates capabilities validation
// ---------------------------------------------------------------------------

test.describe('WP-112: harness-build validate() with capabilities', () => {
  test('should warn on unknown capability during validate()', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp112-val-'));
    const pluginsDir = path.join(tmpDir, 'plugins', 'core');
    const registryPath = path.join(tmpDir, 'plugins', 'plugin-registry.json');

    if (!fs.existsSync(path.dirname(registryPath))) {
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    }
    fs.writeFileSync(registryPath, JSON.stringify({
      version: '1.0.0',
      plugins: [{ name: 'test-cap', source: 'test-cap', enabled: true }],
    }, null, 2), 'utf-8');

    fs.mkdirSync(path.join(pluginsDir, 'test-cap'), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'test-cap', 'plugin.json'), JSON.stringify({
      name: 'test-cap',
      version: '0.1.0',
      type: 'skill',
      description: 'Test with unknown cap',
      capabilities: {
        filesystem: { read: ['/tmp'] },
        quantum: true,
      },
    }, null, 2), 'utf-8');
    fs.writeFileSync(path.join(pluginsDir, 'test-cap', 'skill.md'), '# test-cap\n\nTest.', 'utf-8');

    const builder = new HarnessBuild({ rootDir: tmpDir });
    const result = builder.validate();

    assert.strictEqual(result.valid, true, 'unknown caps are warnings not errors');
    const capWarnings = result.warnings.filter(function (w) {
      return w.field === 'capabilities.quantum';
    });
    assert.strictEqual(capWarnings.length, 1, 'should warn on unknown capability');
    assert.ok(capWarnings[0].message.indexOf('quantum') !== -1, 'message mentions unknown cap');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
