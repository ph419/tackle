/**
 * Unit tests for ManifestResolver
 * Run with: node --test test/runtime/test-manifest-resolver.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ManifestResolver = require('../../plugins/runtime/manifest-resolver');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory with plugin-registry.json.
 * @param {object[]} plugins - plugin entries for the registry
 * @returns {{ dir: string, cleanup: Function }}
 */
function createPackageRoot(plugins) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-pkg-'));
  const pluginsDir = path.join(tmpDir, 'plugins');
  fs.mkdirSync(pluginsDir);
  fs.writeFileSync(
    path.join(pluginsDir, 'plugin-registry.json'),
    JSON.stringify({ version: '1.0.0', plugins: plugins || [] }, null, 2) + '\n',
    'utf-8'
  );
  return { dir: tmpDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

/**
 * Create a temporary target directory with optional harness-manifest.json.
 * @param {object|null} manifest - manifest object to write
 * @returns {{ dir: string, cleanup: Function }}
 */
function createTargetRoot(manifest) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-target-'));
  if (manifest) {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'harness-manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf-8'
    );
  }
  return { dir: tmpDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

// Core plugins for tests
const CORE_PLUGINS = [
  { name: 'provider-state-store', source: 'provider-state-store', enabled: true, config: {} },
  { name: 'hook-skill-gate', source: 'hook-skill-gate', enabled: true, config: {} },
  { name: 'skill-task-creator', source: 'skill-task-creator', enabled: true, config: {} }
];

// ===========================================================================
// readGlobalRegistry / readProjectManifest
// ===========================================================================

test('readGlobalRegistry returns empty registry when file missing', () => {
  const { dir, cleanup } = createPackageRoot();
  // Remove the registry to test missing file
  fs.unlinkSync(path.join(dir, 'plugins', 'plugin-registry.json'));
  const result = ManifestResolver.readGlobalRegistry(dir);
  assert.deepStrictEqual(result, { version: '1.0.0', plugins: [] });
  cleanup();
});

test('readGlobalRegistry parses valid registry', () => {
  const { dir, cleanup } = createPackageRoot(CORE_PLUGINS);
  const result = ManifestResolver.readGlobalRegistry(dir);
  assert.strictEqual(result.version, '1.0.0');
  assert.strictEqual(result.plugins.length, 3);
  assert.strictEqual(result.plugins[0].name, 'provider-state-store');
  cleanup();
});

test('readProjectManifest returns null when no manifest', () => {
  const { dir, cleanup } = createTargetRoot(null);
  const result = ManifestResolver.readProjectManifest(dir);
  assert.strictEqual(result, null);
  cleanup();
});

test('readProjectManifest parses valid manifest', () => {
  const manifest = {
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: { 'hook-skill-gate': { enabled: false } }
  };
  const { dir, cleanup } = createTargetRoot(manifest);
  const result = ManifestResolver.readProjectManifest(dir);
  assert.strictEqual(result.plugins['hook-skill-gate'].enabled, false);
  cleanup();
});

// ===========================================================================
// resolveEffectivePlugins - basic merge (existing behavior)
// ===========================================================================

test('resolveEffectivePlugins returns global registry when no manifest', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot(null);
  const result = ManifestResolver.resolveEffectivePlugins(pkg.dir, target.dir);
  assert.strictEqual(result.plugins.length, 3);
  pkg.cleanup();
  target.cleanup();
});

test('resolveEffectivePlugins applies manifest overrides to core plugins', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot({
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: {
      'hook-skill-gate': { enabled: false }
    }
  });
  const result = ManifestResolver.resolveEffectivePlugins(pkg.dir, target.dir);

  const gate = result.plugins.find(p => p.name === 'hook-skill-gate');
  assert.strictEqual(gate.enabled, false);

  const creator = result.plugins.find(p => p.name === 'skill-task-creator');
  assert.strictEqual(creator.enabled, true);

  pkg.cleanup();
  target.cleanup();
});

test('resolveEffectivePlugins applies config override', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot({
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: {
      'hook-skill-gate': { config: { gatedSkills: ['foo'] } }
    }
  });
  const result = ManifestResolver.resolveEffectivePlugins(pkg.dir, target.dir);

  const gate = result.plugins.find(p => p.name === 'hook-skill-gate');
  assert.deepStrictEqual(gate.config, { gatedSkills: ['foo'] });

  pkg.cleanup();
  target.cleanup();
});

