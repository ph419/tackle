/**
 * Tests for plugins/runtime/settings-merger.js
 *
 * Covers isLocalInstall(), mergeSettings(), and upsertHookEntry().
 * Uses temp directories for file I/O tests.
 */

'use strict';

var { describe, it, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var merger = require('../../plugins/runtime/settings-merger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tackle-smtest-'));
}

function removeDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Create a fake package structure with hook scripts so mergeSettings can resolve paths.
 */
function createFakePackage(tmpDir) {
  var packageRoot = path.join(tmpDir, 'package');
  var coreDir = path.join(packageRoot, 'plugins', 'core');
  fs.mkdirSync(path.join(coreDir, 'hook-skill-gate'), { recursive: true });
  fs.mkdirSync(path.join(coreDir, 'hook-session-start'), { recursive: true });
  fs.writeFileSync(
    path.join(coreDir, 'hook-skill-gate', 'index.js'),
    'module.exports = {};', 'utf-8'
  );
  fs.writeFileSync(
    path.join(coreDir, 'hook-session-start', 'index.js'),
    'module.exports = {};', 'utf-8'
  );
  return packageRoot;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('settings-merger', function () {

  describe('isLocalInstall()', function () {
    it('should return true when packageRoot is ancestor of targetRoot (local install)', function () {
      var tmpDir = createTempDir();
      try {
        // packageRoot is an ancestor (parent) of targetRoot
        var packageRoot = tmpDir;
        var targetRoot = path.join(tmpDir, 'my-project');
        fs.mkdirSync(targetRoot, { recursive: true });
        assert.strictEqual(merger.isLocalInstall(packageRoot, targetRoot), true);
      } finally {
        removeDir(tmpDir);
      }
    });

    it('should return false when packageRoot is not ancestor of targetRoot (global install)', function () {
      var tmpDir1 = createTempDir();
      var tmpDir2 = createTempDir();
      try {
        // Two completely independent paths
        assert.strictEqual(merger.isLocalInstall(tmpDir1, tmpDir2), false);
      } finally {
        removeDir(tmpDir1);
        removeDir(tmpDir2);
      }
    });

    it('should return false when packageRoot is a child of targetRoot', function () {
      var tmpDir = createTempDir();
      try {
        var targetRoot = tmpDir;
        var packageRoot = path.join(tmpDir, 'node_modules', 'tackle-harness');
        fs.mkdirSync(packageRoot, { recursive: true });
        // packageRoot is deeper than targetRoot, so it is NOT an ancestor
        assert.strictEqual(merger.isLocalInstall(packageRoot, targetRoot), false);
      } finally {
        removeDir(tmpDir);
      }
    });
  });

  describe('upsertHookEntry()', function () {
    it('should insert a new entry when matcher does not exist', function () {
      var hooks = [];
      merger.upsertHookEntry(hooks, 'Edit|Write', 'node script.js --pre');
      assert.strictEqual(hooks.length, 1);
      assert.strictEqual(hooks[0].matcher, 'Edit|Write');
      assert.strictEqual(hooks[0].hooks[0].command, 'node script.js --pre');
      assert.strictEqual(hooks[0].hooks[0].type, 'command');
    });

    it('should update existing entry when matcher matches', function () {
      var hooks = [{
        matcher: 'Edit|Write',
        hooks: [{ type: 'command', command: 'old-command' }],
      }];
      merger.upsertHookEntry(hooks, 'Edit|Write', 'new-command');
      assert.strictEqual(hooks.length, 1); // no duplicate
      assert.strictEqual(hooks[0].hooks[0].command, 'new-command');
    });

    it('should not affect entries with different matchers', function () {
      var hooks = [{
        matcher: 'Skill',
        hooks: [{ type: 'command', command: 'skill-cmd' }],
      }];
      merger.upsertHookEntry(hooks, 'Edit|Write', 'edit-cmd');
      assert.strictEqual(hooks.length, 2);
      assert.strictEqual(hooks[0].matcher, 'Skill');
      assert.strictEqual(hooks[1].matcher, 'Edit|Write');
    });

    it('should handle multiple upserts to the same matcher idempotently', function () {
      var hooks = [];
      merger.upsertHookEntry(hooks, 'Test', 'cmd-v1');
      merger.upsertHookEntry(hooks, 'Test', 'cmd-v2');
      merger.upsertHookEntry(hooks, 'Test', 'cmd-v3');
      assert.strictEqual(hooks.length, 1);
      assert.strictEqual(hooks[0].hooks[0].command, 'cmd-v3');
    });
  });

  describe('mergeSettings()', function () {
    var tmpDir;
    var packageRoot;
    var targetRoot;

    beforeEach(function () {
      tmpDir = createTempDir();
      packageRoot = createFakePackage(tmpDir);
      targetRoot = path.join(tmpDir, 'project');
      fs.mkdirSync(targetRoot, { recursive: true });
    });

    afterEach(function () {
      removeDir(tmpDir);
    });

    function settingsPath() {
      return path.join(targetRoot, '.claude', 'settings.json');
    }

    it('should create settings.json when it does not exist', function () {
      merger.mergeSettings({
        targetRoot: targetRoot,
        packageRoot: packageRoot,
      });

      assert.ok(fs.existsSync(settingsPath()));
      var settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
      assert.ok(settings.hooks);
      assert.ok(settings.hooks.PreToolUse);
      assert.ok(settings.hooks.PostToolUse);
      assert.ok(settings.hooks.SessionStart);
    });

    it('should update settings.json when hooks already exist', function () {
      // Create initial settings
      var claudeDir = path.join(targetRoot, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Old', hooks: [{ type: 'command', command: 'old' }] }],
        },
      }, null, 2), 'utf-8');

      merger.mergeSettings({
        targetRoot: targetRoot,
        packageRoot: packageRoot,
      });

      var settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
      // Old hook should still be there
      var oldMatcher = settings.hooks.PreToolUse.find(function (h) { return h.matcher === 'Old'; });
      assert.ok(oldMatcher);
      // New tackle-harness hooks should be added
      var editMatcher = settings.hooks.PreToolUse.find(function (h) { return h.matcher === 'Edit|Write'; });
      assert.ok(editMatcher);
    });

    it('should not duplicate hooks on repeated calls (idempotent)', function () {
      merger.mergeSettings({
        targetRoot: targetRoot,
        packageRoot: packageRoot,
      });

      merger.mergeSettings({
        targetRoot: targetRoot,
        packageRoot: packageRoot,
      });

      var settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
      var editCount = settings.hooks.PreToolUse.filter(function (h) {
        return h.matcher === 'Edit|Write';
      }).length;
      assert.strictEqual(editCount, 1);
    });

    it('should use relative paths for local install', function () {
      // Create a separate temp dir as packageRoot, with targetRoot inside it
      var localTmpDir = createTempDir();
      try {
        var localPackageRoot = createFakePackage(localTmpDir);
        var localTarget = path.join(localTmpDir, 'my-project');
        fs.mkdirSync(localTarget, { recursive: true });

        // packageRoot's parent (localTmpDir) is ancestor of localTarget => local install
        // But packageRoot itself is localTmpDir/package which is a sibling to my-project,
        // so packageRoot is NOT an ancestor. We need to restructure.
        // Use localTmpDir directly as package root (create fake package at root level)
        var pkgRoot = localTmpDir;
        var coreDir = path.join(pkgRoot, 'plugins', 'core', 'hook-skill-gate');
        fs.mkdirSync(coreDir, { recursive: true });
        fs.writeFileSync(path.join(coreDir, 'index.js'), '', 'utf-8');
        var sessionDir = path.join(pkgRoot, 'plugins', 'core', 'hook-session-start');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'index.js'), '', 'utf-8');

        merger.mergeSettings({
          targetRoot: localTarget,
          packageRoot: pkgRoot,
        });

        var settingsPathLocal = path.join(localTarget, '.claude', 'settings.json');
        var settings = JSON.parse(fs.readFileSync(settingsPathLocal, 'utf-8'));
        var preHook = settings.hooks.PreToolUse[0];
        var cmd = preHook.hooks[0].command;
        assert.ok(cmd.indexOf('node "') === 0);
        // In local mode, the path should be relative (not an absolute path)
        var pathInCmd = cmd.replace('node "', '').replace(/".*$/, '');
        assert.ok(!path.isAbsolute(pathInCmd));
      } finally {
        removeDir(localTmpDir);
      }
    });

    it('should use absolute paths for global install', function () {
      var globalTmpDir = createTempDir();
      try {
        var globalPackageRoot = createFakePackage(globalTmpDir);
        var globalTargetRoot = path.join(tmpDir, 'other-project');
        fs.mkdirSync(globalTargetRoot, { recursive: true });

        merger.mergeSettings({
          targetRoot: globalTargetRoot,
          packageRoot: globalPackageRoot,
        });

        var settingsPathGlobal = path.join(globalTargetRoot, '.claude', 'settings.json');
        var settings = JSON.parse(fs.readFileSync(settingsPathGlobal, 'utf-8'));
        var preHook = settings.hooks.PreToolUse[0];
        var cmd = preHook.hooks[0].command;
        // Should contain absolute path
        var pathInCmd = cmd.replace('node "', '').replace(/".*$/, '');
        assert.ok(path.isAbsolute(pathInCmd));
      } finally {
        removeDir(globalTmpDir);
      }
    });

    // B3 回归：损坏的 settings.json 必须备份并中止，不得静默覆盖
    it('B3: 损坏 settings.json → 备份 + 抛错，原文件不被覆盖', function () {
      var claudeDir = path.join(targetRoot, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      var corruptContent = 'this is not valid json {';
      fs.writeFileSync(settingsPath(), corruptContent, 'utf-8');

      assert.throws(function () {
        merger.mergeSettings({
          targetRoot: targetRoot,
          packageRoot: packageRoot,
        });
      }, /解析失败/);

      // 原文件内容必须原样保留（未被覆盖）
      assert.strictEqual(fs.readFileSync(settingsPath(), 'utf-8'), corruptContent,
        '损坏的原文件不应被改写');
      // 应生成 .corrupt.<timestamp> 备份
      var entries = fs.readdirSync(claudeDir);
      var backups = entries.filter(function (n) { return n.indexOf('settings.json.corrupt.') === 0; });
      assert.ok(backups.length >= 1, '应生成 .corrupt 备份文件');
    });

    it('should preserve non-hook settings fields', function () {
      var claudeDir = path.join(targetRoot, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify({
        permissions: { allow: ['npm test'] },
        someOtherField: 'preserved',
      }, null, 2), 'utf-8');

      merger.mergeSettings({
        targetRoot: targetRoot,
        packageRoot: packageRoot,
      });

      var settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
      assert.strictEqual(settings.someOtherField, 'preserved');
      assert.deepStrictEqual(settings.permissions.allow, ['npm test']);
    });
  });
});
