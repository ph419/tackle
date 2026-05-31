'use strict';

/**
 * Validate-config command - Validate harness-config.yaml
 * @public
 */
module.exports = {
  name: 'validate-config',
  description: 'Validate harness-config.yaml',
  /**
   * Execute the validate-config command.
   * @public
   * @param {object} ctx - CLI context object
   */
  execute: function (ctx) {
    var builder = ctx.createBuilder();
    var result = builder.validateConfig();
    console.log(result.summary);
    if (!result.valid) {
      console.log('');
      console.log('Errors:');
      for (var i = 0; i < result.errors.length; i++) {
        console.log('  - ' + result.errors[i]);
      }
    }
    if (result.warnings.length > 0) {
      console.log('');
      console.log('Warnings:');
      for (var j = 0; j < result.warnings.length; j++) {
        console.log('  - ' + result.warnings[j]);
      }
    }
    ctx.exit(result.valid ? 0 : 1);
  },
};