// ===========================================================================
// resolveEffectivePlugins - external plugin merge (NEW)
// ===========================================================================

test('resolveEffectivePlugins merges external npm plugin from manifest', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot({
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: {
      'tackle-plugin-foo': {
        enabled: true,
        sourceType: 'npm',
        source: 'tackle-plugin-foo'
      }
    }
  });
  const result = ManifestResolver.resolveEffectivePlugins(pkg.dir, target.dir);

  // Should have 3 core + 1 external
  assert.strictEqual(result.plugins.length, 4);

  const external = result.plugins.find(p => p.name === 'tackle-plugin-foo');
  assert.ok(external, 'external plugin should be in merged list');
  assert.strictEqual(external.sourceType, 'npm');
  assert.strictEqual(external.source, 'tackle-plugin-foo');
  assert.strictEqual(external.enabled, true);

  pkg.cleanup();
  target.cleanup();
});

test('resolveEffectivePlugins merges external local plugin from manifest', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot({
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: {
      'my-local-plugin': {
        enabled: true,
        sourceType: 'local',
        source: '/path/to/my-local-plugin'
      }
    }
  });
  const result = ManifestResolver.resolveEffectivePlugins(pkg.dir, target.dir);

  assert.strictEqual(result.plugins.length, 4);

  const external = result.plugins.find(p => p.name === 'my-local-plugin');
  assert.ok(external);
  assert.strictEqual(external.sourceType, 'local');
  assert.strictEqual(external.source, '/path/to/my-local-plugin');

  pkg.cleanup();
  target.cleanup();
});

test('resolveEffectivePlugins merges multiple external plugins', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot({
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: {
      'ext-plugin-a': { enabled: true, sourceType: 'npm', source: 'ext-plugin-a' },
      'ext-plugin-b': { enabled: false, sourceType: 'local', source: '/plugins/b' }
    }
  });
  const result = ManifestResolver.resolveEffectivePlugins(pkg.dir, target.dir);

  assert.strictEqual(result.plugins.length, 5);

  const a = result.plugins.find(p => p.name === 'ext-plugin-a');
  assert.strictEqual(a.enabled, true);
  assert.strictEqual(a.sourceType, 'npm');

  const b = result.plugins.find(p => p.name === 'ext-plugin-b');
  assert.strictEqual(b.enabled, false);
  assert.strictEqual(b.sourceType, 'local');

  pkg.cleanup();
  target.cleanup();
});

test('resolveEffectivePlugins external plugin defaults sourceType to local', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot({
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: {
      'no-sourcetype-plugin': { enabled: true }
    }
  });
  const result = ManifestResolver.resolveEffectivePlugins(pkg.dir, target.dir);

  const external = result.plugins.find(p => p.name === 'no-sourcetype-plugin');
  assert.ok(external);
  assert.strictEqual(external.sourceType, 'local');
  assert.strictEqual(external.source, 'no-sourcetype-plugin');

  pkg.cleanup();
  target.cleanup();
});

test('resolveEffectivePlugins external plugin defaults enabled to true', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot({
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: {
      'implicit-enabled-plugin': { sourceType: 'npm', source: 'some-pkg' }
    }
  });
  const result = ManifestResolver.resolveEffectivePlugins(pkg.dir, target.dir);

  const external = result.plugins.find(p => p.name === 'implicit-enabled-plugin');
  assert.ok(external);
  assert.strictEqual(external.enabled, true);

  pkg.cleanup();
  target.cleanup();
});

test('resolveEffectivePlugins does not duplicate core plugins', () => {
  // Manifest references a core plugin name with override AND also has external plugins
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot({
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: {
      'hook-skill-gate': { enabled: false },
      'ext-new-plugin': { enabled: true, sourceType: 'npm', source: 'ext-new-plugin' }
    }
  });
  const result = ManifestResolver.resolveEffectivePlugins(pkg.dir, target.dir);

  // 3 core + 1 external = 4
  assert.strictEqual(result.plugins.length, 4);

  // hook-skill-gate should appear exactly once
  const gates = result.plugins.filter(p => p.name === 'hook-skill-gate');
  assert.strictEqual(gates.length, 1);
  assert.strictEqual(gates[0].enabled, false);

  pkg.cleanup();
  target.cleanup();
});

