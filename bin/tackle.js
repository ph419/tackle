#!/usr/bin/env node
/**
 * tackle-harness - CLI entry point
 * Lightweight router: parses args, resolves --root, dispatches to commands/*.js
 * Run `tackle-harness --help` for usage.
 */

'use strict';

var path = require('path');
var fs = require('fs');
var safePath = require('../plugins/runtime/safe-path');
var createContext = require('./context').createContext;

var packageJson = require('../package.json');
var PACKAGE_VERSION = packageJson.version;

var packageRoot = path.resolve(__dirname, '..');
var targetRoot = process.cwd();

// CLI arg parsing

var args = process.argv.slice(2);
var flags = {
  root: null,
  verbose: false,
  noColor: false,
  help: false,
  version: false,
};

var filteredArgs = [];
// B10: helper to detect flag-shaped args so `--root --verbose` doesn't
// consume `--verbose` as the root path.
function _isFlag(arg) {
  return typeof arg === 'string' && arg.indexOf('--') === 0;
}
for (var i = 0; i < args.length; i++) {
  if (args[i] === '--root' && args[i + 1] && !_isFlag(args[i + 1])) {
    flags.root = args[++i];
  } else if (args[i] === '--verbose') {
    flags.verbose = true;
  } else if (args[i] === '--no-color') {
    flags.noColor = true;
  } else if (args[i] === '--version' || args[i] === '-v') {
    flags.version = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    flags.help = true;
  } else {
    filteredArgs.push(args[i]);
  }
}

var command;
if (flags.help) {
  command = 'help';
} else if (flags.version) {
  command = 'version';
} else {
  command = filteredArgs[0] || 'build';
}

// Minimal color helper for early errors before context is created
function colorize(text, color) {
  if (flags.noColor) return text;
  var codes = { red: '\x1b[31m', yellow: '\x1b[33m' };
  return (codes[color] || '') + text + '\x1b[0m';
}

// Resolve --root
if (flags.root) {
  var rootPath = flags.root;
  if (/^[a-zA-Z]:[^\\\/]/.test(rootPath)) {
    rootPath = rootPath.substring(0, 2) + '\\' + rootPath.substring(2);
  }
  var resolvedRoot = path.resolve(rootPath);
  var normalizedPath = path.normalize(resolvedRoot);

  try {
    var stats = fs.statSync(normalizedPath);
    if (!stats.isDirectory()) {
      console.error(colorize('Error: --root path must be a directory', 'red'));
      process.exit(1);
    }
  } catch (e) {
    if (command !== 'init') {
      console.error(colorize('Error: --root path does not exist: ' + normalizedPath, 'red'));
      process.exit(1);
    }
  }

  var cwdResolved = path.resolve(flags.root);
  // S6：用 isWithin 替代 indexOf===0，避免 /foo 误判为 /foobar 父目录
  if (!safePath.isWithin(process.cwd(), cwdResolved) && command !== 'init') {
    console.warn(colorize('Warning: --root path is outside current working directory', 'yellow'));
  }

  targetRoot = normalizedPath;
}

// Command loading and dispatch
var commandsDir = path.join(__dirname, 'commands');

/**
 * Built-in command name to module file mapping.
 * New commands can be added by simply creating a file in commands/.
 */
var commandModules = {
  'build': 'build.js',
  'validate': 'validate.js',
  'validate-config': 'validate-config.js',
  'init': 'init.js',
  'migrate': 'migrate.js',
  'status': 'status.js',
  'config': 'config.js',
  'list': 'list.js',
  'interactive': 'interactive.js',
  'i': 'interactive.js',
  'setup-global': 'setup-global.js',
  'version': 'version.js',
  'help': 'help.js',
  'install': 'install.js',
  'team-cleanup': 'team-cleanup.js',
  'loop': 'loop.js',
  'loop-server': 'loop-server.js',
};

function loadCommand(cmdName) {
  // Try built-in mapping first
  var moduleFile = commandModules[cmdName];
  if (moduleFile) {
    var modulePath = path.join(commandsDir, moduleFile);
    if (fs.existsSync(modulePath)) {
      return require(modulePath);
    }
  }

  // Try auto-discovery: commands/<cmdName>.js
  var autoPath = path.join(commandsDir, cmdName + '.js');
  if (fs.existsSync(autoPath)) {
    return require(autoPath);
  }

  // Check alias support in all command modules
  if (!fs.existsSync(commandsDir)) {
    return null;
  }
  var entries = fs.readdirSync(commandsDir);
  for (var j = 0; j < entries.length; j++) {
    if (entries[j].endsWith('.js')) {
      try {
        var mod = require(path.join(commandsDir, entries[j]));
        if (mod.aliases && mod.aliases.indexOf(cmdName) !== -1) {
          return mod;
        }
      } catch (e) {
        // skip unloadable modules
      }
    }
  }

  return null;
}

var cmdModule = loadCommand(command);

if (!cmdModule) {
  console.error(colorize('Error: Unknown command "' + command + '"', 'red'));
  console.error('');
  // Load help command to show usage
  var helpModule = loadCommand('help');
  if (helpModule) {
    var ctx = createContext({
      packageRoot: packageRoot,
      targetRoot: targetRoot,
      flags: flags,
      command: 'help',
      packageVersion: PACKAGE_VERSION,
    });
    helpModule.execute(ctx);
  }
  process.exit(1);
}

// Create context and execute.
// argv: command arguments after the command name (e.g. ['plan.md','--executor=local']).
var context = createContext({
  packageRoot: packageRoot,
  targetRoot: targetRoot,
  flags: flags,
  command: command,
  packageVersion: PACKAGE_VERSION,
  argv: filteredArgs.slice(1),
});

// #11：顶层错误兜底——命令可能同步抛错（如 team-cleanup 的非法输入），
// 也可能返回被 reject 的 Promise（如 loop/loop-server 异步命令）。
// 任一情况都给出干净的退出码 + 错误信息，而非裸露的 Node 堆栈/unhandledRejection。
function failCommand(err) {
  var msg = err && err.message ? err.message : String(err);
  console.error(colorize('Error: ' + msg, 'red'));
  process.exit(1);
}

try {
  var result = cmdModule.execute(context);
  // 异步命令：result 是 Promise（或 thenable）→ 捕获 rejection
  if (result && typeof result.then === 'function') {
    result.then(function (exitEarly) {
      // 命令可能 resolve 一个退出码（约定 truthy 即视为已 exit；正常 resolve 无需动作）
      if (exitEarly && typeof exitEarly === 'number') process.exit(exitEarly);
    }, failCommand);
  }
} catch (err) {
  failCommand(err);
}
