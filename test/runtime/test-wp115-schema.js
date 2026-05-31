/**
 * WP-115: plugin.json schema formalization tests
 *
 * Tests validateWithSchema(), loadPluginSchema(), and integration
 * of schema validation into the validatePlugin() flow.
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var fs = require('fs');

var pv = require('../../plugins/runtime/plugin-validator');

// ---------------------------------------------------------------------------
// Schema loading
// ---------------------------------------------------------------------------

test.describe('WP-115: loadPluginSchema()', function () {
  test('should load and return the schema object', function () {
    var schema = pv.loadPluginSchema();
    assert.ok(schema, 'schema should be loaded');
    assert.strictEqual(schema.$schema, 'http://json-schema.org/draft-07/schema#');
    assert.strictEqual(schema.title, 'Tackle Plugin Manifest');
  });

  test('schema should have required fields defined', function () {
    var schema = pv.loadPluginSchema();
    assert.ok(schema.required, 'schema should have required array');
    assert.deepStrictEqual(schema.required, ['name', 'version', 'type', 'description']);
  });

  test('schema file should exist at plugins/contracts/plugin-schema.json', function () {
    var schemaPath = path.join(__dirname, '..', '..', 'plugins', 'contracts', 'plugin-schema.json');
    assert.ok(fs.existsSync(schemaPath), 'plugin-schema.json should exist');
    var parsed = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    assert.strictEqual(parsed.title, 'Tackle Plugin Manifest');
  });
});

// ---------------------------------------------------------------------------
// validateWithSchema() - valid inputs
// ---------------------------------------------------------------------------

test.describe('WP-115: validateWithSchema() valid inputs', function () {
  test('should pass a minimal valid plugin', function () {
    var result = pv.validateWithSchema({
      name: 'test-plugin',
      version: '1.0.0',
      type: 'skill',
      description: 'A test plugin',
    });
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });

  test('should pass a plugin with all optional fields', function () {
    var result = pv.validateWithSchema({
      name: 'full-plugin',
      version: '2.3.4-beta.1',
      type: 'provider',
      description: 'Full plugin with all fields',
      source: 'npm',
      sourceType: 'npm',
      triggers: ['trigger-a', 'trigger-b'],
      dependencies: ['provider:state-store'],
      provides: ['provider:memory-store'],
      config: { key: 'value' },
      metadata: { gatedByCode: true },
      capabilities: { network: true },
    });
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });

  test('should pass core skill plugin with triggers, dependencies, config', function () {
    var result = pv.validateWithSchema({
      name: 'skill-task-creator',
      version: '1.0.0',
      type: 'skill',
      description: 'Task creation skill',
      triggers: ['create task'],
      dependencies: ['provider:state-store'],
      provides: ['skill:task-creator'],
      metadata: { gatedByCode: true },
      config: { plan_mode_required: true },
    });
    assert.strictEqual(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// validateWithSchema() - invalid inputs
// ---------------------------------------------------------------------------

test.describe('WP-115: validateWithSchema() invalid inputs', function () {
  test('should fail on missing required fields', function () {
    var result = pv.validateWithSchema({
      name: 'test',
      // missing version, type, description
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length >= 3, 'should have at least 3 errors for missing fields');
  });

  test('should fail on invalid name pattern (uppercase)', function () {
    var result = pv.validateWithSchema({
      name: 'BadName',
      version: '1.0.0',
      type: 'skill',
      description: 'test',
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(function (e) {
      return e.field === 'name';
    }), 'should report name pattern error');
  });

  test('should fail on invalid name pattern (starts with number)', function () {
    var result = pv.validateWithSchema({
      name: '0bad-name',
      version: '1.0.0',
      type: 'skill',
      description: 'test',
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(function (e) {
      return e.field === 'name';
    }));
  });

  test('should fail on invalid type enum', function () {
    var result = pv.validateWithSchema({
      name: 'test',
      version: '1.0.0',
      type: 'module',
      description: 'test',
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(function (e) {
      return e.field === 'type';
    }));
  });

  test('should fail on invalid version pattern', function () {
    var result = pv.validateWithSchema({
      name: 'test',
      version: 'abc',
      type: 'skill',
      description: 'test',
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(function (e) {
      return e.field === 'version';
    }));
  });

  test('should fail on empty description', function () {
    var result = pv.validateWithSchema({
      name: 'test',
      version: '1.0.0',
      type: 'skill',
      description: '',
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(function (e) {
      return e.field === 'description';
    }));
  });
});

// ---------------------------------------------------------------------------
// Reverse validation of all 23 core plugins
// ---------------------------------------------------------------------------

test.describe('WP-115: reverse validate all 23 core plugins', function () {
  var coreDir = path.join(__dirname, '..', '..', 'plugins', 'core');
  var dirs = fs.readdirSync(coreDir);

  test('all core plugins should pass schema validation', function () {
    var failures = [];
    for (var i = 0; i < dirs.length; i++) {
      var pjson = path.join(coreDir, dirs[i], 'plugin.json');
      if (!fs.existsSync(pjson)) continue;
      var meta = JSON.parse(fs.readFileSync(pjson, 'utf-8'));
      var result = pv.validateWithSchema(meta);
      if (!result.valid) {
        failures.push({
          name: dirs[i],
          errors: result.errors,
        });
      }
    }
    assert.strictEqual(failures.length, 0,
      'All 23 core plugins should pass schema. Failures: ' + JSON.stringify(failures, null, 2));
  });

  test('validatePlugin integration: all core plugins pass full validation', function () {
    var failures = [];
    for (var i = 0; i < dirs.length; i++) {
      var pluginDir = path.join(coreDir, dirs[i]);
      if (!fs.existsSync(path.join(pluginDir, 'plugin.json'))) continue;
      var result = pv.validatePlugin({ name: dirs[i] }, pluginDir);
      if (result.errors.length > 0) {
        failures.push({
          name: dirs[i],
          errors: result.errors,
        });
      }
    }
    assert.strictEqual(failures.length, 0,
      'All core plugins should pass full validatePlugin. Failures: ' + JSON.stringify(failures, null, 2));
  });
});
