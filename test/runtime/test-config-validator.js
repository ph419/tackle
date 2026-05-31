/**
 * test-config-validator.js - Unit tests for plugins/runtime/config-validator.js
 *
 * Covers:
 *   - Valid config passes validation
 *   - Missing required fields
 *   - Type mismatch errors
 *   - Empty config handling
 *   - Partial field handling
 *   - Unknown fields handling
 *   - Default value filling
 *   - Nested config validation
 *   - Edge cases (null, undefined, empty string)
 *   - Multiple section validation simultaneously
 *   - validateFile() with temp files
 *   - Custom schema support
 */

'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var describe = require('node:test').describe;
var it = require('node:test').it;
var assert = require('node:assert');

var ConfigValidator = require('../../plugins/runtime/config-validator');

// ---------------------------------------------------------------------------
// validate() - valid configs
// ---------------------------------------------------------------------------

describe('ConfigValidator.validate()', function () {
  it('should pass validation for a valid config object', function () {
    var validator = new ConfigValidator();
    var config = {
      context_window: {
        max_tokens: 200000,
        strategy: 'auto'
      }
    };
    var result = validator.validate(config);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  it('should pass validation for empty config (all sections optional)', function () {
    var validator = new ConfigValidator();
    var result = validator.validate({});
    assert.strictEqual(result.valid, true);
  });

  it('should report error when config is null', function () {
    var validator = new ConfigValidator();
    var result = validator.validate(null);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].indexOf('must be an object') !== -1);
  });

  it('should report error when config is not an object', function () {
    var validator = new ConfigValidator();
    var result = validator.validate('not an object');
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors[0].indexOf('must be an object') !== -1);
  });

  it('should report error when config is undefined', function () {
    var validator = new ConfigValidator();
    var result = validator.validate(undefined);
    assert.strictEqual(result.valid, false);
  });

  it('should report type mismatch for wrong field types', function () {
    var validator = new ConfigValidator();
    var config = {
      context_window: {
        max_tokens: 'not-a-number'
      }
    };
    var result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(function (e) {
      return e.indexOf('must be of type number') !== -1;
    }));
  });

  it('should report error for invalid allowedValues', function () {
    var validator = new ConfigValidator();
    var config = {
      context_window: {
        strategy: 'invalid_strategy'
      }
    };
    var result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(function (e) {
      return e.indexOf('invalid value') !== -1 && e.indexOf('invalid_strategy') !== -1;
    }));
  });

  it('should validate nested config objects', function () {
    var validator = new ConfigValidator();
    var config = {
      context_window: {
        thresholds: {
          small: 'not-a-number'
        }
      }
    };
    var result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(function (e) {
      return e.indexOf('thresholds') !== -1;
    }));
  });

  it('should handle multiple sections simultaneously', function () {
    var validator = new ConfigValidator();
    var config = {
      context_window: {
        max_tokens: 100000
      },
      roles: {
        roles_dir: '.claude/agents/roles'
      },
      memory: {
        format: 'json'
      }
    };
    var result = validator.validate(config);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  it('should accept partial fields (optional fields can be omitted)', function () {
    var validator = new ConfigValidator();
    var config = {
      context_window: {
        max_tokens: 50000
        // strategy omitted — has default
      }
    };
    var result = validator.validate(config);
    assert.strictEqual(result.valid, true);
  });

  it('should not report errors for unknown top-level fields (schema only checks known fields)', function () {
    var validator = new ConfigValidator();
    var config = {
      unknown_section: {
        foo: 'bar'
      },
      context_window: {
        max_tokens: 100
      }
    };
    var result = validator.validate(config);
    // Unknown fields are silently ignored (not in schema)
    assert.strictEqual(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// validateFile()
// ---------------------------------------------------------------------------

describe('ConfigValidator.validateFile()', function () {
  it('should validate a valid YAML config file', function () {
    var tmpDir = os.tmpdir();
    var tmpFile = path.join(tmpDir, 'test-config-validator-' + Date.now() + '.yaml');
    var content = 'context_window:\n  max_tokens: 200000\n  strategy: auto\n';
    fs.writeFileSync(tmpFile, content, 'utf-8');
    try {
      var validator = new ConfigValidator();
      var result = validator.validateFile(tmpFile);
      assert.strictEqual(result.valid, true);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('should return warning for non-existent file', function () {
    var validator = new ConfigValidator();
    var result = validator.validateFile('/non/existent/config.yaml');
    assert.strictEqual(result.valid, true); // Degrades gracefully
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings[0].indexOf('not found') !== -1);
  });

  it('should report errors for invalid YAML file content', function () {
    var tmpDir = os.tmpdir();
    var tmpFile = path.join(tmpDir, 'test-config-validator-invalid-' + Date.now() + '.yaml');
    var content = 'context_window:\n  max_tokens: not-a-number\n';
    fs.writeFileSync(tmpFile, content, 'utf-8');
    try {
      var validator = new ConfigValidator();
      var result = validator.validateFile(tmpFile);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// ---------------------------------------------------------------------------
// getDefaults()
// ---------------------------------------------------------------------------

describe('ConfigValidator.getDefaults()', function () {
  it('should return an object with default values', function () {
    var validator = new ConfigValidator();
    var defaults = validator.getDefaults();
    assert.ok(defaults.context_window);
    assert.strictEqual(defaults.context_window.max_tokens, 200000);
    assert.strictEqual(defaults.context_window.safety_margin, 40000);
    assert.strictEqual(defaults.context_window.chunk_lines, 500);
    assert.strictEqual(defaults.context_window.strategy, 'auto');
  });

  it('should include nested defaults', function () {
    var validator = new ConfigValidator();
    var defaults = validator.getDefaults();
    assert.ok(defaults.context_window.thresholds);
    assert.strictEqual(defaults.context_window.thresholds.small, 200);
    assert.strictEqual(defaults.context_window.thresholds.medium, 800);
    assert.strictEqual(defaults.context_window.thresholds.large, 2000);
  });
});

// ---------------------------------------------------------------------------
// Custom schema
// ---------------------------------------------------------------------------

describe('ConfigValidator with custom schema', function () {
  it('should use custom schema when provided', function () {
    var customSchema = {
      my_section: {
        type: 'object',
        required: true,
        properties: {
          name: { type: 'string', required: true },
          count: { type: 'number', required: false, default: 10 }
        }
      }
    };
    var validator = new ConfigValidator({ schema: customSchema });
    var result = validator.validate({});
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(function (e) {
      return e.indexOf('Missing required field: my_section') !== -1;
    }));
  });

  it('should pass custom schema validation with valid data', function () {
    var customSchema = {
      my_section: {
        type: 'object',
        required: true,
        properties: {
          name: { type: 'string', required: true }
        }
      }
    };
    var validator = new ConfigValidator({ schema: customSchema });
    var result = validator.validate({
      my_section: { name: 'test' }
    });
    assert.strictEqual(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// Array validation
// ---------------------------------------------------------------------------

describe('ConfigValidator array validation', function () {
  it('should validate array items', function () {
    var validator = new ConfigValidator();
    var config = {
      middleware: {
        chain: ['middleware-a', 'middleware-b']
      }
    };
    var result = validator.validate(config);
    assert.strictEqual(result.valid, true);
  });

  it('should report type error when array field receives non-array', function () {
    var validator = new ConfigValidator();
    var config = {
      middleware: {
        chain: 'not-an-array'
      }
    };
    var result = validator.validate(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(function (e) {
      return e.indexOf('chain') !== -1 && e.indexOf('array') !== -1;
    }));
  });
});