test('resolveEffectivePlugins external plugin config is preserved', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot({
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: {
      'ext-with-config': {
        enabled: true,
        sourceType: 'npm',
        source: 'ext-with-config',
        config: { maxRetries: 3, debug: true }
      }
    }
  });
  const result = ManifestResolver.resolveEffectivePlugins(pkg.dir, target.dir);

  const external = result.plugins.find(p => p.name === 'ext-with-config');
  assert.deepStrictEqual(external.config, { maxRetries: 3, debug: true });

  pkg.cleanup();
  target.cleanup();
});

test('resolveEffectivePlugins preserves registry version', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot({
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: {
      'ext-plugin': { enabled: true, sourceType: 'npm' }
    }
  });
  const result = ManifestResolver.resolveEffectivePlugins(pkg.dir, target.dir);
  assert.strictEqual(result.version, '1.0.0');

  pkg.cleanup();
  target.cleanup();
});

// ===========================================================================
// updatePluginInManifest - external plugin support (NEW)
// ===========================================================================

test('updatePluginInManifest allows updating external plugin (not in global registry)', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot(null);

  // This should succeed now (previously returned false)
  const result = ManifestResolver.updatePluginInManifest(pkg.dir, target.dir, 'ext-plugin', true);
  assert.strictEqual(result, true);

  // Verify it was written
  const manifest = ManifestResolver.readProjectManifest(target.dir);
  assert.ok(manifest);
  assert.strictEqual(manifest.plugins['ext-plugin'].enabled, true);

  pkg.cleanup();
  target.cleanup();
});

test('updatePluginInManifest toggles external plugin enabled status', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot(null);

  // Register
  ManifestResolver.updatePluginInManifest(pkg.dir, target.dir, 'ext-plugin', true);
  // Disable
  ManifestResolver.updatePluginInManifest(pkg.dir, target.dir, 'ext-plugin', false);

  const manifest = ManifestResolver.readProjectManifest(target.dir);
  assert.strictEqual(manifest.plugins['ext-plugin'].enabled, false);

  pkg.cleanup();
  target.cleanup();
});

test('updatePluginInManifest existing core plugin behavior unchanged', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot(null);

  // Disable a core plugin
  const result = ManifestResolver.updatePluginInManifest(pkg.dir, target.dir, 'hook-skill-gate', false);
  assert.strictEqual(result, true);

  const manifest = ManifestResolver.readProjectManifest(target.dir);
  assert.strictEqual(manifest.plugins['hook-skill-gate'].enabled, false);

  pkg.cleanup();
  target.cleanup();
});

// ===========================================================================
// registerExternalPlugin (NEW)
// ===========================================================================

test('registerExternalPlugin creates manifest entry with defaults', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot(null);

  const result = ManifestResolver.registerExternalPlugin(
    pkg.dir, target.dir, 'my-npm-plugin'
  );
  assert.strictEqual(result, true);

  const manifest = ManifestResolver.readProjectManifest(target.dir);
  const entry = manifest.plugins['my-npm-plugin'];
  assert.ok(entry);
  assert.strictEqual(entry.enabled, true);
  assert.strictEqual(entry.sourceType, 'local');
  assert.strictEqual(entry.source, 'my-npm-plugin');
  assert.deepStrictEqual(entry.config, {});

  pkg.cleanup();
  target.cleanup();
});

test('registerExternalPlugin with npm sourceType', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot(null);

  const result = ManifestResolver.registerExternalPlugin(
    pkg.dir, target.dir, 'tackle-plugin-foo',
    { sourceType: 'npm', source: 'tackle-plugin-foo', enabled: true }
  );
  assert.strictEqual(result, true);

  const manifest = ManifestResolver.readProjectManifest(target.dir);
  const entry = manifest.plugins['tackle-plugin-foo'];
  assert.strictEqual(entry.sourceType, 'npm');
  assert.strictEqual(entry.source, 'tackle-plugin-foo');

  pkg.cleanup();
  target.cleanup();
});

test('registerExternalPlugin with config', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot(null);

  ManifestResolver.registerExternalPlugin(
    pkg.dir, target.dir, 'ext-with-cfg',
    {
      sourceType: 'local',
      source: '/plugins/ext',
      config: { timeout: 5000 }
    }
  );

  const manifest = ManifestResolver.readProjectManifest(target.dir);
  const entry = manifest.plugins['ext-with-cfg'];
  assert.deepStrictEqual(entry.config, { timeout: 5000 });

  pkg.cleanup();
  target.cleanup();
});

