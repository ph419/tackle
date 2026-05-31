'use strict';

/**
 * Validate command - Validate plugin.json files without building
 * @public
 */
module.exports = {
  name: 'validate',
  description: 'Validate plugin.json files',
  /**
   * Execute the validate command.
   * @public
   * @param {object} ctx - CLI context object
   */
  execute: function (ctx) {
    var builder = ctx.createBuilder();
    var result = builder.validate();
    console.log(result.summary);
    ctx.exit(result.valid ? 0 : 1);
  },
};
