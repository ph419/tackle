/**
 * WP-169-2: Unit tests for cleanup-utils shared module
 *
 * Tests cover all 6 exported functions:
 * - isLegacyLocalHook
 * - getHookNamesFromRegistry
 * - cleanupSettingsHooks
 * - cleanupProjectSkills
 * - cleanupProjectHooks
 * - removeEmptyDir
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var fs = require('fs');
var os = require('os');

var cleanupUtils = require('../../plugins/runtime/cleanup-utils');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary package structure with plugin registry and core plugin dirs.
 * Returns an object with paths and a cleanup function.
 */
function createTestPackage(options) {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tackle-cleanup-test-'));

  var packageRoot = tmpDir;
  var pluginsCoreDir = path.join(packageRoot, 'plugins', 'core');
  fs.mkdirSync(pluginsCoreDir, { recursive: true });

  // Create plugin registry
  var registryPath = path.join(packageRoot, 'plugins', 'plugin-registry.json');
  var registry = {
    version: '1.0.0',
    plugins: (options.plugins || []).map(function (p) {
      return {
        name: p.name,
        source: p.source || p.name,
        enabled: p.enabled !== false,
        config: p.config || {},
      };
    }),
  };
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');

  // Create core plugin directories with plugin.json
  var corePlugins = options.corePlugins || [];
  for (var i = 0; i < corePlugins.length; i++) {
    var cp = corePlugins[i];
    var cpDir = path.join(pluginsCoreDir, cp.source || cp.name);
    fs.mkdirSync(cpDir, { recursive: true });
    fs.writeFileSync(
      path.join(cpDir, 'plugin.json'),
      JSON.stringify(cp, null, 2),
      'utf-8'
    );
  }

  // Optionally create project-level directories
  var projectRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });

  return {
    tmpDir: tmpDir,
    packageRoot: packageRoot,
    registryPath: registryPath,
    projectRoot: projectRoot,
    claudeDir: path.join(projectRoot, '.claude'),
    skillsDir: path.join(projectRoot, '.claude', 'skills'),
    hooksDir: path.join(projectRoot, '.claude', 'hooks'),
    cleanup: function () {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// isLegacyLocalHook
// ---------------------------------------------------------------------------

test.describe('isLegacyLocalHook', function () {

  test('should return true for relative path with ../', function () {
    assert.strictEqual(
      cleanupUtils.isLegacyLocalHook('node "../plugins/core/hook-skill-gate/index.js"'),
      true
    );
  });

  test('should return true for relative path with ..\\ (Windows)', function () {
    assert.strictEqual(
      cleanupUtils.isLegacyLocalHook('node "..\\plugins\\core\\hook-skill-gate\\index.js"'),
      true
    );
  });

  test('should return false for null/undefined/empty', function () {
    assert.strictEqual(cleanupUtils.isLegacyLocalHook(null), false);
    assert.strictEqual(cleanupUtils.isLegacyLocalHook(undefined), false);
    assert.strictEqual(cleanupUtils.isLegacyLocalHook(''), false);
  });

  test('should return false for Linux global install path', function () {
    assert.strictEqual(
      cleanupUtils.isLegacyLocalHook('node "/usr/lib/node_modules/tackle-harness/plugins/core/hook-skill-gate/index.js" --pre-tool'),
      false
    );
  });

  test('should return false for macOS global install path', function () {
    assert.strictEqual(
      cleanupUtils.isLegacyLocalHook('node "/usr/local/lib/node_modules/tackle-harness/plugins/core/hook-skill-gate/index.js"'),
      false
    );
  });

  test('should return false for Windows absolute path with drive letter', function () {
    assert.strictEqual(
      cleanupUtils.isLegacyLocalHook('node "C:/Users/dev/AppData/Roaming/npm/node_modules/tackle-harness/plugins/core/hook-skill-gate/index.js"'),
      false
    );
  });

  test('should return false for path with ./ prefix', function () {
    assert.strictEqual(
      cleanupUtils.isLegacyLocalHook('node "./hooks/my-hook/index.js"'),
      false
    );
  });

  test('should return true for node command without drive letter or slash or dot', function () {
    // Edge case: "node " prefix but no drive letter, no ./, no /, has relative content
    assert.strictEqual(
      cleanupUtils.isLegacyLocalHook('node "something/relative/index.js"'),
      true
    );
  });

});

// ---------------------------------------------------------------------------
// getHookNamesFromRegistry
// ---------------------------------------------------------------------------

test.describe('getHookNamesFromRegistry', function () {

  test('should return hook names from valid registry', function () {
    var pkg = createTestPackage({
      corePlugins: [
        { name: 'hook-skill-gate', version: '1.0.0', type: 'hook', description: 'Skill gate' },
        { name: 'hook-session-start', version: '1.0.0', type: 'hook', description: 'Session start' },
      ],
      plugins: [
        { name: 'hook-skill-gate' },
        { name: 'hook-session-start' },
      ],
    });

    try {
      var hooks = cleanupUtils.getHookNamesFromRegistry(pkg.registryPath, pkg.packageRoot);
      assert.ok(Array.isArray(hooks));
      assert.ok(hooks.indexOf('hook-skill-gate') !== -1, 'should include hook-skill-gate');
      assert.ok(hooks.indexOf('hook-session-start') !== -1, 'should include hook-session-start');
    } finally {
      pkg.cleanup();
    }
  });

  test('should return empty array for empty registry', function () {
    var pkg = createTestPackage({
      corePlugins: [],
      plugins: [],
    });

    try {
      var hooks = cleanupUtils.getHookNamesFromRegistry(pkg.registryPath, pkg.packageRoot);
      assert.ok(Array.isArray(hooks));
      assert.strictEqual(hooks.length, 0);
    } finally {
      pkg.cleanup();
    }
  });

  test('should return empty array for missing registry file', function () {
    var pkg = createTestPackage({ corePlugins: [], plugins: [] });
    fs.unlinkSync(pkg.registryPath);

    try {
      var hooks = cleanupUtils.getHookNamesFromRegistry(pkg.registryPath, pkg.packageRoot);
      assert.ok(Array.isArray(hooks));
      assert.strictEqual(hooks.length, 0);
    } finally {
      pkg.cleanup();
    }
  });

  test('should filter out non-hook plugin types', function () {
    var pkg = createTestPackage({
      corePlugins: [
        { name: 'hook-skill-gate', version: '1.0.0', type: 'hook', description: 'Hook' },
        { name: 'skill-task-creator', version: '1.0.0', type: 'skill', description: 'Skill' },
        { name: 'provider-state-store', version: '1.0.0', type: 'provider', description: 'Provider' },
      ],
      plugins: [
        { name: 'hook-skill-gate' },
        { name: 'skill-task-creator' },
        { name: 'provider-state-store' },
      ],
    });

    try {
      var hooks = cleanupUtils.getHookNamesFromRegistry(pkg.registryPath, pkg.packageRoot);
      assert.strictEqual(hooks.length, 1);
      assert.strictEqual(hooks[0], 'hook-skill-gate');
    } finally {
      pkg.cleanup();
    }
  });

  test('should skip plugins with missing plugin.json', function () {
    var pkg = createTestPackage({
      corePlugins: [
        { name: 'hook-skill-gate', version: '1.0.0', type: 'hook', description: 'Hook' },
      ],
      plugins: [
        { name: 'hook-skill-gate' },
        { name: 'hook-missing-no-dir' },
      ],
    });

    try {
      var hooks = cleanupUtils.getHookNamesFromRegistry(pkg.registryPath, pkg.packageRoot);
      assert.strictEqual(hooks.length, 1);
      assert.strictEqual(hooks[0], 'hook-skill-gate');
    } finally {
      pkg.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// cleanupSettingsHooks
// ---------------------------------------------------------------------------

test.describe('cleanupSettingsHooks', function () {

  test('should remove legacy PreToolUse hooks with Edit|Write matcher', function () {
    var settings = {
      hooks: {
        PreToolUse: [{
          matcher: 'Edit|Write',
          hooks: [{ command: 'node "../plugins/core/hook-skill-gate/index.js"' }],
        }],
      },
    };

    var result = cleanupUtils.cleanupSettingsHooks(settings);
    assert.strictEqual(result.hadProjectHooks, true);
    assert.strictEqual(result.settings.hooks.PreToolUse.length, 0);
  });

  test('should remove legacy PostToolUse hooks with Skill matcher', function () {
    var settings = {
      hooks: {
        PostToolUse: [{
          matcher: 'Skill',
          hooks: [{ command: 'node "../plugins/core/hook-skill-gate/index.js"' }],
        }],
      },
    };

    var result = cleanupUtils.cleanupSettingsHooks(settings);
    assert.strictEqual(result.hadProjectHooks, true);
    assert.strictEqual(result.settings.hooks.PostToolUse.length, 0);
  });

  test('should remove legacy SessionStart hooks with startup|clear|compact matcher', function () {
    var settings = {
      hooks: {
        SessionStart: [{
          matcher: 'startup|clear|compact',
          hooks: [{ command: 'node "../plugins/core/hook-session-start/index.js"' }],
        }],
      },
    };

    var result = cleanupUtils.cleanupSettingsHooks(settings);
    assert.strictEqual(result.hadProjectHooks, true);
    assert.strictEqual(result.settings.hooks.SessionStart.length, 0);
  });

  test('should preserve non-legacy hooks', function () {
    var settings = {
      hooks: {
        PreToolUse: [{
          matcher: 'Edit|Write',
          hooks: [{ command: 'node "C:/global/tackle-hook.js"' }],
        }],
        PostToolUse: [{
          matcher: 'Skill',
          hooks: [{ command: 'node "/usr/lib/node_modules/tackle-harness/hook.js"' }],
        }],
      },
    };

    var result = cleanupUtils.cleanupSettingsHooks(settings);
    assert.strictEqual(result.hadProjectHooks, false);
    assert.strictEqual(result.settings.hooks.PreToolUse.length, 1);
    assert.strictEqual(result.settings.hooks.PostToolUse.length, 1);
  });

  test('should handle settings with no hooks property', function () {
    var settings = { permissions: { allow: ['Bash(git status)'] } };
    var result = cleanupUtils.cleanupSettingsHooks(settings);
    assert.strictEqual(result.hadProjectHooks, false);
    assert.ok(result.settings.permissions);
  });

  test('should handle settings with empty hook arrays', function () {
    var settings = {
      hooks: {
        PreToolUse: [],
        PostToolUse: [],
        SessionStart: [],
      },
    };
    var result = cleanupUtils.cleanupSettingsHooks(settings);
    assert.strictEqual(result.hadProjectHooks, false);
  });

});

// ---------------------------------------------------------------------------
// cleanupProjectSkills
// ---------------------------------------------------------------------------

test.describe('cleanupProjectSkills', function () {

  test('should remove skills registered in plugin registry', function () {
    var pkg = createTestPackage({
      corePlugins: [
        { name: 'skill-task-creator', version: '1.0.0', type: 'skill', description: 'Task creator' },
      ],
      plugins: [
        { name: 'skill-task-creator' },
      ],
    });

    try {
      // Create project-level skill directories
      fs.mkdirSync(path.join(pkg.skillsDir, 'skill-task-creator'), { recursive: true });
      fs.writeFileSync(
        path.join(pkg.skillsDir, 'skill-task-creator', 'skill.md'),
        '# skill-task-creator\n',
        'utf-8'
      );

      var removed = cleanupUtils.cleanupProjectSkills(pkg.skillsDir, pkg.registryPath, pkg.packageRoot);
      assert.strictEqual(removed.length, 1);
      assert.strictEqual(removed[0], 'skill-task-creator');
      assert.strictEqual(fs.existsSync(path.join(pkg.skillsDir, 'skill-task-creator')), false);
    } finally {
      pkg.cleanup();
    }
  });

  test('should preserve skills not in registry', function () {
    var pkg = createTestPackage({
      corePlugins: [
        { name: 'skill-task-creator', version: '1.0.0', type: 'skill', description: 'Task creator' },
      ],
      plugins: [
        { name: 'skill-task-creator' },
      ],
    });

    try {
      fs.mkdirSync(path.join(pkg.skillsDir, 'my-custom-skill'), { recursive: true });
      fs.writeFileSync(
        path.join(pkg.skillsDir, 'my-custom-skill', 'skill.md'),
        '# my-custom-skill\n',
        'utf-8'
      );

      var removed = cleanupUtils.cleanupProjectSkills(pkg.skillsDir, pkg.registryPath, pkg.packageRoot);
      assert.strictEqual(removed.length, 0);
      assert.strictEqual(fs.existsSync(path.join(pkg.skillsDir, 'my-custom-skill')), true);
    } finally {
      pkg.cleanup();
    }
  });

  test('should return empty array when skills directory does not exist', function () {
    var pkg = createTestPackage({ corePlugins: [], plugins: [] });
    try {
      var removed = cleanupUtils.cleanupProjectSkills('/nonexistent/path', pkg.registryPath, pkg.packageRoot);
      assert.ok(Array.isArray(removed));
      assert.strictEqual(removed.length, 0);
    } finally {
      pkg.cleanup();
    }
  });

  test('should handle missing registry gracefully', function () {
    var pkg = createTestPackage({ corePlugins: [], plugins: [] });
    fs.unlinkSync(pkg.registryPath);

    try {
      fs.mkdirSync(pkg.skillsDir, { recursive: true });
      var removed = cleanupUtils.cleanupProjectSkills(pkg.skillsDir, pkg.registryPath, pkg.packageRoot);
      assert.ok(Array.isArray(removed));
      assert.strictEqual(removed.length, 0);
    } finally {
      pkg.cleanup();
    }
  });

  test('should match skill by short name (without skill- prefix)', function () {
    var pkg = createTestPackage({
      corePlugins: [
        { name: 'skill-task-creator', version: '1.0.0', type: 'skill', description: 'Task creator' },
      ],
      plugins: [
        { name: 'skill-task-creator' },
      ],
    });

    try {
      // Project skill directory uses short name
      fs.mkdirSync(path.join(pkg.skillsDir, 'task-creator'), { recursive: true });
      fs.writeFileSync(
        path.join(pkg.skillsDir, 'task-creator', 'skill.md'),
        '# task-creator\n',
        'utf-8'
      );

      var removed = cleanupUtils.cleanupProjectSkills(pkg.skillsDir, pkg.registryPath, pkg.packageRoot);
      assert.strictEqual(removed.length, 1);
      assert.strictEqual(removed[0], 'task-creator');
    } finally {
      pkg.cleanup();
    }
  });

  // S5 回归：skills 目录下的符号链接不应被递归删除（避免误删链接目标）
  test('S5: 不删除符号链接 skill（保护链接目标）', function () {
    var pkg = createTestPackage({
      corePlugins: [
        { name: 'skill-task-creator', version: '1.0.0', type: 'skill', description: 'Task creator' },
      ],
      plugins: [
        { name: 'skill-task-creator' },
      ],
    });

    try {
      // 创建一个真实目录作为符号链接的目标，里面放重要文件
      var preciousDir = path.join(pkg.tmpDir, 'precious');
      fs.mkdirSync(preciousDir, { recursive: true });
      fs.writeFileSync(path.join(preciousDir, 'important.txt'), 'DO NOT DELETE');

      // 尝试在 skills 目录下建符号链接 skill-task-creator → precious
      var linkPath = path.join(pkg.skillsDir, 'skill-task-creator');
      try {
        fs.symlinkSync(preciousDir, linkPath, 'dir');
      } catch (_e) {
        // 无权限建符号链接（部分 CI / 无特权 Windows）→ 跳过该断言
        return;
      }

      var removed = cleanupUtils.cleanupProjectSkills(pkg.skillsDir, pkg.registryPath, pkg.packageRoot);
      // 关键：不应把符号链接当作可清理项
      assert.strictEqual(removed.length, 0, '符号链接 skill 不应被清理');
      // 链接目标内容必须完好
      assert.strictEqual(fs.existsSync(path.join(preciousDir, 'important.txt')), true, '符号链接目标必须保留');
      assert.strictEqual(fs.readFileSync(path.join(preciousDir, 'important.txt'), 'utf-8'), 'DO NOT DELETE');
    } finally {
      pkg.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// cleanupProjectHooks
// ---------------------------------------------------------------------------

test.describe('cleanupProjectHooks', function () {

  test('should remove hook directories from registry', function () {
    var pkg = createTestPackage({
      corePlugins: [
        { name: 'hook-skill-gate', version: '1.0.0', type: 'hook', description: 'Skill gate' },
        { name: 'hook-session-start', version: '1.0.0', type: 'hook', description: 'Session start' },
      ],
      plugins: [
        { name: 'hook-skill-gate' },
        { name: 'hook-session-start' },
      ],
    });

    try {
      fs.mkdirSync(path.join(pkg.hooksDir, 'hook-skill-gate'), { recursive: true });
      fs.mkdirSync(path.join(pkg.hooksDir, 'hook-session-start'), { recursive: true });

      var removed = cleanupUtils.cleanupProjectHooks(pkg.hooksDir, pkg.registryPath, pkg.packageRoot);
      assert.strictEqual(removed.length, 2);
      assert.ok(removed.indexOf('hook-skill-gate') !== -1);
      assert.ok(removed.indexOf('hook-session-start') !== -1);
      assert.strictEqual(fs.existsSync(path.join(pkg.hooksDir, 'hook-skill-gate')), false);
      assert.strictEqual(fs.existsSync(path.join(pkg.hooksDir, 'hook-session-start')), false);
    } finally {
      pkg.cleanup();
    }
  });

  test('should preserve non-registered hook directories', function () {
    var pkg = createTestPackage({
      corePlugins: [
        { name: 'hook-skill-gate', version: '1.0.0', type: 'hook', description: 'Skill gate' },
      ],
      plugins: [
        { name: 'hook-skill-gate' },
      ],
    });

    try {
      fs.mkdirSync(path.join(pkg.hooksDir, 'hook-skill-gate'), { recursive: true });
      fs.mkdirSync(path.join(pkg.hooksDir, 'my-custom-hook'), { recursive: true });

      var removed = cleanupUtils.cleanupProjectHooks(pkg.hooksDir, pkg.registryPath, pkg.packageRoot);
      assert.strictEqual(removed.length, 1);
      assert.strictEqual(removed[0], 'hook-skill-gate');
      assert.strictEqual(fs.existsSync(path.join(pkg.hooksDir, 'my-custom-hook')), true);
    } finally {
      pkg.cleanup();
    }
  });

  test('should return empty array when hooks directory does not exist', function () {
    var pkg = createTestPackage({ corePlugins: [], plugins: [] });
    try {
      var removed = cleanupUtils.cleanupProjectHooks('/nonexistent/path', pkg.registryPath, pkg.packageRoot);
      assert.ok(Array.isArray(removed));
      assert.strictEqual(removed.length, 0);
    } finally {
      pkg.cleanup();
    }
  });

  test('should handle empty registry gracefully', function () {
    var pkg = createTestPackage({ corePlugins: [], plugins: [] });
    try {
      fs.mkdirSync(path.join(pkg.hooksDir, 'some-hook'), { recursive: true });
      var removed = cleanupUtils.cleanupProjectHooks(pkg.hooksDir, pkg.registryPath, pkg.packageRoot);
      assert.ok(Array.isArray(removed));
      assert.strictEqual(removed.length, 0);
      assert.strictEqual(fs.existsSync(path.join(pkg.hooksDir, 'some-hook')), true);
    } finally {
      pkg.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// removeEmptyDir
// ---------------------------------------------------------------------------

test.describe('removeEmptyDir', function () {

  test('should remove empty directory and return true', function () {
    var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tackle-rmdir-test-'));
    var emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir);

    try {
      var result = cleanupUtils.removeEmptyDir(emptyDir);
      assert.strictEqual(result, true);
      assert.strictEqual(fs.existsSync(emptyDir), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('should not remove non-empty directory and return false', function () {
    var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tackle-rmdir-test-'));
    var nonEmptyDir = path.join(tmpDir, 'nonempty');
    fs.mkdirSync(nonEmptyDir);
    fs.writeFileSync(path.join(nonEmptyDir, 'file.txt'), 'content', 'utf-8');

    try {
      var result = cleanupUtils.removeEmptyDir(nonEmptyDir);
      assert.strictEqual(result, false);
      assert.strictEqual(fs.existsSync(nonEmptyDir), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('should return false for non-existent directory', function () {
    var result = cleanupUtils.removeEmptyDir('/nonexistent/path/to/dir');
    assert.strictEqual(result, false);
  });

});