test('registerExternalPlugin updates existing entry', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot(null);

  // Register first time
  ManifestResolver.registerExternalPlugin(
    pkg.dir, target.dir, 'ext-plugin',
    { sourceType: 'npm', source: 'ext-plugin@1.0.0' }
  );

  // Update with new version
  ManifestResolver.registerExternalPlugin(
    pkg.dir, target.dir, 'ext-plugin',
    { sourceType: 'npm', source: 'ext-plugin@2.0.0' }
  );

  const manifest = ManifestResolver.readProjectManifest(target.dir);
  assert.strictEqual(manifest.plugins['ext-plugin'].source, 'ext-plugin@2.0.0');

  pkg.cleanup();
  target.cleanup();
});

test('registerExternalPlugin can register disabled plugin', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot(null);

  ManifestResolver.registerExternalPlugin(
    pkg.dir, target.dir, 'disabled-plugin',
    { sourceType: 'npm', source: 'disabled-plugin', enabled: false }
  );

  const manifest = ManifestResolver.readProjectManifest(target.dir);
  assert.strictEqual(manifest.plugins['disabled-plugin'].enabled, false);

  pkg.cleanup();
  target.cleanup();
});

test('registerExternalPlugin preserves existing manifest plugins', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot({
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: {
      'hook-skill-gate': { enabled: false }
    }
  });

  ManifestResolver.registerExternalPlugin(
    pkg.dir, target.dir, 'new-ext',
    { sourceType: 'npm', source: 'new-ext' }
  );

  const manifest = ManifestResolver.readProjectManifest(target.dir);
  // Existing override should still be there
  assert.strictEqual(manifest.plugins['hook-skill-gate'].enabled, false);
  // New external should be added
  assert.strictEqual(manifest.plugins['new-ext'].sourceType, 'npm');

  pkg.cleanup();
  target.cleanup();
});

// ===========================================================================
// unregisterExternalPlugin (NEW)
// ===========================================================================

test('unregisterExternalPlugin removes external plugin', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot(null);

  // Register first
  ManifestResolver.registerExternalPlugin(
    pkg.dir, target.dir, 'ext-to-remove',
    { sourceType: 'npm', source: 'ext-to-remove' }
  );

  // Verify it's there
  let manifest = ManifestResolver.readProjectManifest(target.dir);
  assert.ok(manifest.plugins['ext-to-remove']);

  // Unregister
  const result = ManifestResolver.unregisterExternalPlugin(pkg.dir, target.dir, 'ext-to-remove');
  assert.strictEqual(result, true);

  // Verify it's gone
  manifest = ManifestResolver.readProjectManifest(target.dir);
  assert.strictEqual(manifest.plugins['ext-to-remove'], undefined);

  pkg.cleanup();
  target.cleanup();
});

test('unregisterExternalPlugin refuses to remove core plugin', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot({
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: {
      'hook-skill-gate': { enabled: false }
    }
  });

  const result = ManifestResolver.unregisterExternalPlugin(pkg.dir, target.dir, 'hook-skill-gate');
  assert.strictEqual(result, false);

  // Verify it's still there
  const manifest = ManifestResolver.readProjectManifest(target.dir);
  assert.ok(manifest.plugins['hook-skill-gate']);

  pkg.cleanup();
  target.cleanup();
});

test('unregisterExternalPlugin returns false for nonexistent plugin', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot(null);

  const result = ManifestResolver.unregisterExternalPlugin(pkg.dir, target.dir, 'nonexistent');
  assert.strictEqual(result, false);

  pkg.cleanup();
  target.cleanup();
});

test('unregisterExternalPlugin returns false when no manifest', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot(null);

  const result = ManifestResolver.unregisterExternalPlugin(pkg.dir, target.dir, 'anything');
  assert.strictEqual(result, false);

  pkg.cleanup();
  target.cleanup();
});

// ===========================================================================
// listExternalPlugins (NEW)
// ===========================================================================

test('listExternalPlugins returns empty array when no manifest', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot(null);

  const result = ManifestResolver.listExternalPlugins(pkg.dir, target.dir);
  assert.deepStrictEqual(result, []);

  pkg.cleanup();
  target.cleanup();
});

