/**
 * build-cli - CLI entry point for HarnessBuild
 *
 * Provides the command-line interface for building and validating plugins.
 * Separated from harness-build.js to keep CLI concerns isolated from core logic.
 *
 * @module build-cli
 *
 * Usage:
 *   node plugins/runtime/build-cli.js             # build all plugins
 *   node plugins/runtime/build-cli.js --validate   # validate only
 */

'use strict';

var HarnessBuild = require('./harness-build');

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Run the CLI.
 * @public
 * @param {string[]} argv - process.argv
 */
function main(argv) {
  var args = argv.slice(2);
  var mode = 'build'; // default mode

  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--validate') {
      mode = 'validate';
    } else if (args[i] === '--validate-config') {
      mode = 'validate-config';
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node plugins/runtime/harness-build.js [OPTIONS]');
      console.log('');
      console.log('Options:');
      console.log('  --validate         Validate plugin.json files without building');
      console.log('  --validate-config  Validate harness-config.yaml file');
      console.log('  --help, -h         Show this help message');
      process.exit(0);
    }
  }

  var builder = new HarnessBuild();

  if (mode === 'validate') {
    var result = builder.validate();
    console.log(result.summary);
    process.exit(result.valid ? 0 : 1);
  } else if (mode === 'validate-config') {
    var configResult = builder.validateConfig();
    console.log(configResult.summary);
    if (!configResult.valid) {
      console.log('');
      console.log('Errors:');
      for (var j = 0; j < configResult.errors.length; j++) {
        console.log('  - ' + configResult.errors[j]);
      }
    }
    if (configResult.warnings.length > 0) {
      console.log('');
      console.log('Warnings:');
      for (var k = 0; k < configResult.warnings.length; k++) {
        console.log('  - ' + configResult.warnings[k]);
      }
    }
    process.exit(configResult.valid ? 0 : 1);
  } else {
    var buildResult = builder.build();
    console.log(buildResult.summary);
    process.exit(buildResult.success ? 0 : 1);
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  main: main,
};

// Run directly if executed as main
if (require.main === module) {
  main(process.argv);
}
