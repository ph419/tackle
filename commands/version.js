'use strict';

/**
 * Version command - Show version information
 * @public
 */
module.exports = {
  name: 'version',
  description: 'Show version information',
  /**
   * Execute the version command.
   * @public
   * @param {object} ctx - CLI context object
   */
  execute: function (ctx) {
    console.log('tackle-harness v' + ctx.packageVersion);
    console.log('');
    console.log('Node.js version: ' + process.version);
    console.log('Package root: ' + ctx.packageRoot);
    ctx.exit(0);
  },
};