test('listExternalPlugins returns only external plugins', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot({
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: {
      'hook-skill-gate': { enabled: false },
      'ext-plugin-a': { enabled: true, sourceType: 'npm', source: 'ext-plugin-a' },
      'ext-plugin-b': { enabled: true, sourceType: 'local', source: '/plugins/b' }
    }
  });

  const result = ManifestResolver.listExternalPlugins(pkg.dir, target.dir);
  assert.strictEqual(result.length, 2);

  const names = result.map(p => p.name).sort();
  assert.deepStrictEqual(names, ['ext-plugin-a', 'ext-plugin-b']);

  pkg.cleanup();
  target.cleanup();
});

test('listExternalPlugins returns entries with correct structure', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot({
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: {
      'ext-test': {
        enabled: true,
        sourceType: 'npm',
        source: 'tackle-plugin-test',
        config: { maxRetries: 5 }
      }
    }
  });

  const result = ManifestResolver.listExternalPlugins(pkg.dir, target.dir);
  assert.strictEqual(result.length, 1);

  const entry = result[0];
  assert.strictEqual(entry.name, 'ext-test');
  assert.strictEqual(entry.sourceType, 'npm');
  assert.strictEqual(entry.source, 'tackle-plugin-test');
  assert.strictEqual(entry.enabled, true);
  assert.deepStrictEqual(entry.config, { maxRetries: 5 });

  pkg.cleanup();
  target.cleanup();
});

test('listExternalPlugins returns empty when all plugins are core', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot({
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: {
      'hook-skill-gate': { enabled: false },
      'skill-task-creator': { enabled: true }
    }
  });

  const result = ManifestResolver.listExternalPlugins(pkg.dir, target.dir);
  assert.deepStrictEqual(result, []);

  pkg.cleanup();
  target.cleanup();
});

// ===========================================================================
// End-to-end: register -> resolve -> unregister cycle
// ===========================================================================

test('full lifecycle: register external plugin, resolve, then unregister', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const target = createTargetRoot(null);

  // 1. Register
  ManifestResolver.registerExternalPlugin(
    pkg.dir, target.dir, 'lifecycle-plugin',
    { sourceType: 'npm', source: 'lifecycle-plugin', config: { debug: true } }
  );

  // 2. Resolve should include it
  let resolved = ManifestResolver.resolveEffectivePlugins(pkg.dir, target.dir);
  assert.strictEqual(resolved.plugins.length, 4);
  let ext = resolved.plugins.find(p => p.name === 'lifecycle-plugin');
  assert.ok(ext);
  assert.strictEqual(ext.sourceType, 'npm');
  assert.strictEqual(ext.enabled, true);
  assert.deepStrictEqual(ext.config, { debug: true });

  // 3. List should include it
  let listed = ManifestResolver.listExternalPlugins(pkg.dir, target.dir);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].name, 'lifecycle-plugin');

  // 4. Unregister
  const unregResult = ManifestResolver.unregisterExternalPlugin(pkg.dir, target.dir, 'lifecycle-plugin');
  assert.strictEqual(unregResult, true);

  // 5. Resolve should no longer include it
  resolved = ManifestResolver.resolveEffectivePlugins(pkg.dir, target.dir);
  assert.strictEqual(resolved.plugins.length, 3);
  ext = resolved.plugins.find(p => p.name === 'lifecycle-plugin');
  assert.strictEqual(ext, undefined);

  // 6. List should be empty
  listed = ManifestResolver.listExternalPlugins(pkg.dir, target.dir);
  assert.strictEqual(listed.length, 0);

  pkg.cleanup();
  target.cleanup();
});

// ===========================================================================
// writeProjectManifest / createDefaultManifest
// ===========================================================================

test('writeProjectManifest creates .claude directory if needed', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-write-'));
  const result = ManifestResolver.writeProjectManifest(tmpDir, {
    version: '1.0.0',
    tackleHarnessVersion: '0.1.0',
    plugins: {}
  });
  assert.strictEqual(result, true);
  assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'harness-manifest.json')));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('createDefaultManifest reflects global registry', () => {
  const pkg = createPackageRoot(CORE_PLUGINS);
  const manifest = ManifestResolver.createDefaultManifest(pkg.dir);
  assert.strictEqual(Object.keys(manifest.plugins).length, 3);
  assert.strictEqual(manifest.plugins['provider-state-store'].enabled, true);

  pkg.cleanup();
});
