/**
 * Unit tests for setup-global command (H4 / B16 / T2)
 * Run with: node --test test/runtime/test-setup-global.js
 *
 * Coverage:
 *   - B16: verify the source uses os.homedir() (static check, since the real
 *     execute writes into the user's actual ~/.claude — not safe to run here)
 *   - H4/T2: previously this command had zero test coverage
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

var setupGlobal = require('../../bin/commands/setup-global');

test('setup-global command metadata', function () {
  assert.strictEqual(setupGlobal.name, 'setup-global');
  assert.ok(typeof setupGlobal.description === 'string');
  assert.strictEqual(typeof setupGlobal.execute, 'function');
});

test('B16: source uses os.homedir() for resolution (not HOME||USERPROFILE lookup)', function () {
  // Static check: read the source and verify the fix is present. We can't
  // safely run execute() in a unit test because it writes into the real
  // ~/.claude directory.
  var src = fs.readFileSync(path.resolve(__dirname, '../../bin/commands/setup-global.js'), 'utf8');
  assert.ok(src.indexOf('os.homedir()') !== -1,
    'setup-global must use os.homedir() for home dir resolution (B16)');
  // The OLD bug was `var homeDir = process.env.HOME || process.env.USERPROFILE`.
  // Verify that pattern is gone (the comment mentioning it is fine — only the
  // actual assignment matters).
  assert.ok(src.indexOf('homeDir = process.env.HOME') === -1 &&
            src.indexOf('homeDir = process.env.USERPROFILE') === -1,
    'setup-global must NOT assign homeDir from process.env.HOME/USERPROFILE (B16)');
  // exit(1) must be followed by return (B16: exit doesn't halt flow)
  assert.ok(/ctx\.exit\(1\)[\s\S]*?return/.test(src),
    'setup-global must return after ctx.exit(1) (B16)');
});

test('B16: requires os module', function () {
  var src = fs.readFileSync(path.resolve(__dirname, '../../bin/commands/setup-global.js'), 'utf8');
  assert.ok(src.indexOf("require('os')") !== -1 || src.indexOf('require("os")') !== -1,
    'setup-global must require os module for os.homedir() (B16)');
});
