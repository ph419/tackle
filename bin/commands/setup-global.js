'use strict';

var path = require('path');
var fs = require('fs');
var os = require('os');
var HarnessBuild = require('../../plugins/runtime/harness-build');

/**
 * Setup-global command - Install global skills to ~/.claude/skills/
 * @public
 */
module.exports = {
  name: 'setup-global',
  description: 'Install global skills to ~/.claude/skills/',
  /**
   * Execute the setup-global command.
   * @public
   * @param {object} ctx - CLI context object
   */
  execute: function (ctx) {
    // B16: os.homedir() is the correct cross-platform home resolution.
    // The previous `process.env.HOME || USERPROFILE` returns a Unix-style
    // path under Git Bash on Windows (HOME=/c/Users/...), which breaks the
    // fs APIs expecting a Windows path. os.homedir() always returns the
    // platform-native path.
    var homeDir = os.homedir();
    if (!homeDir) {
      console.error(ctx.colorize('Error: Cannot determine home directory', 'red'));
      ctx.exit(1);
      return; // B16: exit doesn't halt flow by itself; guard the rest.
    }

    console.log(ctx.colorize('[tackle-harness] Installing global skills and hooks...', 'cyan'));
    console.log('[tackle-harness] Home directory: ' + homeDir);
    console.log('[tackle-harness] Package root:   ' + ctx.packageRoot);
    console.log('');

    // Create a global builder with home directory as target
    var globalBuilder = new HarnessBuild({
      targetRoot: homeDir,
      packageRoot: ctx.packageRoot,
      registryPath: ctx.registryPath,
      pluginsDir: ctx.pluginsDir,
      outputSkillsDir: path.join(homeDir, '.claude', 'skills'),
      outputHooksDir: path.join(homeDir, '.claude', 'hooks'),
      verbose: ctx.flags.verbose,
      globalMode: true,
      cliPath: process.argv[1] || path.join(ctx.packageRoot, 'bin', 'tackle.js'),
    });

    // Build all plugins (skills + hooks)
    var result = globalBuilder.build();

    if (result.success) {
      if (ctx.flags.verbose) {
        console.log(ctx.colorize('[tackle-harness] Updating global settings.json...', 'dim'));
      }
      // Register hooks in global settings.json
      globalBuilder.updateSettings(homeDir, ctx.packageRoot);
    }

    // Apply colors to summary output
    var coloredSummary = result.summary
      .replace(/Build SUCCEEDED/g, ctx.colorize('Build SUCCEEDED', 'green'))
      .replace(/Build COMPLETED WITH ERRORS/g, ctx.colorize('Build COMPLETED WITH ERRORS', 'yellow'))
      .replace(/Validation PASSED/g, ctx.colorize('Validation PASSED', 'green'))
      .replace(/Validation FAILED/g, ctx.colorize('Validation FAILED', 'red'));

    console.log(coloredSummary);

    if (result.success) {
      console.log(ctx.colorize('[tackle-harness] Global settings updated: ~/.claude/settings.json', 'green'));
      console.log(ctx.colorize('[tackle-harness] Done! Skills and hooks are globally available.', 'green'));
      console.log('');
      console.log(ctx.colorize('You can now use tackle-harness in any project directory.', 'cyan'));
      console.log(ctx.colorize('Run "tackle-harness init" in your project to get started.', 'dim'));
    }

    ctx.exit(result.success ? 0 : 1);
  },
};
