/**
 * Unit tests for context.js ctx.exit sentinel (A4)
 * Run with: node --test test/runtime/test-context-exit-sentinel.js
 *
 * A4: ctx.exit wraps process.exit, which kills the test runner — making
 * bin/commands hard to test. The fix: when TACKLE_TEST_MODE=1, ctx.exit throws
 * a sentinel error instead of calling process.exit, so tests can catch it.
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');

var contextMod = require('../../bin/context');

function makeCtx() {
  return contextMod.createContext({
    targetRoot: process.cwd(),
    packageRoot: path.resolve(__dirname, '../..'),
  });
}

test('A4: in test mode, ctx.exit throws ExitSignal sentinel (not process.exit)', function () {
  var origTestMode = process.env.TACKLE_TEST_MODE;
  process.env.TACKLE_TEST_MODE = '1';
  try {
    var ctx = makeCtx();
    assert.throws(
      function () { ctx.exit(2); },
      function (err) {
        return err.isExitSignal === true && err.exitCode === 2;
      },
      'ctx.exit(2) should throw a sentinel with isExitSignal=true and exitCode=2'
    );
  } finally {
    if (origTestMode === undefined) delete process.env.TACKLE_TEST_MODE;
    else process.env.TACKLE_TEST_MODE = origTestMode;
  }
});

test('A4: sentinel preserves arbitrary exit codes', function () {
  var origTestMode = process.env.TACKLE_TEST_MODE;
  process.env.TACKLE_TEST_MODE = '1';
  try {
    var ctx = makeCtx();
    [0, 1, 2, 42].forEach(function (code) {
      try {
        ctx.exit(code);
        assert.fail('should have thrown for code ' + code);
      } catch (err) {
        assert.strictEqual(err.isExitSignal, true, 'sentinel for code ' + code);
        assert.strictEqual(err.exitCode, code, 'exitCode ' + code + ' preserved');
      }
    });
  } finally {
    if (origTestMode === undefined) delete process.env.TACKLE_TEST_MODE;
    else process.env.TACKLE_TEST_MODE = origTestMode;
  }
});

test('A4: EXIT_SIGNAL constant is exported', function () {
  assert.strictEqual(typeof contextMod.EXIT_SIGNAL, 'string');
  assert.strictEqual(contextMod.EXIT_SIGNAL, 'ExitSignal');
});

test('A4: in production mode, ctx.exit does NOT throw sentinel', function () {
  // Production mode: ctx.exit would call process.exit. We can't actually call
  // it here (it would kill the runner). Instead, verify that when TACKLE_TEST_MODE
  // is unset, calling ctx.exit does NOT produce a sentinel by checking that the
  // function would reach process.exit. We stub process.exit temporarily.
  var origTestMode = process.env.TACKLE_TEST_MODE;
  delete process.env.TACKLE_TEST_MODE;
  var realExit = process.exit;
  var captured = null;
  process.exit = function (code) { captured = code; };
  try {
    var ctx = makeCtx();
    ctx.exit(0);
    assert.strictEqual(captured, 0, 'production mode calls process.exit(0)');
  } finally {
    process.exit = realExit;
    if (origTestMode !== undefined) process.env.TACKLE_TEST_MODE = origTestMode;
  }
});
