/**
 * Unit tests for WP-117-3: Capabilities runtime enforcement
 *
 * Tests:
 *   - Capability enumeration values
 *   - CapabilityLevel classification
 *   - CAPABILITY_LEVELS mapping
 *   - TRUST_LEVELS and CAPABILITY_RESTRICTIONS
 *   - isCapabilityAllowed() for core/npm/local source types
 *   - shouldSandbox()
 *   - getAllowedCapabilities()
 *
 * Run with: node --test test/runtime/test-capabilities.js
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

var caps = require('../../plugins/contracts/capabilities');
var Capability = caps.Capability;
var CapabilityLevel = caps.CapabilityLevel;
var CAPABILITY_LEVELS = caps.CAPABILITY_LEVELS;
var TRUST_LEVELS = caps.TRUST_LEVELS;
var CAPABILITY_RESTRICTIONS = caps.CAPABILITY_RESTRICTIONS;
var isCapabilityAllowed = caps.isCapabilityAllowed;
var shouldSandbox = caps.shouldSandbox;
var getAllowedCapabilities = caps.getAllowedCapabilities;

// ---------------------------------------------------------------------------
// Capability enumeration
// ---------------------------------------------------------------------------

test.describe('Capability enumeration', function () {
  test('should define all expected capabilities', function () {
    assert.equal(Capability.FS_READ, 'fs.read');
    assert.equal(Capability.FS_WRITE, 'fs.write');
    assert.equal(Capability.NET_REQUEST, 'net.request');
    assert.equal(Capability.NET_LISTEN, 'net.listen');
    assert.equal(Capability.CHILD_PROCESS, 'child_process');
    assert.equal(Capability.ENV_READ, 'env.read');
    assert.equal(Capability.PLUGIN_ACCESS, 'plugin.access');
  });

  test('should be frozen (immutable)', function () {
    assert.ok(Object.isFrozen(Capability));
  });

  test('should have 7 capabilities defined', function () {
    assert.equal(Object.keys(Capability).length, 7);
  });
});

// ---------------------------------------------------------------------------
// CapabilityLevel classification
// ---------------------------------------------------------------------------

test.describe('CapabilityLevel', function () {
  test('should define four risk levels', function () {
    assert.equal(CapabilityLevel.SAFE, 'safe');
    assert.equal(CapabilityLevel.LOW_RISK, 'low_risk');
    assert.equal(CapabilityLevel.MEDIUM, 'medium');
    assert.equal(CapabilityLevel.HIGH_RISK, 'high_risk');
  });

  test('should be frozen', function () {
    assert.ok(Object.isFrozen(CapabilityLevel));
  });
});

// ---------------------------------------------------------------------------
// CAPABILITY_LEVELS mapping
// ---------------------------------------------------------------------------

test.describe('CAPABILITY_LEVELS mapping', function () {
  test('should map fs.read to LOW_RISK', function () {
    assert.equal(CAPABILITY_LEVELS['fs.read'], CapabilityLevel.LOW_RISK);
  });

  test('should map fs.write to MEDIUM', function () {
    assert.equal(CAPABILITY_LEVELS['fs.write'], CapabilityLevel.MEDIUM);
  });

  test('should map net.request to MEDIUM', function () {
    assert.equal(CAPABILITY_LEVELS['net.request'], CapabilityLevel.MEDIUM);
  });

  test('should map net.listen to HIGH_RISK', function () {
    assert.equal(CAPABILITY_LEVELS['net.listen'], CapabilityLevel.HIGH_RISK);
  });

  test('should map child_process to HIGH_RISK', function () {
    assert.equal(CAPABILITY_LEVELS['child_process'], CapabilityLevel.HIGH_RISK);
  });

  test('should map env.read to LOW_RISK', function () {
    assert.equal(CAPABILITY_LEVELS['env.read'], CapabilityLevel.LOW_RISK);
  });

  test('should map plugin.access to LOW_RISK', function () {
    assert.equal(CAPABILITY_LEVELS['plugin.access'], CapabilityLevel.LOW_RISK);
  });

  test('should be frozen', function () {
    assert.ok(Object.isFrozen(CAPABILITY_LEVELS));
  });
});

// ---------------------------------------------------------------------------
// TRUST_LEVELS
// ---------------------------------------------------------------------------

test.describe('TRUST_LEVELS', function () {
  test('should define core as full trust', function () {
    assert.equal(TRUST_LEVELS.core, 'full');
  });

  test('should define npm as moderate trust', function () {
    assert.equal(TRUST_LEVELS.npm, 'moderate');
  });

  test('should define local as low trust', function () {
    assert.equal(TRUST_LEVELS.local, 'low');
  });
});

// ---------------------------------------------------------------------------
// CAPABILITY_RESTRICTIONS matrix
// ---------------------------------------------------------------------------

test.describe('CAPABILITY_RESTRICTIONS', function () {
  test('core should have auto for all capabilities', function () {
    var core = CAPABILITY_RESTRICTIONS.core;
    var keys = Object.keys(core);
    for (var i = 0; i < keys.length; i++) {
      assert.equal(core[keys[i]], 'auto', 'core.' + keys[i] + ' should be auto');
    }
  });

  test('npm should forbid child_process', function () {
    assert.equal(CAPABILITY_RESTRICTIONS.npm['child_process'], 'forbidden');
  });

  test('local should forbid child_process', function () {
    assert.equal(CAPABILITY_RESTRICTIONS.local['child_process'], 'forbidden');
  });

  test('npm should require declaration for fs.read', function () {
    assert.equal(CAPABILITY_RESTRICTIONS.npm['fs.read'], 'declared');
  });

  test('local should require declaration for fs.read', function () {
    assert.equal(CAPABILITY_RESTRICTIONS.local['fs.read'], 'declared');
  });

  test('npm should require declaration for net.request', function () {
    assert.equal(CAPABILITY_RESTRICTIONS.npm['net.request'], 'declared');
  });

  test('npm should require declaration for plugin.access', function () {
    assert.equal(CAPABILITY_RESTRICTIONS.npm['plugin.access'], 'declared');
  });
});

// ---------------------------------------------------------------------------
// isCapabilityAllowed()
// ---------------------------------------------------------------------------

test.describe('isCapabilityAllowed() — core', function () {
  test('should allow all capabilities for core', function () {
    var allCaps = Object.keys(Capability).map(function (k) { return Capability[k]; });
    for (var i = 0; i < allCaps.length; i++) {
      var result = isCapabilityAllowed('core', allCaps[i]);
      assert.ok(result.allowed, 'core should allow ' + allCaps[i]);
    }
  });

  test('should return reason for core', function () {
    var result = isCapabilityAllowed('core', Capability.FS_READ);
    assert.ok(result.reason.indexOf('core') !== -1);
  });
});

test.describe('isCapabilityAllowed() — npm', function () {
  test('should deny fs.read without declaration', function () {
    var result = isCapabilityAllowed('npm', Capability.FS_READ);
    assert.equal(result.allowed, false);
    assert.ok(result.reason.indexOf('not declared') !== -1);
  });

  test('should allow fs.read with declaration', function () {
    var result = isCapabilityAllowed('npm', Capability.FS_READ, {
      filesystem: { read: ['/tmp'] },
    });
    assert.equal(result.allowed, true);
  });

  test('should deny fs.read when explicitly false', function () {
    var result = isCapabilityAllowed('npm', Capability.FS_READ, {
      filesystem: false,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.reason.indexOf('explicitly disabled') !== -1);
  });

  test('should always forbid child_process', function () {
    var result = isCapabilityAllowed('npm', Capability.CHILD_PROCESS, {
      child_process: true,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.reason.indexOf('forbidden') !== -1);
  });

  test('should deny net.request without declaration', function () {
    var result = isCapabilityAllowed('npm', Capability.NET_REQUEST);
    assert.equal(result.allowed, false);
  });

  test('should allow net.request with declaration', function () {
    var result = isCapabilityAllowed('npm', Capability.NET_REQUEST, {
      network: { request: true },
    });
    assert.equal(result.allowed, true);
  });

  test('should deny plugin.access without declaration', function () {
    var result = isCapabilityAllowed('npm', Capability.PLUGIN_ACCESS);
    assert.equal(result.allowed, false);
  });

  test('should allow plugin.access with declaration', function () {
    var result = isCapabilityAllowed('npm', Capability.PLUGIN_ACCESS, {
      plugin_access: true,
    });
    assert.equal(result.allowed, true);
  });
});

test.describe('isCapabilityAllowed() — local', function () {
  test('should deny fs.write without declaration', function () {
    var result = isCapabilityAllowed('local', Capability.FS_WRITE);
    assert.equal(result.allowed, false);
  });

  test('should allow fs.write with declaration', function () {
    var result = isCapabilityAllowed('local', Capability.FS_WRITE, {
      filesystem: { write: ['/tmp'] },
    });
    assert.equal(result.allowed, true);
  });

  test('should always forbid child_process', function () {
    var result = isCapabilityAllowed('local', Capability.CHILD_PROCESS, {
      child_process: true,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.reason.indexOf('forbidden') !== -1);
  });

  test('should deny env.read without declaration', function () {
    var result = isCapabilityAllowed('local', Capability.ENV_READ);
    assert.equal(result.allowed, false);
  });

  test('should allow env.read with declaration', function () {
    var result = isCapabilityAllowed('local', Capability.ENV_READ, {
      env: ['MY_VAR'],
    });
    assert.equal(result.allowed, true);
  });
});

test.describe('isCapabilityAllowed() — unknown sourceType', function () {
  test('should deny for unknown sourceType', function () {
    var result = isCapabilityAllowed('unknown', Capability.FS_READ);
    assert.equal(result.allowed, false);
    assert.ok(result.reason.indexOf('unknown sourceType') !== -1);
  });
});

// ---------------------------------------------------------------------------
// shouldSandbox()
// ---------------------------------------------------------------------------

test.describe('shouldSandbox()', function () {
  test('should return false for core', function () {
    assert.equal(shouldSandbox('core'), false);
  });

  test('should return true for npm', function () {
    assert.equal(shouldSandbox('npm'), true);
  });

  test('should return true for local', function () {
    assert.equal(shouldSandbox('local'), true);
  });
});

// ---------------------------------------------------------------------------
// getAllowedCapabilities()
// ---------------------------------------------------------------------------

test.describe('getAllowedCapabilities()', function () {
  test('should return all 7 capabilities for core', function () {
    var allowed = getAllowedCapabilities('core');
    assert.equal(allowed.length, 7);
  });

  test('should return empty for npm without declarations', function () {
    var allowed = getAllowedCapabilities('npm');
    assert.equal(allowed.length, 0);
  });

  test('should return declared capabilities for npm', function () {
    var allowed = getAllowedCapabilities('npm', {
      filesystem: { read: ['/tmp'] },
      network: true,
      env: ['MY_VAR'],
    });
    assert.ok(allowed.indexOf('fs.read') !== -1, 'should include fs.read');
    assert.ok(allowed.indexOf('net.request') !== -1, 'should include net.request');
    assert.ok(allowed.indexOf('net.listen') !== -1, 'should include net.listen');
    assert.ok(allowed.indexOf('env.read') !== -1, 'should include env.read');
    assert.ok(allowed.indexOf('child_process') === -1, 'should not include child_process');
  });

  test('should return empty for local without declarations', function () {
    var allowed = getAllowedCapabilities('local');
    assert.equal(allowed.length, 0);
  });
});
