'use strict';

var path = require('path');
var fs = require('fs');

/**
 * Build command - Build all plugins into .claude/skills/ and update settings.json
 * @public
 */
module.exports = {
  name: 'build',
  description: 'Build all plugins (default)',
  /**
   * Execute the build command.
   * @public
   * @param {object} ctx - CLI context object
   */
  execute: function (ctx) {
    // Ensure harness-config.yaml exists (auto-create from template if missing)
    var configDir = ctx.configDir;
    var targetConfigPath = path.join(configDir, 'harness-config.yaml');
    if (!fs.existsSync(targetConfigPath)) {
      var templatePath = path.join(ctx.packageRoot, 'templates', 'harness-config.yaml');
      if (fs.existsSync(templatePath)) {
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }
        var content = fs.readFileSync(templatePath, 'utf-8');
        fs.writeFileSync(targetConfigPath, content, 'utf-8');
        console.log('[tackle-harness] Created default harness-config.yaml');
      }
    }

    // Detect if running in global mode (using --root to build external project)
    var isGlobalMode = ctx.flags.root !== null && ctx.targetRoot !== process.cwd();

    if (isGlobalMode) {
      console.log(ctx.colorize('[tackle-harness] Global mode detected (building external project)', 'cyan'));
      console.log('[tackle-harness] Skills and hooks will remain in the global installation.');
      console.log('[tackle-harness] Only settings.json will be updated in the target project.');
      console.log('');
    } else {
      console.log(ctx.colorize('[tackle-harness] Building plugins...', 'cyan'));
    }

    var builder = ctx.createBuilder();
    var result;

    if (isGlobalMode) {
      // Global mode: skip building skills/hooks to project, only update settings
      result = {
        success: true,
        built: [],
        errors: [],
        summary: '=== Build Report (Global Mode) ===\n\nInstallation: Global (external project)\nSkills output: ' + ctx.packageRoot + ' (global)\nHooks output:  ' + ctx.packageRoot + ' (global)\n\nNo files written to target project.\nSkills and hooks are read from global installation.\n\nBuild SUCCEEDED (global mode)\n'
      };
    } else {
      // Local mode: build normally
      result = builder.build();
    }

    if (result.success) {
      if (ctx.flags.verbose) {
        console.log(ctx.colorize('[tackle-harness] Updating settings.json...', 'dim'));
      }
      builder.updateSettings(ctx.targetRoot, ctx.packageRoot);
      builder.injectClaudeMdRules(ctx.targetRoot);
      cleanStaleOutput(ctx, builder);
    }

    // Apply colors to summary output
    var coloredSummary = result.summary
      .replace(/Build SUCCEEDED/g, ctx.colorize('Build SUCCEEDED', 'green'))
      .replace(/Build COMPLETED WITH ERRORS/g, ctx.colorize('Build COMPLETED WITH ERRORS', 'yellow'))
      .replace(/Validation PASSED/g, ctx.colorize('Validation PASSED', 'green'))
      .replace(/Validation FAILED/g, ctx.colorize('Validation FAILED', 'red'));

    console.log(coloredSummary);

    if (result.success) {
      console.log(ctx.colorize('[tackle-harness] Settings updated: .claude/settings.json', 'green'));
      console.log(ctx.colorize('[tackle-harness] CLAUDE.md rules injected.', 'green'));
      if (isGlobalMode) {
        console.log(ctx.colorize('[tackle-harness] Done! Project configured for global skills/hooks.', 'green'));
      } else {
        console.log(ctx.colorize('[tackle-harness] Done! Skills are ready to use.', 'green'));
      }
    }

    ctx.exit(result.success ? 0 : 1);
  },
};

/**
 * Remove stale output directories from disabled plugins.
 * Only removes directories whose names match a registered-but-disabled plugin.
 * User-created directories that don't match any plugin name are preserved.
 *
 * SECURITY: Ensures all deletion operations stay within the expected output directories.
 */
function cleanStaleOutput(ctx, builder) {
  var registry = builder._readRegistry();
  var plugins = registry.plugins || [];
  var enabledNames = {};
  var disabledNames = {};
  for (var i = 0; i < plugins.length; i++) {
    var regName = plugins[i].name;
    var pDir = path.join(builder._pluginsDir, plugins[i].source || regName);
    var metaPath = path.join(pDir, 'plugin.json');
    var name = regName;
    if (fs.existsSync(metaPath)) {
      try {
        var meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        name = meta.name || regName;
      } catch (e) {
        if (ctx.flags.verbose) {
          console.log(ctx.colorize('[tackle-harness] Warning: could not parse ' + metaPath, 'yellow'));
        }
      }
    }
    if (plugins[i].enabled !== false) {
      enabledNames[name] = true;
    } else {
      disabledNames[name] = true;
    }
  }

  var outputDirs = [
    path.join(ctx.targetRoot, '.claude', 'skills'),
    path.join(ctx.targetRoot, '.claude', 'hooks'),
  ];

  for (var d = 0; d < outputDirs.length; d++) {
    var dir = outputDirs[d];

    // Security check: ensure the directory is within the expected output tree
    var normalizedDir = path.normalize(dir);
    if (normalizedDir.indexOf(path.normalize(ctx.targetRoot)) !== 0) {
      console.log(ctx.colorize('[tackle-harness] Warning: skipping suspicious output directory', 'yellow'));
      continue;
    }

    if (!fs.existsSync(dir)) continue;
    var entries;
    try { entries = fs.readdirSync(dir); } catch (e) { continue; }
    for (var e = 0; e < entries.length; e++) {
      var entryName = entries[e];

      // Security: prevent path traversal in entry names
      if (entryName.indexOf('..') !== -1 || entryName.indexOf('/') !== -1 || entryName.indexOf('\\') !== -1) {
        console.log(ctx.colorize('[tackle-harness] Warning: skipping suspicious entry name', 'yellow'));
        continue;
      }

      // Only clean up if: directory name belongs to a registered disabled plugin
      if (disabledNames[entryName] && !enabledNames[entryName]) {
        var stalePath = path.join(dir, entryName);

        // Final security check: verify the path is still within the output directory
        var normalizedStalePath = path.normalize(stalePath);
        if (normalizedStalePath.indexOf(normalizedDir) !== 0) {
          console.log(ctx.colorize('[tackle-harness] Warning: skipping suspicious stale path', 'yellow'));
          continue;
        }

        try {
          fs.rmSync(stalePath, { recursive: true, force: true });
          console.log(ctx.colorize('[tackle-harness] Cleaned disabled plugin output: ' + entryName, 'yellow'));
        } catch (err) {
          console.log(ctx.colorize('[tackle-harness] Warning: could not remove ' + entryName, 'yellow'));
        }
      }
    }
  }
}
