/**
 * Tests for plugins/runtime/claude-md-injector.js
 *
 * Covers buildRuleBlock(), injectClaudeMdRules(), and CLAUDE_MD_MARKER.
 * Uses temp directories for file I/O tests.
 */

'use strict';

var { describe, it, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var injector = require('../../plugins/runtime/claude-md-injector');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory with a provided structure.
 * @param {object} structure - { 'file.txt': 'content', 'sub/': null }
 * @returns {string} temp dir path
 */
function createTempDir(structure) {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tackle-test-'));
  var keys = Object.keys(structure);
  for (var i = 0; i < keys.length; i++) {
    var rel = keys[i];
    var fullPath = path.join(tmpDir, rel);
    if (rel.endsWith('/')) {
      fs.mkdirSync(fullPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, structure[rel], 'utf-8');
    }
  }
  return tmpDir;
}

function removeDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('claude-md-injector', function () {

  describe('CLAUDE_MD_MARKER', function () {
    it('should be a non-empty HTML comment string', function () {
      assert.ok(injector.CLAUDE_MD_MARKER.length > 0);
      assert.ok(injector.CLAUDE_MD_MARKER.indexOf('<!--') === 0);
      assert.ok(injector.CLAUDE_MD_MARKER.indexOf('-->') === injector.CLAUDE_MD_MARKER.length - 3);
    });

    it('should contain "tackle-harness" in the marker text', function () {
      assert.ok(injector.CLAUDE_MD_MARKER.indexOf('tackle-harness') !== -1);
    });
  });

  describe('buildRuleBlock()', function () {
    var tmpDir;

    beforeEach(function () {
      tmpDir = createTempDir({});
    });

    afterEach(function () {
      removeDir(tmpDir);
    });

    it('should return empty string when no plan_mode_required skills exist', function () {
      var entries = [
        { name: 'skill-a', dir: 'a' },
      ];
      // Create plugin without plan_mode_required
      var skillDir = path.join(tmpDir, 'a');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'plugin.json'), JSON.stringify({
        name: 'skill-a', version: '1.0.0', type: 'skill', description: 'test',
      }), 'utf-8');
      fs.writeFileSync(path.join(skillDir, 'skill.md'), '# Skill A\nNo plan mode.', 'utf-8');

      var result = injector.buildRuleBlock(entries, function (entry) {
        return path.join(tmpDir, entry.dir);
      });
      assert.strictEqual(result, '');
    });

    it('should generate rule block when plan_mode_required is in plugin.json config', function () {
      var entries = [
        { name: 'skill-plan', dir: 'plan-skill' },
      ];
      var skillDir = path.join(tmpDir, 'plan-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'plugin.json'), JSON.stringify({
        name: 'skill-plan', version: '1.0.0', type: 'skill', description: 'test',
        config: { plan_mode_required: true },
      }), 'utf-8');

      var result = injector.buildRuleBlock(entries, function (entry) {
        return path.join(tmpDir, entry.dir);
      });
      assert.ok(result.length > 0);
      assert.ok(result.indexOf('skill-plan') !== -1);
      assert.ok(result.indexOf(injector.CLAUDE_MD_MARKER) !== -1);
      assert.ok(result.indexOf('EnterPlanMode') !== -1);
    });

    it('should detect plan_mode_required in skill.md front-matter', function () {
      var entries = [
        { name: 'skill-fm', dir: 'fm-skill' },
      ];
      var skillDir = path.join(tmpDir, 'fm-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'plugin.json'), JSON.stringify({
        name: 'skill-fm', version: '1.0.0', type: 'skill', description: 'test',
      }), 'utf-8');
      fs.writeFileSync(path.join(skillDir, 'skill.md'),
        '---\nplan_mode_required: true\n---\n# Skill\n', 'utf-8');

      var result = injector.buildRuleBlock(entries, function (entry) {
        return path.join(tmpDir, entry.dir);
      });
      assert.ok(result.length > 0);
      assert.ok(result.indexOf('skill-fm') !== -1);
    });

    it('should skip entries with missing plugin.json', function () {
      var entries = [
        { name: 'missing', dir: 'no-json' },
        { name: 'skill-plan', dir: 'plan-skill' },
      ];
      // Only create the second one
      var skillDir = path.join(tmpDir, 'plan-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'plugin.json'), JSON.stringify({
        name: 'skill-plan', version: '1.0.0', type: 'skill', description: 'test',
        config: { plan_mode_required: true },
      }), 'utf-8');

      var result = injector.buildRuleBlock(entries, function (entry) {
        return path.join(tmpDir, entry.dir);
      });
      assert.ok(result.length > 0);
      assert.ok(result.indexOf('skill-plan') !== -1);
      assert.ok(result.indexOf('missing') === -1);
    });

    it('should skip entries where plugin.json has invalid JSON', function () {
      var entries = [
        { name: 'broken', dir: 'bad-json' },
      ];
      var skillDir = path.join(tmpDir, 'bad-json');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'plugin.json'), '{ invalid json !!!', 'utf-8');

      var result = injector.buildRuleBlock(entries, function (entry) {
        return path.join(tmpDir, entry.dir);
      });
      assert.strictEqual(result, '');
    });

    it('should skip non-skill type plugins even with plan_mode_required', function () {
      var entries = [
        { name: 'hook-a', dir: 'hook-dir' },
      ];
      var hookDir = path.join(tmpDir, 'hook-dir');
      fs.mkdirSync(hookDir, { recursive: true });
      fs.writeFileSync(path.join(hookDir, 'plugin.json'), JSON.stringify({
        name: 'hook-a', version: '1.0.0', type: 'hook', description: 'test hook',
        config: { plan_mode_required: true },
      }), 'utf-8');

      var result = injector.buildRuleBlock(entries, function (entry) {
        return path.join(tmpDir, entry.dir);
      });
      assert.strictEqual(result, '');
    });

    it('should include multiple plan_mode_required skills', function () {
      var entries = [
        { name: 'skill-a', dir: 'sa' },
        { name: 'skill-b', dir: 'sb' },
      ];
      ['sa', 'sb'].forEach(function (dir) {
        var d = path.join(tmpDir, dir);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'plugin.json'), JSON.stringify({
          name: 'skill-' + dir, version: '1.0.0', type: 'skill', description: 'test',
          config: { plan_mode_required: true },
        }), 'utf-8');
      });

      var result = injector.buildRuleBlock(entries, function (entry) {
        return path.join(tmpDir, entry.dir);
      });
      assert.ok(result.indexOf('skill-sa') !== -1);
      assert.ok(result.indexOf('skill-sb') !== -1);
    });

    it('should use entry.name when meta.name is missing', function () {
      var entries = [
        { name: 'fallback-name', dir: 'fb' },
      ];
      var skillDir = path.join(tmpDir, 'fb');
      fs.mkdirSync(skillDir, { recursive: true });
      // Write a plugin.json without name but with plan_mode_required
      fs.writeFileSync(path.join(skillDir, 'plugin.json'), JSON.stringify({
        version: '1.0.0', type: 'skill', description: 'test',
        config: { plan_mode_required: true },
      }), 'utf-8');

      var result = injector.buildRuleBlock(entries, function (entry) {
        return path.join(tmpDir, entry.dir);
      });
      assert.ok(result.indexOf('fallback-name') !== -1);
    });
  });

  describe('injectClaudeMdRules()', function () {
    var tmpDir;

    beforeEach(function () {
      tmpDir = createTempDir({});
    });

    afterEach(function () {
      removeDir(tmpDir);
    });

    function makePluginEntries(tmpDir) {
      return [{
        name: 'skill-plan', dir: 'plan-skill',
      }];
    }

    function setupPlanSkill(tmpDir) {
      var skillDir = path.join(tmpDir, 'plan-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'plugin.json'), JSON.stringify({
        name: 'skill-plan', version: '1.0.0', type: 'skill', description: 'test',
        config: { plan_mode_required: true },
      }), 'utf-8');
    }

    it('should create CLAUDE.md when it does not exist', function () {
      setupPlanSkill(tmpDir);
      var projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });

      injector.injectClaudeMdRules({
        targetRoot: projectDir,
        pluginEntries: makePluginEntries(tmpDir),
        resolvePluginDir: function (entry) {
          return path.join(tmpDir, entry.dir);
        },
      });

      var claudeMd = path.join(projectDir, 'CLAUDE.md');
      assert.ok(fs.existsSync(claudeMd));
      var content = fs.readFileSync(claudeMd, 'utf-8');
      assert.ok(content.indexOf('skill-plan') !== -1);
    });

    it('should update existing block when content differs', function () {
      setupPlanSkill(tmpDir);
      var projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });

      // Write existing CLAUDE.md with old block
      var oldBlock = injector.CLAUDE_MD_MARKER + '\nOld content\n' + injector.CLAUDE_MD_MARKER;
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Title\n' + oldBlock + '\n', 'utf-8');

      injector.injectClaudeMdRules({
        targetRoot: projectDir,
        pluginEntries: makePluginEntries(tmpDir),
        resolvePluginDir: function (entry) {
          return path.join(tmpDir, entry.dir);
        },
      });

      var content = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
      assert.ok(content.indexOf('Old content') === -1);
      assert.ok(content.indexOf('skill-plan') !== -1);
      assert.ok(content.indexOf('# Title') !== -1);
    });

    it('should not modify file when block is identical (idempotent)', function () {
      setupPlanSkill(tmpDir);
      var projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });

      // First injection
      injector.injectClaudeMdRules({
        targetRoot: projectDir,
        pluginEntries: makePluginEntries(tmpDir),
        resolvePluginDir: function (entry) {
          return path.join(tmpDir, entry.dir);
        },
      });

      var firstContent = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');

      // Second injection
      var logMessages = [];
      injector.injectClaudeMdRules({
        targetRoot: projectDir,
        pluginEntries: makePluginEntries(tmpDir),
        resolvePluginDir: function (entry) {
          return path.join(tmpDir, entry.dir);
        },
        log: function (level, msg) { logMessages.push({ level: level, msg: msg }); },
      });

      var secondContent = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
      assert.strictEqual(firstContent, secondContent);
      assert.ok(logMessages.some(function (l) {
        return l.msg.indexOf('up-to-date') !== -1;
      }));
    });

    it('should skip injection when no plan_mode_required skills exist', function () {
      var projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });

      var logMessages = [];
      injector.injectClaudeMdRules({
        targetRoot: projectDir,
        pluginEntries: [],
        resolvePluginDir: function () { return tmpDir; },
        log: function (level, msg) { logMessages.push({ level: level, msg: msg }); },
      });

      assert.ok(!fs.existsSync(path.join(projectDir, 'CLAUDE.md')));
      assert.ok(logMessages.some(function (l) {
        return l.msg.indexOf('No plan_mode_required') !== -1;
      }));
    });

    it('should append block to existing CLAUDE.md without markers', function () {
      setupPlanSkill(tmpDir);
      var projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Existing Content\nSome text.', 'utf-8');

      injector.injectClaudeMdRules({
        targetRoot: projectDir,
        pluginEntries: makePluginEntries(tmpDir),
        resolvePluginDir: function (entry) {
          return path.join(tmpDir, entry.dir);
        },
      });

      var content = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
      assert.ok(content.indexOf('# Existing Content') !== -1);
      assert.ok(content.indexOf('skill-plan') !== -1);
    });

    it('should handle front-matter plan_mode_required detection', function () {
      var entries = [{ name: 'fm-skill', dir: 'fm' }];
      var skillDir = path.join(tmpDir, 'fm');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'plugin.json'), JSON.stringify({
        name: 'fm-skill', version: '1.0.0', type: 'skill', description: 'test fm',
      }), 'utf-8');
      fs.writeFileSync(path.join(skillDir, 'skill.md'),
        '---\nplan_mode_required: true\n---\n# FM Skill', 'utf-8');

      var projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });

      injector.injectClaudeMdRules({
        targetRoot: projectDir,
        pluginEntries: entries,
        resolvePluginDir: function (entry) {
          return path.join(tmpDir, entry.dir);
        },
      });

      var content = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
      assert.ok(content.indexOf('fm-skill') !== -1);
    });
  });
});
