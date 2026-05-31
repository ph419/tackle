/**
 * Structural validation tests for all Skill plugins.
 * Dynamically reads skill plugins from plugin-registry.json and verifies:
 *   1. plugin.json exists with required fields (name, version, type, description)
 *   2. plugin.json type field is "skill"
 *   3. skill.md exists and is non-empty
 *   4. skill.md contains key structural sections
 *
 * Run with: node --test test/runtime/test-skill-structure.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '../..');
const REGISTRY_PATH = path.join(ROOT_DIR, 'plugins', 'plugin-registry.json');
const CORE_DIR = path.join(ROOT_DIR, 'plugins', 'core');

// Required fields in plugin.json
const REQUIRED_FIELDS = ['name', 'version', 'type', 'description'];

// Key sections that should appear in skill.md.
// A valid skill.md must contain at least one "when to use" indicator and
// at least one procedural/flow section from the list below.
const WHEN_TO_USE_SECTIONS = [
  'When to Use',
  '操作说明',
  '状态检测与自动决策'
];
const FLOW_SECTIONS = [
  'Flow',
  'Flow Diagram',
  'Step-by-Step',
  'Execution Steps',
  '操作说明',
  '核心流程',
  'Commands',
  'Quick Reference',
  'Part \\d'
];

/**
 * Read the plugin registry and return all skill plugin entries.
 */
function getSkillPlugins() {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  const registry = JSON.parse(raw);
  return registry.plugins.filter(p => p.name.startsWith('skill-'));
}

/**
 * Check whether content contains a section heading (## or #) with the given text.
 */
function hasSection(content, sectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^##?\\s+.*${escaped}`, 'm');
  return pattern.test(content);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test('plugin-registry.json is valid JSON with plugins array', () => {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  const registry = JSON.parse(raw);
  assert.ok(Array.isArray(registry.plugins), 'registry should have a plugins array');
  assert.ok(registry.plugins.length > 0, 'plugins array should not be empty');
});

const skillPlugins = getSkillPlugins();

test(`found ${skillPlugins.length} skill plugins in registry`, () => {
  assert.ok(skillPlugins.length >= 15, `expected at least 15 skill plugins, found ${skillPlugins.length}`);
});

for (const entry of skillPlugins) {
  const source = entry.source;
  const pluginDir = path.join(CORE_DIR, source);

  test(`[${source}] plugin directory exists`, () => {
    assert.ok(fs.existsSync(pluginDir), `directory ${pluginDir} should exist`);
    const stat = fs.statSync(pluginDir);
    assert.ok(stat.isDirectory(), `${pluginDir} should be a directory`);
  });

  test(`[${source}] plugin.json exists and is valid JSON`, () => {
    const pluginJsonPath = path.join(pluginDir, 'plugin.json');
    assert.ok(fs.existsSync(pluginJsonPath), `plugin.json should exist in ${pluginDir}`);

    const raw = fs.readFileSync(pluginJsonPath, 'utf-8');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, 'plugin.json should be valid JSON');
  });

  test(`[${source}] plugin.json has all required fields`, () => {
    const pluginJsonPath = path.join(pluginDir, 'plugin.json');
    const parsed = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));

    for (const field of REQUIRED_FIELDS) {
      assert.ok(field in parsed, `plugin.json should have "${field}" field`);
      assert.ok(parsed[field] !== undefined && parsed[field] !== '', `"${field}" should not be empty`);
    }
  });

  test(`[${source}] plugin.json type is "skill"`, () => {
    const pluginJsonPath = path.join(pluginDir, 'plugin.json');
    const parsed = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
    assert.equal(parsed.type, 'skill', `type field should be "skill", got "${parsed.type}"`);
  });

  test(`[${source}] skill.md exists and is non-empty`, () => {
    const skillMdPath = path.join(pluginDir, 'skill.md');
    assert.ok(fs.existsSync(skillMdPath), `skill.md should exist in ${pluginDir}`);

    const content = fs.readFileSync(skillMdPath, 'utf-8');
    assert.ok(content.trim().length > 0, 'skill.md should not be empty');
  });

  test(`[${source}] skill.md contains a usage/trigger section`, () => {
    const skillMdPath = path.join(pluginDir, 'skill.md');
    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const found = WHEN_TO_USE_SECTIONS.some(s => hasSection(content, s));
    assert.ok(
      found,
      `skill.md should contain a usage/trigger section (e.g. "When to Use", "操作说明")`
    );
  });

  test(`[${source}] skill.md contains at least one flow/procedure section`, () => {
    const skillMdPath = path.join(pluginDir, 'skill.md');
    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const found = FLOW_SECTIONS.some(s => hasSection(content, s));
    assert.ok(
      found,
      `skill.md should contain at least one flow/procedure section (e.g. Flow, Commands, Step-by-Step)`
    );
  });
}
