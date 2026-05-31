/**
 * WP-124: Version migration path tests
 *
 * Tests cover:
 * - WP-124-1: v0.1.x -> v0.2.0 upgrade path
 * - WP-124-2: migrate command boundary cases
 * - WP-124-3: plugin.json schema backward compatibility
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var fs = require('fs');
var os = require('os');

var migrate = require('../../commands/migrate');
var pv = require('../../plugins/runtime/plugin-validator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory with the structure needed for migration tests.
 * Returns an object with paths and a cleanup function.
 */
function createTestProject(options) {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tackle-migrate-test-'));

  var packageRoot = path.join(tmpDir, 'package');
  var targetRoot = path.join(tmpDir, 'project');

  // Create package structure
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

  // Create core plugin directories
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
    if (cp.type === 'skill') {
      fs.writeFileSync(
        path.join(cpDir, 'skill.md'),
        '# ' + cp.name + '\n\nTest skill.',
        'utf-8'
      );
    }
    if (cp.type === 'hook' || cp.type === 'provider' || cp.type === 'validator') {
      fs.writeFileSync(
        path.join(cpDir, 'index.js'),
        "'use strict';\nmodule.exports = { name: '" + cp.name + "' };\n",
        'utf-8'
      );
    }
  }

  // Create target project structure
  fs.mkdirSync(path.join(targetRoot, '.claude', 'config'), { recursive: true });

  // Optionally create settings.json
  if (options.settings) {
    var claudeDir = path.join(targetRoot, '.claude');
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify(options.settings, null, 2),
      'utf-8'
    );
  }

  // Optionally create project-level skills
  if (options.projectSkills) {
    var skillsDir = path.join(targetRoot, '.claude', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    for (var j = 0; j < options.projectSkills.length; j++) {
      var skill = options.projectSkills[j];
      var skillDir = path.join(skillsDir, skill);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'skill.md'), '# ' + skill + '\n', 'utf-8');
    }
  }

  // Optionally create project-level hooks
  if (options.projectHooks) {
    var hooksDir = path.join(targetRoot, '.claude', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    for (var k = 0; k < options.projectHooks.length; k++) {
      var hook = options.projectHooks[k];
      var hookDir = path.join(hooksDir, hook);
      fs.mkdirSync(hookDir, { recursive: true });
      fs.writeFileSync(path.join(hookDir, 'index.js'), "'use strict';\n", 'utf-8');
    }
  }

  // Create minimal harness config
  fs.writeFileSync(
    path.join(targetRoot, '.claude', 'config', 'harness-config.yaml'),
    '# test config\ncontext_window:\n  enabled: true\n',
    'utf-8'
  );

  return {
    tmpDir: tmpDir,
    packageRoot: packageRoot,
    targetRoot: targetRoot,
    registryPath: registryPath,
    settingsPath: path.join(targetRoot, '.claude', 'settings.json'),
    skillsDir: path.join(targetRoot, '.claude', 'skills'),
    hooksDir: path.join(targetRoot, '.claude', 'hooks'),
    cleanup: function () {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/**
 * Create a mock context for the migrate command.
 * Replaces ctx.exit() to capture exit code without killing the process.
 */
function createMockContext(project) {
  var exitCode = null;
  var logs = [];
  var ctx = {
    packageRoot: project.packageRoot,
    targetRoot: project.targetRoot,
    settingsPath: project.settingsPath,
    registryPath: project.registryPath,
    flags: { noColor: true, verbose: false },
    command: 'migrate',
    packageVersion: '0.2.0',
    colorize: function (text) { return text; },
    exit: function (code) { exitCode = code; },
    createBuilder: function () {
      return {
        injectClaudeMdRules: function () {},
      };
    },
  };
  return { ctx: ctx, getExitCode: function () { return exitCode; } };
}

// ---------------------------------------------------------------------------
// WP-124-1: v0.1.x -> v0.2.0 upgrade path tests
// ---------------------------------------------------------------------------

test.describe('WP-124-1: v0.1.x -> v0.2.0 upgrade path', function () {

  test('should migrate project with legacy local hooks in settings.json', function () {
    var project = createTestProject({
      corePlugins: [
        { name: 'skill-task-creator', version: '1.0.0', type: 'skill', description: 'Test' },
      ],
      plugins: [
        { name: 'skill-task-creator' },
      ],
      settings: {
        hooks: {
          PreToolUse: [{
            matcher: 'Edit|Write',
            hooks: [{
              command: 'node "../plugins/core/hook-skill-gate/index.js"',
            }],
          }],
          PostToolUse: [{
            matcher: 'Skill',
            hooks: [{
              command: 'node "../plugins/core/hook-skill-gate/index.js"',
            }],
          }],
          SessionStart: [{
            matcher: 'startup|clear|compact',
            hooks: [{
              command: 'node "../plugins/core/hook-session-start/index.js"',
            }],
          }],
        },
      },
    });

    try {
      var mock = createMockContext(project);
      migrate.execute(mock.ctx);

      // Verify legacy hooks were removed (array entries spliced out)
      var settingsAfter = JSON.parse(
        fs.readFileSync(project.settingsPath, 'utf-8')
      );
      var preUse = (settingsAfter.hooks && settingsAfter.hooks.PreToolUse) || [];
      var postUse = (settingsAfter.hooks && settingsAfter.hooks.PostToolUse) || [];
      var sessionStart = (settingsAfter.hooks && settingsAfter.hooks.SessionStart) || [];
      assert.strictEqual(preUse.length, 0, 'PreToolUse legacy hooks should be removed');
      assert.strictEqual(postUse.length, 0, 'PostToolUse legacy hooks should be removed');
      assert.strictEqual(sessionStart.length, 0, 'SessionStart legacy hooks should be removed');
      assert.strictEqual(mock.getExitCode(), 0);
    } finally {
      project.cleanup();
    }
  });

  test('should migrate project with local skill directories', function () {
    var project = createTestProject({
      corePlugins: [
        { name: 'skill-task-creator', version: '1.0.0', type: 'skill', description: 'Task creator' },
      ],
      plugins: [
        { name: 'skill-task-creator' },
      ],
      projectSkills: ['skill-task-creator'],
    });

    try {
      var mock = createMockContext(project);
      migrate.execute(mock.ctx);

      // The project-level skill directory should be removed
      assert.strictEqual(
        fs.existsSync(path.join(project.skillsDir, 'skill-task-creator')),
        false,
        'Project-level skill directory should be removed'
      );
      assert.strictEqual(mock.getExitCode(), 0);
    } finally {
      project.cleanup();
    }
  });

  test('should migrate project with local hook directories', function () {
    var project = createTestProject({
      corePlugins: [],
      plugins: [],
      projectHooks: ['hook-skill-gate', 'hook-session-start'],
    });

    try {
      var mock = createMockContext(project);
      migrate.execute(mock.ctx);

      // Project-level hook directories should be removed
      assert.strictEqual(
        fs.existsSync(path.join(project.hooksDir, 'hook-skill-gate')),
        false,
        'hook-skill-gate directory should be removed'
      );
      assert.strictEqual(
        fs.existsSync(path.join(project.hooksDir, 'hook-session-start')),
        false,
        'hook-session-start directory should be removed'
      );
      assert.strictEqual(mock.getExitCode(), 0);
    } finally {
      project.cleanup();
    }
  });

  test('should handle clean project (no legacy structure)', function () {
    var project = createTestProject({
      corePlugins: [],
      plugins: [],
    });

    try {
      var mock = createMockContext(project);
      migrate.execute(mock.ctx);
      assert.strictEqual(mock.getExitCode(), 0);
    } finally {
      project.cleanup();
    }
  });

  test('should preserve non-legacy hooks in settings.json', function () {
    // Use a hook command that is NOT detected as legacy:
    // Must not contain ../ or ..\, and if starts with "node " must contain a drive letter or ./
    var project = createTestProject({
      corePlugins: [],
      plugins: [],
      settings: {
        hooks: {
          PreToolUse: [{
            matcher: 'Edit|Write',
            hooks: [{
              command: 'node "C:/Users/global/tackle-hook.js"',
            }],
          }],
        },
      },
    });

    try {
      var mock = createMockContext(project);
      migrate.execute(mock.ctx);

      var settingsAfter = JSON.parse(
        fs.readFileSync(project.settingsPath, 'utf-8')
      );
      // Non-legacy hook (has drive letter, not relative) should be preserved
      assert.strictEqual(settingsAfter.hooks.PreToolUse.length, 1, 'Non-legacy hook should be preserved');
      assert.strictEqual(mock.getExitCode(), 0);
    } finally {
      project.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// WP-124-2: migrate command boundary tests
// ---------------------------------------------------------------------------

test.describe('WP-124-2: migrate command boundary cases', function () {

  test('should handle missing settings.json gracefully', function () {
    var project = createTestProject({
      corePlugins: [],
      plugins: [],
    });

    // Ensure no settings.json
    if (fs.existsSync(project.settingsPath)) {
      fs.unlinkSync(project.settingsPath);
    }

    try {
      var mock = createMockContext(project);
      // Should not throw
      migrate.execute(mock.ctx);
      assert.strictEqual(mock.getExitCode(), 0);
    } finally {
      project.cleanup();
    }
  });

  test('should handle malformed settings.json', function () {
    var project = createTestProject({
      corePlugins: [],
      plugins: [],
    });

    // Write malformed JSON
    fs.writeFileSync(project.settingsPath, '{invalid json!!!', 'utf-8');

    try {
      var mock = createMockContext(project);
      // Should not throw, just log warning
      migrate.execute(mock.ctx);
      assert.strictEqual(mock.getExitCode(), 0);
    } finally {
      project.cleanup();
    }
  });

  test('should handle empty .claude/skills directory without error', function () {
    var project = createTestProject({
      corePlugins: [],
      plugins: [],
      projectSkills: [],
    });

    // Create an empty skills directory
    fs.mkdirSync(project.skillsDir, { recursive: true });

    try {
      var mock = createMockContext(project);
      migrate.execute(mock.ctx);

      // Empty skills dir without matching core plugins is left as-is
      // (cleanup only runs after at least one skill is removed)
      assert.strictEqual(mock.getExitCode(), 0);
    } finally {
      project.cleanup();
    }
  });

  test('should preserve custom (non-core) project skills', function () {
    var project = createTestProject({
      corePlugins: [
        { name: 'skill-task-creator', version: '1.0.0', type: 'skill', description: 'Core skill' },
      ],
      plugins: [
        { name: 'skill-task-creator' },
      ],
      projectSkills: ['skill-task-creator', 'my-custom-skill'],
    });

    try {
      var mock = createMockContext(project);
      migrate.execute(mock.ctx);

      // Core skill should be removed, custom skill should remain
      assert.strictEqual(
        fs.existsSync(path.join(project.skillsDir, 'skill-task-creator')),
        false,
        'Core skill directory should be removed'
      );
      assert.strictEqual(
        fs.existsSync(path.join(project.skillsDir, 'my-custom-skill')),
        true,
        'Custom skill directory should be preserved'
      );
      assert.strictEqual(mock.getExitCode(), 0);
    } finally {
      project.cleanup();
    }
  });

  test('should handle missing plugin registry gracefully', function () {
    var project = createTestProject({
      corePlugins: [],
      plugins: [],
      projectSkills: ['some-skill'],
    });

    // Delete the registry
    fs.unlinkSync(project.registryPath);

    try {
      var mock = createMockContext(project);
      // Should not throw
      migrate.execute(mock.ctx);
      assert.strictEqual(mock.getExitCode(), 0);
    } finally {
      project.cleanup();
    }
  });

  test('should handle settings.json with no hooks property', function () {
    var project = createTestProject({
      corePlugins: [],
      plugins: [],
      settings: {
        permissions: { allow: ['Bash(git status)'] },
      },
    });

    try {
      var mock = createMockContext(project);
      migrate.execute(mock.ctx);

      // Settings should be preserved
      var settingsAfter = JSON.parse(
        fs.readFileSync(project.settingsPath, 'utf-8')
      );
      assert.ok(settingsAfter.permissions, 'Non-hook settings should be preserved');
      assert.strictEqual(mock.getExitCode(), 0);
    } finally {
      project.cleanup();
    }
  });

  test('should handle legacy hook with backslash path (Windows)', function () {
    var project = createTestProject({
      corePlugins: [],
      plugins: [],
      settings: {
        hooks: {
          PreToolUse: [{
            matcher: 'Edit|Write',
            hooks: [{
              command: 'node "..\\plugins\\core\\hook-skill-gate\\index.js"',
            }],
          }],
        },
      },
    });

    try {
      var mock = createMockContext(project);
      migrate.execute(mock.ctx);

      var settingsAfter = JSON.parse(
        fs.readFileSync(project.settingsPath, 'utf-8')
      );
      var preUse = (settingsAfter.hooks && settingsAfter.hooks.PreToolUse) || [];
      assert.strictEqual(preUse.length, 0, 'Windows-style path legacy hooks should be removed');
      assert.strictEqual(mock.getExitCode(), 0);
    } finally {
      project.cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// WP-124-3: Schema backward compatibility
// ---------------------------------------------------------------------------

test.describe('WP-124-3: plugin.json schema backward compatibility', function () {

  test('v0.1.x minimal plugin.json should validate under v0.2.0 schema', function () {
    // v0.1.x plugins had only the 4 required fields
    var v01xPlugin = {
      name: 'my-plugin',
      version: '1.0.0',
      type: 'skill',
      description: 'A v0.1.x era plugin',
    };

    var result = pv.validateWithSchema(v01xPlugin);
    assert.strictEqual(result.valid, true, 'v0.1.x minimal plugin should pass v0.2.0 schema');
  });

  test('v0.1.x plugin with triggers should still validate', function () {
    var v01xPlugin = {
      name: 'my-skill',
      version: '0.5.3',
      type: 'skill',
      description: 'A skill with triggers',
      triggers: ['create task', 'new task'],
    };

    var result = pv.validateWithSchema(v01xPlugin);
    assert.strictEqual(result.valid, true, 'v0.1.x plugin with triggers should pass');
  });

  test('v0.1.x plugin with dependencies should still validate', function () {
    var v01xPlugin = {
      name: 'my-hook',
      version: '1.2.0',
      type: 'hook',
      description: 'A hook with dependencies',
      dependencies: ['provider:state-store'],
      provides: ['hook:my-hook'],
    };

    var result = pv.validateWithSchema(v01xPlugin);
    assert.strictEqual(result.valid, true, 'v0.1.x plugin with dependencies should pass');
  });

  test('v0.2.0 new fields (capabilities, metadata.requiresPlanMode) should validate', function () {
    var v020Plugin = {
      name: 'modern-plugin',
      version: '2.0.0',
      type: 'provider',
      description: 'A v0.2.0 plugin with new fields',
      metadata: {
        requiresPlanMode: true,
        gatedByCode: true,
      },
      capabilities: {
        filesystem: {
          read: ['/tmp/data'],
          write: ['/tmp/output'],
        },
        network: false,
        child_process: true,
        env: ['NODE_ENV'],
      },
    };

    var result = pv.validateWithSchema(v020Plugin);
    assert.strictEqual(result.valid, true, 'v0.2.0 plugin with new fields should pass');
  });

  test('all 23 core plugins should be backward compatible', function () {
    var coreDir = path.join(__dirname, '..', '..', 'plugins', 'core');
    var dirs = fs.readdirSync(coreDir);
    var failures = [];

    for (var i = 0; i < dirs.length; i++) {
      var pjson = path.join(coreDir, dirs[i], 'plugin.json');
      if (!fs.existsSync(pjson)) continue;
      var meta = JSON.parse(fs.readFileSync(pjson, 'utf-8'));
      var result = pv.validateWithSchema(meta);
      if (!result.valid) {
        failures.push({ name: dirs[i], errors: result.errors });
      }
    }

    assert.strictEqual(failures.length, 0,
      'All core plugins should pass schema. Failures: ' + JSON.stringify(failures, null, 2));
  });

  test('root-level additionalProperties:false is enforced by schema definition', function () {
    // The plugin-schema.json defines "additionalProperties": false at root level.
    // The inline fallback validator does not enforce this constraint (only ajv does).
    // Verify the schema definition itself has the constraint:
    var schema = pv.loadPluginSchema();
    assert.strictEqual(schema.additionalProperties, false,
      'Schema should have additionalProperties: false at root level');
  });

  test('v0.1.x plugin with source/sourceType should validate', function () {
    var plugin = {
      name: 'external-plugin',
      version: '1.0.0',
      type: 'validator',
      description: 'An external plugin',
      source: 'tackle-plugin-example',
      sourceType: 'npm',
    };

    var result = pv.validateWithSchema(plugin);
    assert.strictEqual(result.valid, true);
  });

  test('config field should accept any object shape', function () {
    var plugin = {
      name: 'test-plugin',
      version: '1.0.0',
      type: 'skill',
      description: 'Test',
      config: {
        plan_mode_required: true,
        customKey: 'value',
        nested: { a: 1 },
      },
    };

    var result = pv.validateWithSchema(plugin);
    assert.strictEqual(result.valid, true, 'config should accept additional properties');
  });

});
