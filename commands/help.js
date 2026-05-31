'use strict';

/**
 * Help command - Show usage info
 * @public
 */
module.exports = {
  name: 'help',
  description: 'Show this help message',
  /**
   * Execute the help command.
   * @public
   * @param {object} ctx - CLI context object
   */
  execute: function (ctx) {
    console.log(ctx.colorize('tackle-harness - Plugin-based AI Agent Harness for Claude Code', 'cyan'));
    console.log('');
    console.log('Usage:');
    console.log('  tackle-harness [command] [options]');
    console.log('');
    console.log('Commands:');
    var helpCommands = [
      ['build', 'Build all plugins (default)'],
      ['validate', 'Validate plugin.json files'],
      ['validate-config', 'Validate harness-config.yaml'],
      ['init', 'First-time setup (build + config)'],
      ['install', 'Install an external plugin with security review'],
      ['migrate', 'Migrate legacy project structure to global setup'],
      ['status', 'Show build status and plugin statistics'],
      ['config', 'Show/validate current configuration'],
      ['list', 'List all registered plugins'],
      ['interactive', 'Interactive plugin management (alias: i)'],
      ['setup-global', 'Install global skills to ~/.claude/skills/'],
      ['version', 'Show version information'],
      ['help', 'Show this help message'],
    ];
    var maxCmdLen = 0;
    for (var ci = 0; ci < helpCommands.length; ci++) {
      if (helpCommands[ci][0].length > maxCmdLen) maxCmdLen = helpCommands[ci][0].length;
    }
    for (var hi = 0; hi < helpCommands.length; hi++) {
      var cmdName = helpCommands[hi][0];
      var cmdPad = ' '.repeat(maxCmdLen - cmdName.length + 2);
      console.log('  ' + ctx.colorize(cmdName, 'green') + cmdPad + helpCommands[hi][1]);
    }
    console.log('');
    console.log('Options:');
    console.log('  --root <path>       Specify target project root (default: cwd)');
    console.log('  --verbose           Show detailed build output');
    console.log('  --no-color          Disable colored output');
    console.log('  --help, -h          Show this help message');
    console.log('  --version, -v       Show version information');
    console.log('');
    console.log('After running ' + ctx.colorize('tackle-harness build', 'green') + ', skills are available in .claude/skills/');
    console.log('and hooks are registered in .claude/settings.json');
  },
};
