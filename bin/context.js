'use strict';

var path = require('path');
var fs = require('fs');
var HarnessBuild = require('../plugins/runtime/harness-build');

/**
 * Color definitions for CLI output.
 */
var colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

/**
 * Apply color to text if colors are enabled.
 * @param {string} text - The text to color
 * @param {string} color - Color name from colors object
 * @param {boolean} noColor - If true, skip colorization
 * @returns {string}
 */
function colorize(text, color, noColor) {
  if (noColor) {
    return text;
  }
  return (colors[color] || '') + text + (colors.reset || '');
}

/**
 * Create a command execution context.
 *
 * @param {object} opts
 * @param {string} opts.packageRoot - Root directory of this npm package
 * @param {string} opts.targetRoot  - Target project root directory
 * @param {object} opts.flags       - Parsed CLI flags
 * @param {string} opts.command     - Resolved command name
 * @param {string} opts.packageVersion - Package version string
 */
function createContext(opts) {
  var ctx = {
    packageRoot: opts.packageRoot,
    targetRoot: opts.targetRoot,
    flags: opts.flags,
    command: opts.command,
    packageVersion: opts.packageVersion,
    // Command arguments after the command name (parsed by bin/tackle.js).
    // May be undefined for older callers; commands that need args should default to [].
    argv: opts.argv || [],

    // Convenience path accessors
    get skillsDir() {
      return path.join(this.targetRoot, '.claude', 'skills');
    },
    get hooksDir() {
      return path.join(this.targetRoot, '.claude', 'hooks');
    },
    get configDir() {
      return path.join(this.targetRoot, '.claude', 'config');
    },
    get settingsPath() {
      return path.join(this.targetRoot, '.claude', 'settings.json');
    },
    get configPath() {
      return path.join(this.targetRoot, '.claude', 'config', 'harness-config.yaml');
    },
    get registryPath() {
      return path.join(this.packageRoot, 'plugins', 'plugin-registry.json');
    },
    get pluginsDir() {
      return path.join(this.packageRoot, 'plugins', 'core');
    },

    /**
     * Colorize text, respecting --no-color flag.
     */
    colorize: function (text, color) {
      return colorize(text, color, this.flags.noColor);
    },

    /**
     * Create a configured HarnessBuild instance.
     */
    createBuilder: function (overrides) {
      var opts = {
        rootDir: this.targetRoot,
        packageRoot: this.packageRoot,
        registryPath: this.registryPath,
        pluginsDir: this.pluginsDir,
        outputSkillsDir: path.join(this.targetRoot, '.claude', 'skills'),
        outputHooksDir: path.join(this.targetRoot, '.claude', 'hooks'),
        verbose: this.flags.verbose,
      };
      if (overrides) {
        for (var key in overrides) {
          if (overrides.hasOwnProperty(key)) {
            opts[key] = overrides[key];
          }
        }
      }
      return new HarnessBuild(opts);
    },

    /**
     * Exit the process with the given code.
     *
     * A4: in test mode (TACKLE_TEST_MODE=1), throws a sentinel error instead
     * of calling process.exit so that bin/commands can be exercised inside a
     * test runner without killing the process. The CLI entry point
     * (bin/tackle.js) catches ExitSignal and converts it back to process.exit.
     * In production (no env var), behaves exactly as before (process.exit).
     */
    exit: function (code) {
      if (process.env.TACKLE_TEST_MODE === '1') {
        var err = new Error('ExitSignal:' + code);
        err.isExitSignal = true;
        err.exitCode = code;
        throw err;
      }
      process.exit(code);
    },
  };

  return ctx;
}

/**
 * Sentinel error name for exit signals thrown in test mode (A4).
 * Callers that catch exceptions can check `err.isExitSignal` to distinguish
 * a process-exit request from a real error.
 * @public
 */
var EXIT_SIGNAL = 'ExitSignal';

module.exports = {
  colors: colors,
  colorize: colorize,
  createContext: createContext,
  EXIT_SIGNAL: EXIT_SIGNAL,
};
