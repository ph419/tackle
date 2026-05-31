/**
 * Install command - Install an external plugin with security confirmation
 * @public
 *
 * When an external plugin (npm/local sourceType) declares capabilities,
 * the user is prompted to confirm before installation proceeds.
 * Non-interactive mode is supported via TACKLE_ASSUME_YES environment variable.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var readline = require('readline');

/**
 * Known capability names with risk level labels.
 * @type {Object.<string, string>}
 */
var CAPABILITY_LEVELS = {
  'filesystem': 'high',
  'network': 'high',
  'child_process': 'critical',
  'env': 'medium',
};

/**
 * Confirm installation of an external plugin.
 *
 * Displays the plugin's declared capabilities and asks the user to confirm.
 * - If capabilities are empty or missing, auto-approves (basic services only).
 * - In non-interactive environments, checks TACKLE_ASSUME_YES env var.
 * - In interactive mode, prompts with [y/N] and waits for user input.
 *
 * @param {string} pluginName - Name of the plugin being installed
 * @param {object} registryEntry - Registry entry with optional capabilities field
 * @param {object} [options] - Options
 * @param {boolean} [options.isNonInteractive] - Force non-interactive mode
 * @returns {Promise<boolean>} true if user confirms or auto-approved, false if rejected
 */
async function confirmInstall(pluginName, registryEntry, options) {
  options = options || {};
  var capabilities = registryEntry.capabilities || {};
  var capKeys = Object.keys(capabilities);

  // No extra capabilities — auto-approve
  if (capKeys.length === 0) {
    console.log('Plugin ' + pluginName + ' declares no extra capabilities (basic services only).');
    return true;
  }

  // Display capabilities with risk levels
  console.log('');
  console.log('Plugin ' + pluginName + ' declares the following capabilities:');
  for (var i = 0; i < capKeys.length; i++) {
    var cap = capKeys[i];
    var level = CAPABILITY_LEVELS[cap] || 'unknown';
    var detail = capabilities[cap];
    console.log('  - ' + cap + ' (' + level + '): ' + JSON.stringify(detail));
  }
  console.log('');

  // Non-interactive mode: check TACKLE_ASSUME_YES
  var isNonInteractive = options.isNonInteractive || !process.stdout.isTTY;
  if (isNonInteractive) {
    if (process.env.TACKLE_ASSUME_YES === '1' || process.env.TACKLE_ASSUME_YES === 'true') {
      console.log('TACKLE_ASSUME_YES is set. Automatically approving installation.');
      return true;
    }
    console.error('Non-interactive mode detected and TACKLE_ASSUME_YES is not set.');
    console.error('Installation aborted. Set TACKLE_ASSUME_YES=1 to auto-approve.');
    return false;
  }

  // Interactive mode: prompt user
  var answer = await promptUser('Confirm installation? [y/N] ');
  var confirmed = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';

  if (!confirmed) {
    console.log('Installation of ' + pluginName + ' cancelled by user.');
  }

  return confirmed;
}

/**
 * Prompt the user for input via readline.
 *
 * @param {string} question - The prompt text
 * @returns {Promise<string>} User input trimmed
 */
function promptUser(question) {
  return new Promise(function (resolve) {
    var rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, function (answer) {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

/**
 * Install command entry point.
 * Reads a plugin name, resolves its metadata, and runs security confirmation.
 */
module.exports = {
  name: 'install',
  description: 'Install an external plugin with security review',
  execute: function (ctx) {
    var pluginName = ctx.args && ctx.args[0];

    if (!pluginName) {
      console.error(ctx.colorize('Error: Plugin name required. Usage: tackle install <plugin-name>', 'red'));
      ctx.exit(1);
      return;
    }

    console.log('[tackle-harness] Installing plugin: ' + pluginName);

    // Read registry to find the plugin entry
    var registry = ctx.createBuilder()._readRegistry();
    var plugins = registry.plugins || [];
    var entry = null;
    for (var i = 0; i < plugins.length; i++) {
      if (plugins[i].name === pluginName) {
        entry = plugins[i];
        break;
      }
    }

    if (!entry) {
      console.error(ctx.colorize('Error: Plugin "' + pluginName + '" not found in registry', 'red'));
      ctx.exit(1);
      return;
    }

    // Core plugins don't need confirmation
    var sourceType = entry.sourceType || 'core';
    if (sourceType === 'core') {
      console.log('[tackle-harness] Core plugin — no security review needed.');
      console.log(ctx.colorize('[tackle-harness] Plugin ' + pluginName + ' installed.', 'green'));
      ctx.exit(0);
      return;
    }

    // External plugin: read plugin.json for capabilities
    var pluginDir;
    try {
      pluginDir = ctx.createBuilder()._resolvePluginDir(entry);
    } catch (err) {
      console.error(ctx.colorize('Error: Could not resolve plugin directory: ' + err.message, 'red'));
      ctx.exit(1);
      return;
    }

    var metaPath = path.join(pluginDir, 'plugin.json');
    if (!fs.existsSync(metaPath)) {
      console.error(ctx.colorize('Error: plugin.json not found at ' + metaPath, 'red'));
      ctx.exit(1);
      return;
    }

    var meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch (err) {
      console.error(ctx.colorize('Error: Invalid plugin.json: ' + err.message, 'red'));
      ctx.exit(1);
      return;
    }

    // Merge capabilities from plugin.json and registry entry
    var mergedEntry = {
      capabilities: meta.capabilities || entry.capabilities || {},
    };

    confirmInstall(pluginName, mergedEntry).then(function (confirmed) {
      if (confirmed) {
        console.log(ctx.colorize('[tackle-harness] Plugin ' + pluginName + ' installed.', 'green'));
        ctx.exit(0);
      } else {
        ctx.exit(1);
      }
    }).catch(function (err) {
      console.error(ctx.colorize('Error during installation: ' + err.message, 'red'));
      ctx.exit(1);
    });
  },
};

// Export confirmInstall for testing
module.exports.confirmInstall = confirmInstall;
module.exports.CAPABILITY_LEVELS = CAPABILITY_LEVELS;
