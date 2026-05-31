'use strict';

var fs = require('fs');

/**
 * Config command - Show/validate current configuration
 * @public
 */
module.exports = {
  name: 'config',
  description: 'Show/validate current configuration',
  /**
   * Execute the config command.
   * @public
   * @param {object} ctx - CLI context object
   */
  execute: function (ctx) {
    console.log(ctx.colorize('=== Tackle Harness Configuration ===', 'cyan'));
    console.log('');

    var configPath = ctx.configPath;

    if (!fs.existsSync(configPath)) {
      console.log(ctx.colorize('Configuration file not found:', 'yellow'));
      console.log('  ' + configPath);
      console.log('');
      console.log('Run "tackle-harness init" to create a default configuration.');
      ctx.exit(1);
    }

    console.log('Configuration file: ' + configPath);
    console.log('');

    // Validate configuration
    var builder = ctx.createBuilder();
    var result = builder.validateConfig();

    console.log('Validation status: ' + (result.valid ? ctx.colorize('Valid', 'green') : ctx.colorize('Invalid', 'red')));

    if (result.warnings.length > 0) {
      console.log('');
      console.log(ctx.colorize('Warnings:', 'yellow'));
      for (var i = 0; i < result.warnings.length; i++) {
        console.log('  - ' + result.warnings[i]);
      }
    }

    if (!result.valid) {
      console.log('');
      console.log(ctx.colorize('Errors:', 'red'));
      for (var j = 0; j < result.errors.length; j++) {
        console.log('  - ' + result.errors[j]);
      }
      ctx.exit(1);
    }

    // Show configuration summary
    console.log('');
    console.log(ctx.colorize('Configuration Summary:', 'cyan'));

    try {
      var content = fs.readFileSync(configPath, 'utf-8');
      var lines = content.split('\n');

      // Extract and display top-level sections (zero-indent keys only)
      var sections = [];
      for (var k = 0; k < lines.length; k++) {
        var line = lines[k];
        var trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('-') &&
            line === line.trimStart() && line.indexOf(':') !== -1) {
          var sectionName = line.split(':')[0].trim();
          if (sectionName && /^[a-z_]/.test(sectionName)) {
            sections.push(sectionName);
          }
        }
      }

      if (sections.length > 0) {
        console.log('  Sections: ' + sections.join(', '));
      }
    } catch (e) {
      console.log('  (Unable to parse configuration for summary)');
    }

    ctx.exit(0);
  },
};
