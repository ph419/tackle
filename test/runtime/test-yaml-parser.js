/**
 * test-yaml-parser.js - Unit tests for plugins/runtime/yaml-parser.js
 *
 * Covers:
 *   - parseValue() scalar parsing (boolean, null, number, string)
 *   - parseYamlString() sections, nested objects, lists, comments
 *   - parseYamlFile() file I/O (temp files)
 *   - serializeConfigValue() serialization
 *   - parseNestedBlock() nested block parsing
 *   - Arbitrary section name detection (E1 fix verification)
 */

'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var describe = require('node:test').describe;
var it = require('node:test').it;
var assert = require('node:assert');

var yp = require('../../plugins/runtime/yaml-parser');

// ---------------------------------------------------------------------------
// parseValue
// ---------------------------------------------------------------------------

describe('parseValue()', function () {
  it('should parse "true" as boolean true', function () {
    assert.strictEqual(yp.parseValue('true'), true);
  });

  it('should parse "false" as boolean false', function () {
    assert.strictEqual(yp.parseValue('false'), false);
  });

  it('should parse "null" as null', function () {
    assert.strictEqual(yp.parseValue('null'), null);
  });

  it('should parse "~" as null', function () {
    assert.strictEqual(yp.parseValue('~'), null);
  });

  it('should parse integer string as number', function () {
    assert.strictEqual(yp.parseValue('42'), 42);
    assert.strictEqual(yp.parseValue('-7'), -7);
  });

  it('should parse float string as number', function () {
    assert.strictEqual(yp.parseValue('3.14'), 3.14);
    assert.strictEqual(yp.parseValue('0.5'), 0.5);
  });

  it('should return empty string as-is (not a number)', function () {
    assert.strictEqual(yp.parseValue(''), '');
  });

  it('should parse double-quoted string (strip quotes)', function () {
    assert.strictEqual(yp.parseValue('"hello world"'), 'hello world');
  });

  it('should parse single-quoted string (strip quotes)', function () {
    assert.strictEqual(yp.parseValue("'hello world'"), 'hello world');
  });

  it('B12: lone quote char is NOT truncated to empty string', function () {
    // A single '"' or "'" should be returned verbatim, not stripped to ''.
    assert.strictEqual(yp.parseValue('"'), '"', 'lone double quote returned verbatim');
    assert.strictEqual(yp.parseValue("'"), "'", 'lone single quote returned verbatim');
  });

  it('B12: unbalanced leading quote is returned verbatim', function () {
    // '"hello' (no closing quote) must not be stripped.
    assert.strictEqual(yp.parseValue('"hello'), '"hello');
    assert.strictEqual(yp.parseValue("say'hi"), "say'hi");
  });

  it('should return plain string when it is not a known scalar or number', function () {
    assert.strictEqual(yp.parseValue('auto'), 'auto');
    assert.strictEqual(yp.parseValue('some value'), 'some value');
  });

  it('should parse \\n in double-quoted string as newline', function () {
    assert.strictEqual(yp.parseValue('"hello\\nworld"'), 'hello\nworld');
  });

  it('should parse \\t in double-quoted string as tab', function () {
    assert.strictEqual(yp.parseValue('"col1\\tcol2"'), 'col1\tcol2');
  });

  it('should parse \\" in double-quoted string as quote', function () {
    assert.strictEqual(yp.parseValue('"say \\"hi\\""'), 'say "hi"');
  });

  it('should parse \\\\ in double-quoted string as backslash', function () {
    assert.strictEqual(yp.parseValue('"path\\\\to\\\\file"'), 'path\\to\\file');
  });

  it('should parse \\r in double-quoted string as carriage return', function () {
    assert.strictEqual(yp.parseValue('"line1\\rline2"'), 'line1\rline2');
  });

  it('should NOT process escape sequences in single-quoted string', function () {
    assert.strictEqual(yp.parseValue("'hello\\nworld'"), 'hello\\nworld');
  });
});

// ---------------------------------------------------------------------------
// parseYamlString
// ---------------------------------------------------------------------------

