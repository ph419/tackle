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
     */
    exit: function (code) {
      process.exit(code);
    },
  };

  return ctx;
}

module.exports = {
  colors: colors,
  colorize: colorize,
  createContext: createContext,
};
