/**
 * Unit tests for resolve-plugin-path
 * Run with: node --test test/runtime/test-resolve-plugin-path.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { resolvePluginPath, sourceEscapesRepoRoot } = require('../../plugins/runtime/resolve-plugin-path');

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

test.describe('resolvePluginPath - S3 path traversal rejection', () => {
  test('should reject core source that escapes the repo root via ../..', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    assert.throws(
      () => resolvePluginPath(
        { name: 'evil', source: '../../etc/passwd' },
        pluginsDir,
        registryDir
      ),
      /escapes the repository root/
    );
  });

  test('should reject local source that escapes the repo root via ../..', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    assert.throws(
      () => resolvePluginPath(
        { name: 'evil', source: '../../etc/passwd', sourceType: 'local' },
        pluginsDir,
        registryDir
      ),
      /escapes the repository root/
    );
  });

  test('should reject source that escapes to the parent of the repo root', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    // /project/plugins + ../.. = /project (one level above repo root /project if root were /project/plugins)
    // The repo root is path.resolve(registryDir, '..') = /project/plugins.
    // ../../foo from /project/plugins → /foo which escapes.
    assert.throws(
      () => resolvePluginPath(
        { name: 'evil', source: '../foo/../../../etc' },
        pluginsDir,
        registryDir
      ),
      /escapes the repository root/
    );
  });

  test('should still allow legitimate sibling-directory relative paths', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    // A sibling dir under the repo root (parent of registryDir) is allowed.
    const result = resolvePluginPath(
      { name: 'ok', source: '../custom-plugins/my-plugin' },
      pluginsDir,
      registryDir
    );
    // Should resolve to /project/custom-plugins/my-plugin (within repo root /project/plugins/../)
    assert.strictEqual(result, path.resolve(registryDir, '../custom-plugins/my-plugin'));
  });

  test('should allow absolute path even outside the repo root (opt-in)', () => {
    const pluginsDir = '/project/plugins/core';
    const registryDir = '/project/plugins';
    const absPath = path.resolve('/external/somewhere/my-plugin');
    const result = resolvePluginPath(
      { name: 'ok', source: absPath, sourceType: 'local' },
      pluginsDir,
      registryDir
    );
    assert.strictEqual(result, absPath);
  });

  test('should reject Windows-style .. escapes', () => {
    const pluginsDir = 'C:\\project\\plugins\\core';
    const registryDir = 'C:\\project\\plugins';
    assert.throws(
      () => resolvePluginPath(
        { name: 'evil', source: '..\\..\\Windows\\System32' },
        pluginsDir,
        registryDir
      ),
      /escapes the repository root/
    );
  });
});

test.describe('sourceEscapesRepoRoot - 字面层穿越守卫（跨平台纯函数）', () => {
  // 直接单测字面层守卫，不依赖 path.resolve 的平台行为：Windows 主机上
  // path.resolve 认识反斜杠，会由 assertWithinRepo 兜底通过，从而掩盖本函数的
  // 语义回归（这正是「Windows 本地绿、POSIX CI 红」盲区的成因），故必须独立覆盖。
  test('同级目录相对路径不逃逸', () => {
    assert.strictEqual(sourceEscapesRepoRoot('../custom-plugins/my-plugin'), false);
  });

  test('上爬一级到 repoRoot 边界不逃逸', () => {
    assert.strictEqual(sourceEscapesRepoRoot('..'), false);
    assert.strictEqual(sourceEscapesRepoRoot('../'), false);
  });

  test('上爬超过 repoRoot 即逃逸', () => {
    assert.strictEqual(sourceEscapesRepoRoot('../../etc/passwd'), true);
    assert.strictEqual(sourceEscapesRepoRoot('../foo/../../../etc'), true);
  });

  test('Windows 风格 .. 逃逸（POSIX 主机关键用例，净深度盲点）', () => {
    // 先上爬出 repoRoot 再下钻：后续 Windows/System32 段不能抵消已经发生的逃逸。
    assert.strictEqual(sourceEscapesRepoRoot('..\\..\\Windows\\System32'), true);
    assert.strictEqual(sourceEscapesRepoRoot('..\\..\\..\\etc'), true);
  });

  test('先上爬再下钻回 repoRoot 之内仍判逃逸（保守安全语义）', () => {
    // `../../a/b` 已把路径带到 repoRoot 之上，最终落在 repoRoot 之外，故仍逃逸。
    assert.strictEqual(sourceEscapesRepoRoot('../../a/b'), true);
  });

  test('纯下钻不逃逸', () => {
    assert.strictEqual(sourceEscapesRepoRoot('foo/bar'), false);
    assert.strictEqual(sourceEscapesRepoRoot('foo\\bar\\baz'), false);
  });

  test('空/非字符串输入不逃逸', () => {
    assert.strictEqual(sourceEscapesRepoRoot(''), false);
    assert.strictEqual(sourceEscapesRepoRoot(null), false);
    assert.strictEqual(sourceEscapesRepoRoot(undefined), false);
  });
});

