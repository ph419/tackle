/**
 * Tests for plugins/runtime/plugin-validator.js
 *
 * Covers validatePlugin(), validateCapabilities(), validateWithSchema(),
 * formatValidationSummary(), and getKnownCapabilities().
 * Uses temp directories for file I/O tests.
 */

'use strict';

var { describe, it, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var validator = require('../../plugins/runtime/plugin-validator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tackle-pvtest-'));
}

function removeDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writePluginJson(dir, obj) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(obj), 'utf-8');
}

function validPlugin() {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    type: 'skill',
    description: 'A test plugin',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('plugin-validator', function () {

  describe('validatePlugin() - normal case', function () {
    var tmpDir;

    beforeEach(function () {
      tmpDir = createTempDir();
    });

    afterEach(function () {
      removeDir(tmpDir);
    });

    it('should pass for a valid skill plugin with skill.md', function () {
      var pluginDir = path.join(tmpDir, 'my-skill');
      writePluginJson(pluginDir, validPlugin());
      fs.writeFileSync(path.join(pluginDir, 'skill.md'), '# My Skill', 'utf-8');

      var result = validator.validatePlugin({ name: 'test-plugin' }, pluginDir);
      assert.strictEqual(result.errors.length, 0);
    });

    it('should pass for a valid hook plugin', function () {
      var pluginDir = path.join(tmpDir, 'my-hook');
      var hookPlugin = validPlugin();
      hookPlugin.type = 'hook';
      writePluginJson(pluginDir, hookPlugin);
      fs.writeFileSync(path.join(pluginDir, 'index.js'), 'module.exports = {};', 'utf-8');

      var result = validator.validatePlugin({ name: 'test-plugin' }, pluginDir);
      assert.strictEqual(result.errors.length, 0);
    });
  });

  describe('validatePlugin() - error cases', function () {
    var tmpDir;

    beforeEach(function () {
      tmpDir = createTempDir();
    });

    afterEach(function () {
      removeDir(tmpDir);
    });

    it('should report error when plugin directory does not exist', function () {
      var result = validator.validatePlugin(
        { name: 'missing' },
        path.join(tmpDir, 'nonexistent')
      );
      assert.strictEqual(result.errors.length, 1);
      assert.ok(result.errors[0].message.indexOf('not found') !== -1);
      assert.strictEqual(result.errors[0].field, 'directory');
    });

    it('should report error when plugin.json is missing', function () {
      var pluginDir = path.join(tmpDir, 'no-json');
      fs.mkdirSync(pluginDir, { recursive: true });

      var result = validator.validatePlugin({ name: 'no-json' }, pluginDir);
      assert.strictEqual(result.errors.length, 1);
      assert.strictEqual(result.errors[0].field, 'plugin.json');
    });

    it('should report error when plugin.json has invalid JSON', function () {
      var pluginDir = path.join(tmpDir, 'bad-json');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), 'not json at all', 'utf-8');

      var result = validator.validatePlugin({ name: 'bad-json' }, pluginDir);
      assert.strictEqual(result.errors.length, 1);
      assert.ok(result.errors[0].message.indexOf('Invalid JSON') !== -1);
    });

    it('should report error for missing required fields', function () {
      var pluginDir = path.join(tmpDir, 'incomplete');
      writePluginJson(pluginDir, { name: 'incomplete' }); // missing version, type, description

      var result = validator.validatePlugin({ name: 'incomplete' }, pluginDir);
      // Should have errors for version, type, description at minimum
      assert.ok(result.errors.length >= 3);
      var fields = result.errors.map(function (e) { return e.field; });
      assert.ok(fields.indexOf('version') !== -1);
      assert.ok(fields.indexOf('type') !== -1);
      assert.ok(fields.indexOf('description') !== -1);
    });

    it('should report error for invalid plugin type', function () {
      var pluginDir = path.join(tmpDir, 'bad-type');
      var p = validPlugin();
      p.type = 'invalid_type';
      writePluginJson(pluginDir, p);

      var result = validator.validatePlugin({ name: 'bad-type' }, pluginDir);
      var typeErrors = result.errors.filter(function (e) { return e.field === 'type'; });
      assert.ok(typeErrors.length >= 1);
      assert.ok(typeErrors.some(function (e) {
        return e.message.indexOf('Invalid plugin type') !== -1;
      }));
    });

    it('should report error when skill plugin is missing skill.md', function () {
      var pluginDir = path.join(tmpDir, 'no-skillmd');
      writePluginJson(pluginDir, validPlugin());
      // No skill.md

      var result = validator.validatePlugin({ name: 'test-plugin' }, pluginDir);
      var skillErrors = result.errors.filter(function (e) { return e.field === 'skill.md'; });
      assert.strictEqual(skillErrors.length, 1);
    });

    it('should report warning when hook plugin is missing index.js', function () {
      var pluginDir = path.join(tmpDir, 'no-indexjs');
      var p = validPlugin();
      p.type = 'hook';
      writePluginJson(pluginDir, p);

      var result = validator.validatePlugin({ name: 'test-plugin' }, pluginDir);
      var indexWarnings = result.warnings.filter(function (e) { return e.field === 'index.js'; });
      assert.strictEqual(indexWarnings.length, 1);
    });

    it('should report warning for non-semver version', function () {
      var pluginDir = path.join(tmpDir, 'bad-ver');
      var p = validPlugin();
      p.version = 'abc';
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(p), 'utf-8');
      fs.writeFileSync(path.join(pluginDir, 'skill.md'), '# Test', 'utf-8');

      var result = validator.validatePlugin({ name: 'test-plugin' }, pluginDir);
      var verWarnings = result.warnings.filter(function (e) { return e.field === 'version'; });
      assert.strictEqual(verWarnings.length, 1);
      assert.ok(verWarnings[0].message.indexOf('semver') !== -1);
    });

    it('should accept semver version with pre-release suffix', function () {
      var pluginDir = path.join(tmpDir, 'pre-rel');
      var p = validPlugin();
      p.version = '1.2.3-beta.1';
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(p), 'utf-8');
      fs.writeFileSync(path.join(pluginDir, 'skill.md'), '# Test', 'utf-8');

      var result = validator.validatePlugin({ name: 'test-plugin' }, pluginDir);
      var verWarnings = result.warnings.filter(function (e) { return e.field === 'version'; });
      assert.strictEqual(verWarnings.length, 0);
    });

    it('should use entry.source as fallback name', function () {
      var result = validator.validatePlugin(
        { source: 'my-source' },
        path.join(tmpDir, 'nonexistent')
      );
      assert.strictEqual(result.errors[0].plugin, 'my-source');
    });
  });

  describe('validateCapabilities()', function () {
    it('should return empty warnings for null capabilities', function () {
      var result = validator.validateCapabilities(null);
      assert.deepStrictEqual(result, []);
    });

    it('should return empty warnings for undefined capabilities', function () {
      var result = validator.validateCapabilities(undefined);
      assert.deepStrictEqual(result, []);
    });

    it('should return empty warnings for all-known capabilities', function () {
      var result = validator.validateCapabilities({
        filesystem: true,
        network: true,
      });
      assert.deepStrictEqual(result, []);
    });

    it('should return warning for unknown capability', function () {
      var result = validator.validateCapabilities({
        unknown_cap: true,
      });
      assert.strictEqual(result.length, 1);
      assert.ok(result[0].message.indexOf('Unknown capability') !== -1);
      assert.ok(result[0].message.indexOf('unknown_cap') !== -1);
    });

    it('should return warning when capabilities is an array', function () {
      var result = validator.validateCapabilities(['network']);
      assert.strictEqual(result.length, 1);
      assert.ok(result[0].message.indexOf('must be an object') !== -1);
    });

    it('should return warning when capabilities is a string', function () {
      var result = validator.validateCapabilities('network');
      assert.strictEqual(result.length, 1);
      assert.ok(result[0].message.indexOf('must be an object') !== -1);
    });
  });

  describe('getKnownCapabilities()', function () {
    it('should return an array of known capability strings', function () {
      var caps = validator.getKnownCapabilities();
      assert.ok(Array.isArray(caps));
      assert.ok(caps.length >= 5);
      assert.ok(caps.indexOf('filesystem') !== -1);
      assert.ok(caps.indexOf('network') !== -1);
      assert.ok(caps.indexOf('child_process') !== -1);
      assert.ok(caps.indexOf('env') !== -1);
      assert.ok(caps.indexOf('plugin_access') !== -1);
    });

    it('should return a copy (not the internal array)', function () {
      var a = validator.getKnownCapabilities();
      var b = validator.getKnownCapabilities();
      assert.notStrictEqual(a, b);
    });
  });

  describe('validateWithSchema()', function () {
    it('should return valid:true for a correct plugin object', function () {
      var result = validator.validateWithSchema(validPlugin());
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    it('should return errors for invalid plugin type', function () {
      var p = validPlugin();
      p.type = 'not-a-type';
      var result = validator.validateWithSchema(p);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it('should return errors for missing required fields', function () {
      var result = validator.validateWithSchema({ name: 'only-name' });
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length >= 3);
    });
  });

  describe('formatValidationSummary()', function () {
    it('should format a passing report with no errors', function () {
      var summary = validator.formatValidationSummary({
        totalPlugins: 5,
        errors: [],
        warnings: [],
      });
      assert.ok(summary.indexOf('Plugins checked: 5') !== -1);
      assert.ok(summary.indexOf('Errors: 0') !== -1);
      assert.ok(summary.indexOf('Validation PASSED') !== -1);
    });

    it('should format a failing report with errors and warnings', function () {
      var summary = validator.formatValidationSummary({
        totalPlugins: 3,
        errors: [{ plugin: 'bad-plugin', message: 'Something broke' }],
        warnings: [{ plugin: 'warn-plugin', message: 'Check this' }],
      });
      assert.ok(summary.indexOf('Validation FAILED') !== -1);
      assert.ok(summary.indexOf('Something broke') !== -1);
      assert.ok(summary.indexOf('Check this') !== -1);
    });
  });
});
