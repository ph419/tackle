/**
 * Unit tests for WP-117-4: AuditLogger (JSONL persistence)
 *
 * Tests:
 *   - Constructor and default options
 *   - log() with buffering
 *   - logCapabilityCheck() shorthand
 *   - logSandboxEvent() shorthand
 *   - logPluginLoad() shorthand
 *   - flush() writes to disk
 *   - query() reads from log file
 *   - getLogFilePath() date formatting
 *   - destroy() cleanup
 *
 * Run with: node --test test/runtime/test-audit-logger.js
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var os = require('os');

var AuditLogger = require('../../plugins/runtime/audit-logger');

/**
 * Create a temp directory for test audit logs.
 * @returns {string} temp directory path
 */
function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
}

/**
 * Clean up a temp directory.
 * @param {string} dir
 */
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

test.describe('AuditLogger constructor', function () {
  test('should create with default options', function () {
    var logger = new AuditLogger();
    assert.ok(logger);
    assert.ok(typeof logger.getLogFilePath === 'function');
    logger.destroy();
  });

  test('should accept custom logDir', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir });
    assert.equal(logger.getLogFilePath().indexOf(tmpDir), 0);
    logger.destroy();
    cleanup(tmpDir);
  });

  test('should accept sessionId', function () {
    var logger = new AuditLogger({ sessionId: 'test-session-123' });
    logger.flush = function () {
      // Override flush to capture entries
      var entries = logger._buffer.slice();
      assert.ok(entries.length === 0 || entries[0].sessionId === 'test-session-123');
    };
    logger.destroy();
  });
});

// ---------------------------------------------------------------------------
// log() and flush()
// ---------------------------------------------------------------------------

