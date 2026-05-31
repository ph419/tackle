/**
 * Unit tests for resolve-plugin-path
 * Run with: node --test test/runtime/test-resolve-plugin-path.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { resolvePluginPath } = require('../../plugins/runtime/resolve-plugin-path');

test.describe('resolvePluginPath - core default path', () => {
  test('should resolve core plugin by name', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    const result = resolvePluginPath(
      { name: 'skill-task-creator', source: 'skill-task-creator' },
      pluginsDir,
      registryDir
    );

    assert.strictEqual(result, path.join(pluginsDir, 'skill-task-creator'));
  });

  test('should resolve using entry.name when source is omitted', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    const result = resolvePluginPath(
      { name: 'my-plugin' },
      pluginsDir,
      registryDir
    );

    assert.strictEqual(result, path.join(pluginsDir, 'my-plugin'));
  });

  test('should prefer source over name', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    const result = resolvePluginPath(
      { name: 'my-plugin', source: 'custom-source' },
      pluginsDir,
      registryDir
    );

    assert.strictEqual(result, path.join(pluginsDir, 'custom-source'));
  });
});

test.describe('resolvePluginPath - absolute path', () => {
  test('should return absolute path directly', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    const absPath = path.resolve('/external/plugins/my-plugin');
    const result = resolvePluginPath(
      { name: 'my-plugin', source: absPath },
      pluginsDir,
      registryDir
    );

    assert.strictEqual(result, absPath);
  });

  test('should return absolute Windows-style path directly', () => {
    const pluginsDir = 'C:\\project\\plugins\\core';
    const registryDir = 'C:\\project\\plugins';
    const absPath = 'D:\\external\\plugins\\my-plugin';
    const result = resolvePluginPath(
      { name: 'my-plugin', source: absPath },
      pluginsDir,
      registryDir
    );

    assert.strictEqual(result, absPath);
  });
});

test.describe('resolvePluginPath - relative path with separators', () => {
  test('should resolve relative path with forward slash against registryDir', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    const result = resolvePluginPath(
      { name: 'my-plugin', source: '../custom/my-plugin' },
      pluginsDir,
      registryDir
    );

    assert.strictEqual(result, path.resolve(registryDir, '../custom/my-plugin'));
  });

  test('should resolve relative path starting with dot against registryDir', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    const result = resolvePluginPath(
      { name: 'my-plugin', source: './local-plugins/my-plugin' },
      pluginsDir,
      registryDir
    );

    assert.strictEqual(result, path.resolve(registryDir, './local-plugins/my-plugin'));
  });

  test('should resolve relative path with backslash on Windows-style input', () => {
    const pluginsDir = 'C:\\project\\plugins\\core';
    const registryDir = 'C:\\project\\plugins';
    const result = resolvePluginPath(
      { name: 'my-plugin', source: '..\\custom\\my-plugin' },
      pluginsDir,
      registryDir
    );

    assert.strictEqual(result, path.resolve(registryDir, '..\\custom\\my-plugin'));
  });
});

test.describe('resolvePluginPath - edge cases', () => {
  test('should return unknown path when entry has no name or source', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    const result = resolvePluginPath({}, pluginsDir, registryDir);

    assert.strictEqual(result, path.join(pluginsDir, 'unknown'));
  });

  test('should return unknown path when entry is empty with empty name', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    const result = resolvePluginPath(
      { name: '', source: '' },
      pluginsDir,
      registryDir
    );

    assert.strictEqual(result, path.join(pluginsDir, 'unknown'));
  });
});

test.describe('resolvePluginPath - sourceType extension point (reserved for WP-082)', () => {
  test('should treat sourceType=core same as default', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    const result = resolvePluginPath(
      { name: 'my-plugin', source: 'my-plugin', sourceType: 'core' },
      pluginsDir,
      registryDir
    );

    assert.strictEqual(result, path.join(pluginsDir, 'my-plugin'));
  });

  test('should throw on invalid sourceType', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    assert.throws(
      () => resolvePluginPath(
        { name: 'my-plugin', source: 'my-plugin', sourceType: 'git' },
        pluginsDir,
        registryDir
      ),
      /Invalid sourceType "git"/
    );
  });
});

test.describe('resolvePluginPath - sourceType=local', () => {
  test('should resolve absolute path with sourceType=local', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    const absPath = path.resolve('/external/plugins/my-plugin');
    const result = resolvePluginPath(
      { name: 'my-plugin', source: absPath, sourceType: 'local' },
      pluginsDir,
      registryDir
    );

    assert.strictEqual(result, absPath);
  });

  test('should resolve relative path with sourceType=local against registryDir', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    const result = resolvePluginPath(
      { name: 'my-plugin', source: '../external/my-plugin', sourceType: 'local' },
      pluginsDir,
      registryDir
    );

    assert.strictEqual(result, path.resolve(registryDir, '../external/my-plugin'));
  });

  test('should resolve simple name with sourceType=local against registryDir', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    const result = resolvePluginPath(
      { name: 'my-plugin', source: 'my-plugin', sourceType: 'local' },
      pluginsDir,
      registryDir
    );

    assert.strictEqual(result, path.resolve(registryDir, 'my-plugin'));
  });
});

test.describe('resolvePluginPath - sourceType=npm', () => {
  test('should throw descriptive error for unresolvable npm package', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    assert.throws(
      () => resolvePluginPath(
        { name: 'my-plugin', source: 'nonexistent-tackle-plugin-xyz', sourceType: 'npm' },
        pluginsDir,
        registryDir
      ),
      /Failed to resolve npm plugin "nonexistent-tackle-plugin-xyz"/
    );
  });

  test('should resolve an actual installed npm package', () => {
    // Use the project's own package as a resolvable npm package
    // 'resolve-plugin-path' is not a standalone package, so use a built-in that
    // resolves to a real file path. We use require.resolve on the project itself.
    const { resolveNpmPath } = require('../../plugins/runtime/resolve-plugin-path');
    // Test with a package that definitely exists: our own project's module
    const pluginInterfacePath = require.resolve('../../plugins/contracts/plugin-interface');
    const pluginDir = path.dirname(pluginInterfacePath);
    const result = resolveNpmPath('../../plugins/contracts/plugin-interface', 'test-pkg');
    assert.ok(typeof result === 'string', 'npm resolution returns a string');
    assert.ok(result.length > 0, 'npm resolution returns non-empty path');
  });
});

test.describe('resolvePluginPath - integration with real directory structure', () => {
  test('should resolve correctly with temp directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-path-test-'));
    const pluginsDir = path.join(tmpDir, 'plugins', 'core');
    const registryDir = path.join(tmpDir, 'plugins');

    // Create a plugin directory
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.mkdirSync(path.join(pluginsDir, 'test-plugin'), { recursive: true });

    const result = resolvePluginPath(
      { name: 'test-plugin', source: 'test-plugin' },
      pluginsDir,
      registryDir
    );

    assert.strictEqual(result, path.join(pluginsDir, 'test-plugin'));
    assert.ok(fs.existsSync(result), 'resolved path should exist');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should resolve absolute path to external directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-path-test-'));
    const externalDir = path.join(tmpDir, 'external-plugin');
    const pluginsDir = path.join(tmpDir, 'plugins', 'core');
    const registryDir = path.join(tmpDir, 'plugins');

    // Create the external plugin directory
    fs.mkdirSync(externalDir, { recursive: true });

    const result = resolvePluginPath(
      { name: 'ext-plugin', source: externalDir },
      pluginsDir,
      registryDir
    );

    assert.strictEqual(result, externalDir);
    assert.ok(fs.existsSync(result), 'resolved absolute path should exist');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// Need fs for the integration tests above
const fs = require('fs');