describe('parseYamlString()', function () {
  it('should parse flat key-value pairs in a section', function () {
    var yaml = 'context_window:\n  max_tokens: 200000\n  strategy: auto';
    var result = yp.parseYamlString(yaml);
    assert.ok(result.context_window);
    assert.strictEqual(result.context_window.max_tokens, 200000);
    assert.strictEqual(result.context_window.strategy, 'auto');
  });

  it('should parse nested objects', function () {
    var yaml = 'context_window:\n  thresholds:\n    small: 200\n    large: 2000';
    var result = yp.parseYamlString(yaml);
    assert.deepStrictEqual(result.context_window.thresholds, {
      small: 200,
      large: 2000
    });
  });

  it('should parse list items', function () {
    var yaml = 'my_section:\n  items:\n    - name: alpha\n    - name: beta';
    var result = yp.parseYamlString(yaml);
    assert.ok(Array.isArray(result.my_section.items));
    assert.strictEqual(result.my_section.items[0].name, 'alpha');
    assert.strictEqual(result.my_section.items[1].name, 'beta');
  });

  it('should ignore inline comments', function () {
    var yaml = 'context_window:\n  max_tokens: 200000 # max token limit';
    var result = yp.parseYamlString(yaml);
    assert.strictEqual(result.context_window.max_tokens, 200000);
  });

  it('should ignore full-line comments', function () {
    var yaml = 'context_window:\n  # this is a comment\n  max_tokens: 200000';
    var result = yp.parseYamlString(yaml);
    assert.strictEqual(result.context_window.max_tokens, 200000);
  });

  it('should return empty object for null content', function () {
    var result = yp.parseYamlString(null);
    assert.deepStrictEqual(result, {});
  });

  it('should return empty object for empty string', function () {
    var result = yp.parseYamlString('');
    assert.deepStrictEqual(result, {});
  });

  it('should detect arbitrary section names (not hardcoded)', function () {
    var yaml = 'custom_section:\n  foo: bar\n  baz: 42\nanother_custom:\n  hello: world';
    var result = yp.parseYamlString(yaml);
    assert.ok(result.custom_section, 'custom_section should be detected');
    assert.strictEqual(result.custom_section.foo, 'bar');
    assert.strictEqual(result.custom_section.baz, 42);
    assert.ok(result.another_custom, 'another_custom should be detected');
    assert.strictEqual(result.another_custom.hello, 'world');
  });

  it('should parse multiple top-level sections', function () {
    var yaml = 'context_window:\n  max_tokens: 100\nroles:\n  roles_dir: /tmp/roles';
    var result = yp.parseYamlString(yaml);
    assert.strictEqual(result.context_window.max_tokens, 100);
    assert.strictEqual(result.roles.roles_dir, '/tmp/roles');
  });
});

// ---------------------------------------------------------------------------
// parseYamlFile
// ---------------------------------------------------------------------------