test.describe('AuditLogger log() and flush()', function () {
  test('should buffer entries', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir, flushInterval: 60000 });

    logger.log('capability.check', 'test-plugin', {
      decision: 'allow',
      capability: 'fs.read',
    });

    assert.equal(logger._buffer.length, 1, 'should have 1 buffered entry');
    logger.destroy();
    cleanup(tmpDir);
  });

  test('should flush to JSONL file', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir, flushInterval: 60000 });

    logger.log('capability.check', 'test-plugin', {
      decision: 'allow',
      capability: 'fs.read',
      detail: 'path=/tmp',
    });
    logger.flush();

    var logPath = logger.getLogFilePath();
    assert.ok(fs.existsSync(logPath), 'log file should exist after flush');

    var content = fs.readFileSync(logPath, 'utf-8');
    var lines = content.trim().split('\n');
    assert.equal(lines.length, 1, 'should have 1 line');

    var entry = JSON.parse(lines[0]);
    assert.equal(entry.event, 'capability.check');
    assert.equal(entry.plugin, 'test-plugin');
    assert.equal(entry.decision, 'allow');
    assert.equal(entry.capability, 'fs.read');
    assert.ok(entry.timestamp);

    logger.destroy();
    cleanup(tmpDir);
  });

  test('should auto-flush when buffer is full', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({
      logDir: tmpDir,
      maxBufferSize: 3,
      flushInterval: 60000,
    });

    logger.log('test', 'p1', { decision: 'allow' });
    logger.log('test', 'p2', { decision: 'allow' });
    logger.log('test', 'p3', { decision: 'allow' }); // triggers auto-flush

    assert.equal(logger._buffer.length, 0, 'buffer should be empty after auto-flush');

    var logPath = logger.getLogFilePath();
    var content = fs.readFileSync(logPath, 'utf-8');
    var lines = content.trim().split('\n');
    assert.equal(lines.length, 3, 'should have 3 lines in log file');

    logger.destroy();
    cleanup(tmpDir);
  });

  test('should append multiple flushes to same file', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir, flushInterval: 60000 });

    logger.log('test', 'p1', { decision: 'allow' });
    logger.flush();
    logger.log('test', 'p2', { decision: 'deny' });
    logger.flush();

    var logPath = logger.getLogFilePath();
    var content = fs.readFileSync(logPath, 'utf-8');
    var lines = content.trim().split('\n');
    assert.equal(lines.length, 2, 'should have 2 lines');

    var entry1 = JSON.parse(lines[0]);
    var entry2 = JSON.parse(lines[1]);
    assert.equal(entry1.decision, 'allow');
    assert.equal(entry2.decision, 'deny');

    logger.destroy();
    cleanup(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// Shorthand methods
// ---------------------------------------------------------------------------

test.describe('AuditLogger shorthand methods', function () {
  test('logCapabilityCheck() should create correct entry', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir, flushInterval: 60000 });

    logger.logCapabilityCheck('my-plugin', 'fs.read', 'deny', 'not declared', 'npm');
    logger.flush();

    var entries = logger.query();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event, 'capability.check');
    assert.equal(entries[0].plugin, 'my-plugin');
    assert.equal(entries[0].capability, 'fs.read');
    assert.equal(entries[0].decision, 'deny');
    assert.equal(entries[0].sourceType, 'npm');
    assert.equal(entries[0].detail, 'not declared');

    logger.destroy();
    cleanup(tmpDir);
  });

  test('logSandboxEvent() should create correct entry', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir, flushInterval: 60000 });

    logger.logSandboxEvent('sandbox.create', 'my-plugin', 'threadId=42');
    logger.flush();

    var entries = logger.query();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event, 'sandbox.create');
    assert.equal(entries[0].detail, 'threadId=42');

    logger.destroy();
    cleanup(tmpDir);
  });

  test('logPluginLoad() should create correct entry', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir, flushInterval: 60000 });

    logger.logPluginLoad('my-plugin', 'npm', 'allow', 'all capabilities reviewed');
    logger.flush();

    var entries = logger.query();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event, 'plugin.load');
    assert.equal(entries[0].plugin, 'my-plugin');
    assert.equal(entries[0].sourceType, 'npm');
    assert.equal(entries[0].decision, 'allow');

    logger.destroy();
    cleanup(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// query()
// ---------------------------------------------------------------------------

test.describe('AuditLogger query()', function () {
  test('should filter by event', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir, flushInterval: 60000 });

    logger.log('capability.check', 'p1', { decision: 'allow' });
    logger.log('sandbox.create', 'p1', { decision: 'allow' });
    logger.log('capability.check', 'p2', { decision: 'deny' });
    logger.flush();

    var entries = logger.query({ event: 'capability.check' });
    assert.equal(entries.length, 2);

    logger.destroy();
    cleanup(tmpDir);
  });

  test('should filter by plugin', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir, flushInterval: 60000 });

    logger.log('test', 'plugin-a', { decision: 'allow' });
    logger.log('test', 'plugin-b', { decision: 'deny' });
    logger.log('test', 'plugin-a', { decision: 'warn' });
    logger.flush();

    var entries = logger.query({ plugin: 'plugin-a' });
    assert.equal(entries.length, 2);

    logger.destroy();
    cleanup(tmpDir);
  });

  test('should filter by decision', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir, flushInterval: 60000 });

    logger.log('test', 'p1', { decision: 'allow' });
    logger.log('test', 'p2', { decision: 'deny' });
    logger.log('test', 'p3', { decision: 'allow' });
    logger.flush();

    var entries = logger.query({ decision: 'deny' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].plugin, 'p2');

    logger.destroy();
    cleanup(tmpDir);
  });

  test('should respect limit', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir, flushInterval: 60000 });

    for (var i = 0; i < 10; i++) {
      logger.log('test', 'p' + i, { decision: 'allow' });
    }
    logger.flush();

    var entries = logger.query({ limit: 3 });
    assert.equal(entries.length, 3);

    logger.destroy();
    cleanup(tmpDir);
  });

  test('should return empty for empty log file', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir, flushInterval: 60000 });

    var entries = logger.query();
    assert.equal(entries.length, 0);

    logger.destroy();
    cleanup(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// getLogFilePath()
// ---------------------------------------------------------------------------

test.describe('AuditLogger getLogFilePath()', function () {
  test('should return path with date pattern', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir });

    var logPath = logger.getLogFilePath();
    assert.ok(logPath.indexOf('audit-') !== -1, 'should contain audit- prefix');
    assert.ok(logPath.endsWith('.jsonl'), 'should end with .jsonl');

    logger.destroy();
    cleanup(tmpDir);
  });

  test('should use provided date', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir });

    var date = new Date('2026-05-30T12:00:00Z');
    var logPath = logger.getLogFilePath(date);
    assert.ok(logPath.indexOf('audit-20260530') !== -1);

    logger.destroy();
    cleanup(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// destroy()
// ---------------------------------------------------------------------------

test.describe('AuditLogger destroy()', function () {
  test('should flush remaining entries on destroy', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir, flushInterval: 60000 });

    logger.log('test', 'p1', { decision: 'allow' });
    logger.destroy();

    var logPath = logger.getLogFilePath();
    assert.ok(fs.existsSync(logPath), 'log file should exist after destroy');

    var content = fs.readFileSync(logPath, 'utf-8');
    assert.ok(content.indexOf('test') !== -1, 'should have flushed the entry');

    cleanup(tmpDir);
  });

  test('should not accept new entries after destroy', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir, flushInterval: 60000 });

    logger.destroy();
    logger.log('test', 'p1', { decision: 'allow' });

    // Buffer should remain empty because destroy() prevents new entries
    assert.equal(logger._buffer.length, 0);

    cleanup(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// sessionId
// ---------------------------------------------------------------------------

test.describe('AuditLogger sessionId', function () {
  test('should include sessionId in entries', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir, sessionId: 'sess-abc', flushInterval: 60000 });

    logger.log('test', 'p1', { decision: 'allow' });
    logger.flush();

    var entries = logger.query();
    assert.equal(entries[0].sessionId, 'sess-abc');

    logger.destroy();
    cleanup(tmpDir);
  });

  test('should omit sessionId when not set', function () {
    var tmpDir = createTempDir();
    var logger = new AuditLogger({ logDir: tmpDir, flushInterval: 60000 });

    logger.log('test', 'p1', { decision: 'allow' });
    logger.flush();

    var entries = logger.query();
    assert.equal(entries[0].sessionId, undefined);

    logger.destroy();
    cleanup(tmpDir);
  });
});