describe('parseYamlFile()', function () {
  it('should parse a real file using temp file', function () {
    var tmpDir = os.tmpdir();
    var tmpFile = path.join(tmpDir, 'test-yaml-parser-' + Date.now() + '.yaml');
    var content = 'context_window:\n  max_tokens: 500\n  strategy: greedy';
    fs.writeFileSync(tmpFile, content, 'utf-8');
    try {
      var result = yp.parseYamlFile(tmpFile);
      assert.strictEqual(result.context_window.max_tokens, 500);
      assert.strictEqual(result.context_window.strategy, 'greedy');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('should return empty object for non-existent file', function () {
    var result = yp.parseYamlFile('/non/existent/path/config.yaml');
    assert.deepStrictEqual(result, {});
  });
});

// ---------------------------------------------------------------------------
// serializeConfigValue
// ---------------------------------------------------------------------------

describe('serializeConfigValue()', function () {
  it('should return empty string for null', function () {
    assert.strictEqual(yp.serializeConfigValue(null), '');
  });

  it('should return empty string for undefined', function () {
    assert.strictEqual(yp.serializeConfigValue(undefined), '');
  });

  it('should serialize a number as string', function () {
    assert.strictEqual(yp.serializeConfigValue(42), '42');
  });

  it('should serialize a boolean as string', function () {
    assert.strictEqual(yp.serializeConfigValue(true), 'true');
  });

  it('should serialize a string as-is', function () {
    assert.strictEqual(yp.serializeConfigValue('hello'), 'hello');
  });

  it('should serialize an array with brackets', function () {
    var result = yp.serializeConfigValue([1, 2, 3]);
    assert.strictEqual(result, '[1, 2, 3]');
  });

  it('should serialize an object with key=value pairs', function () {
    var result = yp.serializeConfigValue({ a: 1, b: 'x' });
    assert.strictEqual(result, '{a=1, b=x}');
  });
});

// ---------------------------------------------------------------------------
// parseNestedBlock
// ---------------------------------------------------------------------------

describe('parseNestedBlock()', function () {
  it('should parse a simple nested object block', function () {
    var lines = [
      '  parent:',
      '    child_a: 10',
      '    child_b: hello'
    ];
    // startIdx=1 (first child line), parentIndent=0
    var result = yp.parseNestedBlock(lines, 1, 0);
    assert.deepStrictEqual(result.value, { child_a: 10, child_b: 'hello' });
  });

  it('should return empty object when no child lines exist', function () {
    var lines = ['  parent:'];
    var result = yp.parseNestedBlock(lines, 1, 0);
    assert.deepStrictEqual(result.value, {});
  });
});

// ---------------------------------------------------------------------------
// Security limits
// ---------------------------------------------------------------------------

describe('Security limits', function () {
  it('should throw on YAML input exceeding MAX_YAML_SIZE', function () {
    // Build a string longer than 100KB
    var bigYaml = 'section:\n  key: ' + 'x'.repeat(102401) + '\n';
    assert.throws(function () {
      yp.parseYamlString(bigYaml);
    }, function (err) {
      return err.message.indexOf('maximum allowed size') !== -1;
    });
  });

  it('should throw on YAML nesting exceeding MAX_DEPTH', function () {
    // Build deeply nested YAML (deeper than 10 levels)
    var yaml = 'section:\n';
    var indent = '';
    for (var i = 0; i < 15; i++) {
      indent += '  ';
      yaml += indent + 'level' + i + ':\n';
    }
    assert.throws(function () {
      yp.parseYamlString(yaml);
    }, function (err) {
      return err.message.indexOf('maximum allowed depth') !== -1;
    });
  });

  it('should parse normal-sized YAML without error', function () {
    var yaml = 'context_window:\n  max_tokens: 200000\n  strategy: auto';
    var result = yp.parseYamlString(yaml);
    assert.strictEqual(result.context_window.max_tokens, 200000);
    assert.strictEqual(result.context_window.strategy, 'auto');
  });

  it('should parse normal nesting depth without error', function () {
    // 3 levels of nesting — well under the limit
    var yaml = 'section:\n  level1:\n    level2:\n      value: 42';
    var result = yp.parseYamlString(yaml);
    assert.strictEqual(result.section.level1.level2.value, 42);
  });
});

// ─────────────────────────────────────────────
// S8/A3/B4: parseSimpleYaml (consolidated shared parser)
// ─────────────────────────────────────────────

describe('parseSimpleYaml - S8/A3/B4 consolidated parser', function () {
  it('B4: should parse a top-level scalar array (triggers)', function () {
    // Previously config-manager's parseSimpleYaml returned {} here, losing data.
    var yaml = 'triggers:\n  - foo\n  - bar\n  - baz\n';
    var result = yp.parseSimpleYaml(yaml);
    assert.ok(Array.isArray(result.triggers), 'triggers should be an array');
    assert.deepStrictEqual(result.triggers, ['foo', 'bar', 'baz']);
  });

  it('B4: should parse a scalar array nested under a section', function () {
    var yaml = 'gating:\n  blocked_states:\n    - waiting\n    - paused\n';
    var result = yp.parseSimpleYaml(yaml);
    assert.deepStrictEqual(result.gating.blocked_states, ['waiting', 'paused']);
  });

  it('should parse flat key-value pairs', function () {
    var yaml = 'name: task-creator\nversion: 1.0\ndescription: hi\n';
    var result = yp.parseSimpleYaml(yaml);
    assert.strictEqual(result.name, 'task-creator');
    assert.strictEqual(result.version, 1);
    assert.strictEqual(result.description, 'hi');
  });

  it('should parse nested objects', function () {
    var yaml = 'context_window:\n  max_tokens: 200000\n  strategy: auto\n';
    var result = yp.parseSimpleYaml(yaml);
    assert.strictEqual(result.context_window.max_tokens, 200000);
    assert.strictEqual(result.context_window.strategy, 'auto');
  });

  it('should parse list-of-objects with multi-line items', function () {
    var yaml = 'stages:\n  - id: planning\n    name: Plan\n    checkpoint: true\n  - id: review\n    name: Review\n';
    var result = yp.parseSimpleYaml(yaml);
    assert.ok(Array.isArray(result.stages));
    assert.strictEqual(result.stages.length, 2);
    assert.strictEqual(result.stages[0].id, 'planning');
    assert.strictEqual(result.stages[0].name, 'Plan');
    assert.strictEqual(result.stages[0].checkpoint, true);
    assert.strictEqual(result.stages[1].id, 'review');
  });

  it('should parse deeply-nested list-of-objects (schedule example)', function () {
    var yaml = 'schedules:\n  - name: peak\n    time_range:\n      start: "14:00"\n      end: "18:00"\n    max_concurrent: 3\n';
    var result = yp.parseSimpleYaml(yaml);
    assert.strictEqual(result.schedules[0].name, 'peak');
    assert.strictEqual(result.schedules[0].time_range.start, '14:00');
    assert.strictEqual(result.schedules[0].max_concurrent, 3);
  });

  it('should parse inline flow arrays (skills: ["a", "b"])', function () {
    var yaml = 'stage:\n  skills: ["task-creator", "split-work-package"]\n';
    var result = yp.parseSimpleYaml(yaml);
    assert.deepStrictEqual(result.stage.skills, ['task-creator', 'split-work-package']);
  });

  it('should strip inline comments outside quotes', function () {
    var yaml = 'url: http://x.com # link\nkey: value #note\n';
    var result = yp.parseSimpleYaml(yaml);
    assert.strictEqual(result.url, 'http://x.com');
    assert.strictEqual(result.key, 'value');
  });

  it('should not strip # inside quoted strings', function () {
    var yaml = 'hash: "abc#def"\n';
    var result = yp.parseSimpleYaml(yaml);
    assert.strictEqual(result.hash, 'abc#def');
  });

  it('should parse quoted strings, booleans, null, numbers', function () {
    var yaml = 's: hello\nn: 42\nb: true\nf: 3.14\nz: ~\nq: "hi there"\n';
    var result = yp.parseSimpleYaml(yaml);
    assert.strictEqual(result.s, 'hello');
    assert.strictEqual(result.n, 42);
    assert.strictEqual(result.b, true);
    assert.strictEqual(result.f, 3.14);
    assert.strictEqual(result.z, null);
    assert.strictEqual(result.q, 'hi there');
  });

  it('S8: should enforce MAX_YAML_SIZE on parseSimpleYaml', function () {
    var huge = 'k: ' + 'x'.repeat(yp.MAX_YAML_SIZE) + '\n';
    assert.throws(function () {
      yp.parseSimpleYaml(huge);
    }, /maximum allowed size/);
  });

  it('S8: should enforce MAX_DEPTH on parseSimpleYaml', function () {
    var yaml = 'a:\n';
    var indent = '';
    for (var i = 0; i < 15; i++) {
      indent += '  ';
      yaml += indent + 'k' + i + ':\n';
    }
    assert.throws(function () {
      yp.parseSimpleYaml(yaml);
    }, /maximum allowed depth/);
  });

  it('S8: should reject __proto__/constructor/prototype keys (S7 guard)', function () {
    var yaml = '__proto__:\n  polluted: true\nconstructor:\n  prototype:\n    evil: 1\n';
    var result = yp.parseSimpleYaml(yaml);
    assert.strictEqual(Object.prototype.polluted, undefined, 'no prototype pollution');
    assert.strictEqual(({}).evil, undefined);
    // Keys are sanitized to '_'
    assert.ok(result.hasOwnProperty('_'), 'poison keys renamed');
  });

  it('S8: should return {} for non-string input', function () {
    assert.deepStrictEqual(yp.parseSimpleYaml(null), {});
    assert.deepStrictEqual(yp.parseSimpleYaml(undefined), {});
    assert.deepStrictEqual(yp.parseSimpleYaml(42), {});
  });

  it('should parse the real example harness-config.yaml structure', function () {
    var yaml = [
      'context_window:',
      '  max_tokens: 200000',
      '  safety_margin: 40000',
      '  thresholds:',
      '    small: 200',
      '    medium: 800',
      'workflow:',
      '  default:',
      '    name: "std"',
      '    stages:',
      '      - id: "planning"',
      '        name: "Plan"',
      '        skills: ["task-creator", "split-work-package"]',
      '        checkpoint: true',
      '      - id: "implementation"',
      '        skills: ["agent-dispatcher"]',
      '        checkpoint: false',
      'agent_dispatcher:',
      '  concurrency:',
      '    default_max: 6',
    ].join('\n');
    var result = yp.parseSimpleYaml(yaml);
    assert.strictEqual(result.context_window.max_tokens, 200000);
    assert.strictEqual(result.context_window.thresholds.small, 200);
    assert.strictEqual(result.workflow.default.name, 'std');
    assert.strictEqual(result.workflow.default.stages.length, 2);
    assert.deepStrictEqual(result.workflow.default.stages[0].skills, ['task-creator', 'split-work-package']);
    assert.strictEqual(result.workflow.default.stages[0].checkpoint, true);
    assert.strictEqual(result.workflow.default.stages[1].id, 'implementation');
    assert.strictEqual(result.agent_dispatcher.concurrency.default_max, 6);
  });
});
