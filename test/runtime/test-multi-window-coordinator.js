/**
 * Unit tests for Multi-Window Coordinator
 * Run with: node --test test/runtime/test-multi-window-coordinator.js
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var coordinator = require('../../plugins/runtime/multi-window-coordinator');

// ─────────────────────────────────────────────
// Helpers: create temp directory trees for testing
// ─────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mwc-test-'));
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf-8');
}

function cleanupTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_e) { /* ignore */ }
}

// ─────────────────────────────────────────────
// Section 1: Data Structure Factories
// ─────────────────────────────────────────────

test.describe('createSessionSchema', function () {
  test('should create a valid session skeleton', function () {
    var session = coordinator.createSessionSchema({
      session_id: 'mws-test-001',
      total_windows: 3
    });

    assert.strictEqual(session.session_id, 'mws-test-001');
    assert.strictEqual(session.total_windows, 3);
    assert.strictEqual(session.status, 'active');
    assert.strictEqual(session.total_tasks, 0);
    assert.strictEqual(session.completed_tasks, 0);
    assert.strictEqual(session.failed_tasks, 0);
    assert.ok(Array.isArray(session.stages), 'stages is an array');
    assert.ok(session.global_concurrency, 'has global_concurrency');
    assert.strictEqual(session.global_concurrency.max_total, 8);
    assert.strictEqual(session.global_concurrency.current_active, 0);
    assert.ok(Array.isArray(session.stage_transitions), 'has stage_transitions');
    assert.ok(session.created_at, 'has created_at');
    assert.ok(session.updated_at, 'has updated_at');
  });

  test('should accept stages option', function () {
    var stages = [
      { stage_id: 1, name: 'impl', status: 'active', windows: ['win-1'] }
    ];
    var session = coordinator.createSessionSchema({
      session_id: 'mws-test-002',
      total_windows: 1,
      stages: stages
    });

    assert.strictEqual(session.stages.length, 1);
    assert.strictEqual(session.stages[0].stage_id, 1);
  });
});

test.describe('createWindowStateSchema', function () {
  test('should create a backward-compatible state skeleton', function () {
    var state = coordinator.createWindowStateSchema({
      window_id: 'win-1',
      session_id: 'mws-test-001',
      team_name: 'batch-20260606-WP172'
    });

    // Backward-compatible fields (same as dispatcher-state.json)
    assert.strictEqual(state.team_name, 'batch-20260606-WP172');
    assert.deepStrictEqual(state.teamee_map, {});
    assert.deepStrictEqual(state.wp_assignments, {});
    assert.ok(state.start_time, 'has start_time');
    assert.strictEqual(state.loop_iteration, 0);
    assert.deepStrictEqual(state.processed_action_ids, []);
    assert.strictEqual(state.total_tasks, 0);
    assert.strictEqual(state.status, 'monitoring');
    assert.strictEqual(state.max_batch_size, 5);
    assert.deepStrictEqual(state.current_batch, []);
    assert.deepStrictEqual(state.pending_batches, []);
    assert.strictEqual(state.global_pause_flag, false);

    // New multi-window fields
    assert.strictEqual(state.window_id, 'win-1');
    assert.strictEqual(state.session_id, 'mws-test-001');
    assert.strictEqual(state.current_stage, null);
    assert.deepStrictEqual(state.assigned_wps, []);
  });

  test('should accept optional current_stage and assigned_wps', function () {
    var state = coordinator.createWindowStateSchema({
      window_id: 'win-2',
      session_id: 'mws-test-001',
      team_name: 'batch-test',
      total_tasks: 5,
      current_stage: 2,
      assigned_wps: ['WP-172', 'WP-175']
    });

    assert.strictEqual(state.total_tasks, 5);
    assert.strictEqual(state.current_stage, 2);
    assert.deepStrictEqual(state.assigned_wps, ['WP-172', 'WP-175']);
  });
});

test.describe('createWindowHeartbeatSchema', function () {
  test('should create heartbeat with window_id', function () {
    var hb = coordinator.createWindowHeartbeatSchema({
      window_id: 'win-1',
      session_id: 'batch-20260606-WP172',
      pid: 12345,
      team_name: 'batch-20260606-WP172'
    });

    assert.strictEqual(hb.window_id, 'win-1');
    assert.strictEqual(hb.session_id, 'batch-20260606-WP172');
    assert.strictEqual(hb.pid, 12345);
    assert.strictEqual(hb.team_name, 'batch-20260606-WP172');
    assert.strictEqual(hb.loop_iteration, 0);
    assert.strictEqual(hb.total_tasks, 0);
    assert.strictEqual(hb.completed_tasks, 0);
    assert.strictEqual(hb.in_progress_tasks, 0);
    assert.strictEqual(hb.pending_tasks, 0);
    assert.ok(hb.last_update, 'has last_update');
    assert.strictEqual(hb.status, 'monitoring');
  });
});

// ─────────────────────────────────────────────
// Section 2: Aggregation Logic
// ─────────────────────────────────────────────

test.describe('aggregateWindowStates', function () {
  test('should aggregate two windows correctly', function () {
    var tmpDir = makeTmpDir();
    try {
      var windowsDir = path.join(tmpDir, 'windows');

      // Window 1: 2 tasks completed
      writeJson(path.join(windowsDir, 'win-1', 'state.json'), {
        window_id: 'win-1',
        session_id: 'mws-test',
        team_name: 'batch-w1',
        current_stage: 1,
        assigned_wps: ['WP-172'],
        status: 'monitoring'
      });
      writeJson(path.join(windowsDir, 'win-1', 'heartbeat.json'), {
        window_id: 'win-1',
        session_id: 'batch-w1',
        pid: 111,
        team_name: 'batch-w1',
        loop_iteration: 10,
        total_tasks: 2,
        completed_tasks: 2,
        in_progress_tasks: 0,
        pending_tasks: 0,
        last_update: new Date().toISOString(),
        status: 'completed'
      });

      // Window 2: 1 completed, 1 in progress
      writeJson(path.join(windowsDir, 'win-2', 'state.json'), {
        window_id: 'win-2',
        session_id: 'mws-test',
        team_name: 'batch-w2',
        current_stage: 1,
        assigned_wps: ['WP-173'],
        status: 'monitoring'
      });
      writeJson(path.join(windowsDir, 'win-2', 'heartbeat.json'), {
        window_id: 'win-2',
        session_id: 'batch-w2',
        pid: 222,
        team_name: 'batch-w2',
        loop_iteration: 8,
        total_tasks: 2,
        completed_tasks: 1,
        in_progress_tasks: 1,
        pending_tasks: 0,
        last_update: new Date().toISOString(),
        status: 'monitoring'
      });

      var session = coordinator.aggregateWindowStates(windowsDir);

      assert.strictEqual(session.total_windows, 2);
      assert.strictEqual(session.total_tasks, 4);
      assert.strictEqual(session.completed_tasks, 3);
      assert.strictEqual(session.global_concurrency.current_active, 1);
      assert.ok(session.windows['win-1'], 'win-1 present');
      assert.ok(session.windows['win-2'], 'win-2 present');
      assert.strictEqual(session.windows['win-1'].status, 'completed');
      assert.strictEqual(session.windows['win-2'].status, 'active');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('should handle empty windows directory', function () {
    var tmpDir = makeTmpDir();
    try {
      var windowsDir = path.join(tmpDir, 'windows');
      fs.mkdirSync(windowsDir, { recursive: true });

      var session = coordinator.aggregateWindowStates(windowsDir);

      assert.strictEqual(session.total_windows, 0);
      assert.strictEqual(session.total_tasks, 0);
      assert.strictEqual(session.completed_tasks, 0);
      assert.deepStrictEqual(session.windows, {});
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('should handle non-existent windows directory', function () {
    var session = coordinator.aggregateWindowStates('/non/existent/path');

    assert.strictEqual(session.total_windows, 0);
    assert.strictEqual(session.total_tasks, 0);
  });

  test('should detect disconnected window (stale heartbeat)', function () {
    var tmpDir = makeTmpDir();
    try {
      var windowsDir = path.join(tmpDir, 'windows');
      var staleTime = new Date(Date.now() - 300000).toISOString(); // 5 minutes ago

      writeJson(path.join(windowsDir, 'win-1', 'heartbeat.json'), {
        window_id: 'win-1',
        pid: 111,
        team_name: 'batch-w1',
        total_tasks: 2,
        completed_tasks: 0,
        in_progress_tasks: 1,
        pending_tasks: 1,
        last_update: staleTime,
        status: 'monitoring'
      });

      var session = coordinator.aggregateWindowStates(windowsDir);
      assert.strictEqual(session.windows['win-1'].status, 'disconnected');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('should handle window with missing heartbeat', function () {
    var tmpDir = makeTmpDir();
    try {
      var windowsDir = path.join(tmpDir, 'windows');
      writeJson(path.join(windowsDir, 'win-1', 'state.json'), {
        window_id: 'win-1',
        team_name: 'batch-w1'
      });
      // No heartbeat file

      var session = coordinator.aggregateWindowStates(windowsDir);
      assert.strictEqual(session.windows['win-1'].status, 'disconnected');
      assert.strictEqual(session.windows['win-1'].heartbeat, null);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('should update existing session preserving stages', function () {
    var tmpDir = makeTmpDir();
    try {
      var windowsDir = path.join(tmpDir, 'windows');
      writeJson(path.join(windowsDir, 'win-1', 'heartbeat.json'), {
        window_id: 'win-1',
        pid: 111,
        total_tasks: 1,
        completed_tasks: 1,
        in_progress_tasks: 0,
        pending_tasks: 0,
        last_update: new Date().toISOString(),
        status: 'monitoring'
      });

      var existing = coordinator.createSessionSchema({
        session_id: 'mws-preserve-test',
        total_windows: 1,
        stages: [
          { stage_id: 1, name: 'impl', status: 'completed', windows: ['win-1'] }
        ]
      });
      existing.stage_transitions = [{ from_stage: 1, to_stage: 2, trigger: 'auto' }];

      var session = coordinator.aggregateWindowStates(windowsDir, existing);

      assert.strictEqual(session.session_id, 'mws-preserve-test');
      assert.strictEqual(session.stages.length, 1);
      assert.strictEqual(session.stage_transitions.length, 1);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });
});

test.describe('aggregateSingleWindow', function () {
  test('should aggregate state and heartbeat', function () {
    var state = {
      window_id: 'win-1',
      current_stage: 2,
      assigned_wps: ['WP-172', 'WP-175']
    };
    var heartbeat = {
      pid: 12345,
      loop_iteration: 42,
      total_tasks: 3,
      completed_tasks: 2,
      in_progress_tasks: 1,
      pending_tasks: 0,
      last_update: new Date().toISOString(),
      status: 'monitoring'
    };

    var entry = coordinator.aggregateSingleWindow('win-1', state, heartbeat);

    assert.strictEqual(entry.window_id, 'win-1');
    assert.strictEqual(entry.pid, 12345);
    assert.strictEqual(entry.current_stage, 2);
    assert.deepStrictEqual(entry.assigned_wps, ['WP-172', 'WP-175']);
    assert.strictEqual(entry.heartbeat.loop_iteration, 42);
    assert.strictEqual(entry.heartbeat.completed, 2);
    assert.strictEqual(entry.heartbeat.in_progress, 1);
  });

  test('should handle null state and heartbeat', function () {
    var entry = coordinator.aggregateSingleWindow('win-ghost', null, null);

    assert.strictEqual(entry.window_id, 'win-ghost');
    assert.strictEqual(entry.status, 'disconnected');
    assert.strictEqual(entry.heartbeat, null);
  });

  test('B11: malformed/missing last_update (NaN age) → disconnected, not active', function () {
    // B7/B11: a heartbeat with missing/garbage last_update yields NaN age.
    // NaN > THRESHOLD is false, so without the guard the window was
    // misclassified as alive. Verify each malformed shape → disconnected.
    var cases = [
      { label: 'missing last_update', hb: { in_progress_tasks: 1 } },
      { label: 'null last_update', hb: { last_update: null, in_progress_tasks: 1 } },
      { label: 'garbage last_update', hb: { last_update: 'not-a-date', in_progress_tasks: 1 } },
      { label: 'undefined last_update', hb: { last_update: undefined, in_progress_tasks: 1 } },
    ];
    for (var i = 0; i < cases.length; i++) {
      var entry = coordinator.aggregateSingleWindow('win-bad', null, cases[i].hb);
      assert.strictEqual(entry.status, 'disconnected',
        'B11: ' + cases[i].label + ' must be disconnected, got ' + entry.status);
    }
  });
});

test.describe('computeSessionStatus', function () {
  test('should return completed when all windows completed', function () {
    var session = {
      status: 'active',
      windows: {
        'win-1': { status: 'completed' },
        'win-2': { status: 'completed' }
      }
    };
    assert.strictEqual(coordinator.computeSessionStatus(session, ['win-1', 'win-2']), 'completed');
  });

  test('should return failed when any window failed', function () {
    var session = {
      status: 'active',
      windows: {
        'win-1': { status: 'completed' },
        'win-2': { status: 'failed' }
      }
    };
    assert.strictEqual(coordinator.computeSessionStatus(session, ['win-1', 'win-2']), 'failed');
  });

  test('should return active when any window active', function () {
    var session = {
      status: 'active',
      windows: {
        'win-1': { status: 'completed' },
        'win-2': { status: 'active' }
      }
    };
    assert.strictEqual(coordinator.computeSessionStatus(session, ['win-1', 'win-2']), 'active');
  });

  test('should preserve paused status', function () {
    var session = {
      status: 'paused',
      windows: {
        'win-1': { status: 'active' }
      }
    };
    assert.strictEqual(coordinator.computeSessionStatus(session, ['win-1']), 'paused');
  });

  test('should return active for empty windows', function () {
    var session = { status: 'active', windows: {} };
    assert.strictEqual(coordinator.computeSessionStatus(session, []), 'active');
  });
});

// ─────────────────────────────────────────────
// Section 3: Stage Management
// ─────────────────────────────────────────────

test.describe('isStageComplete', function () {
  test('should return true when all windows have no pending/in_progress', function () {
    var session = {
      stages: [
        { stage_id: 1, windows: ['win-1', 'win-2'] }
      ],
      windows: {
        'win-1': { heartbeat: { pending: 0, in_progress: 0 } },
        'win-2': { heartbeat: { pending: 0, in_progress: 0 } }
      }
    };
    assert.strictEqual(coordinator.isStageComplete(session, 1), true);
  });

  test('should return false when a window still has pending tasks', function () {
    var session = {
      stages: [
        { stage_id: 1, windows: ['win-1', 'win-2'] }
      ],
      windows: {
        'win-1': { heartbeat: { pending: 0, in_progress: 0 } },
        'win-2': { heartbeat: { pending: 1, in_progress: 0 } }
      }
    };
    assert.strictEqual(coordinator.isStageComplete(session, 1), false);
  });

  test('should return false when a window has in_progress tasks', function () {
    var session = {
      stages: [
        { stage_id: 1, windows: ['win-1'] }
      ],
      windows: {
        'win-1': { heartbeat: { pending: 0, in_progress: 2 } }
      }
    };
    assert.strictEqual(coordinator.isStageComplete(session, 1), false);
  });

  test('should return false for non-existent stage', function () {
    var session = { stages: [], windows: {} };
    assert.strictEqual(coordinator.isStageComplete(session, 99), false);
  });

  test('should return false when window is missing from session', function () {
    var session = {
      stages: [{ stage_id: 1, windows: ['win-ghost'] }],
      windows: {}
    };
    assert.strictEqual(coordinator.isStageComplete(session, 1), false);
  });
});

test.describe('findActiveStage', function () {
  test('should find the active stage', function () {
    var session = {
      stages: [
        { stage_id: 1, status: 'completed' },
        { stage_id: 2, status: 'active' }
      ]
    };
    var active = coordinator.findActiveStage(session);
    assert.strictEqual(active.stage_id, 2);
  });

  test('should return null when no active stage', function () {
    var session = {
      stages: [
        { stage_id: 1, status: 'completed' }
      ]
    };
    assert.strictEqual(coordinator.findActiveStage(session), null);
  });
});

test.describe('getNextStage', function () {
  test('should return next stage', function () {
    var session = {
      stages: [
        { stage_id: 1, status: 'completed' },
        { stage_id: 2, status: 'pending' }
      ]
    };
    var next = coordinator.getNextStage(session, 1);
    assert.strictEqual(next.stage_id, 2);
  });

  test('should return null for last stage', function () {
    var session = {
      stages: [
        { stage_id: 1, status: 'active' }
      ]
    };
    assert.strictEqual(coordinator.getNextStage(session, 1), null);
  });
});

test.describe('advanceStage', function () {
  test('should advance from stage 1 to stage 2', function () {
    var session = {
      stages: [
        { stage_id: 1, status: 'active', windows: ['win-1'], started_at: '2026-06-06T10:00:00Z' },
        { stage_id: 2, status: 'pending', windows: ['win-1'] }
      ],
      windows: {
        'win-1': { heartbeat: { pending: 0, in_progress: 0 } }
      },
      stage_transitions: []
    };

    var result = coordinator.advanceStage(session);

    assert.strictEqual(result, true);
    assert.strictEqual(session.stages[0].status, 'completed');
    assert.ok(session.stages[0].completed_at, 'completed_at set');
    assert.strictEqual(session.stages[1].status, 'active');
    assert.ok(session.stages[1].started_at, 'started_at set');
    assert.strictEqual(session.stage_transitions.length, 1);
    assert.strictEqual(session.stage_transitions[0].from_stage, 1);
    assert.strictEqual(session.stage_transitions[0].to_stage, 2);
  });

  test('should mark session completed when last stage finishes', function () {
    var session = {
      stages: [
        { stage_id: 1, status: 'active', windows: ['win-1'] }
      ],
      windows: {
        'win-1': { heartbeat: { pending: 0, in_progress: 0 } }
      },
      stage_transitions: [],
      status: 'active'
    };

    var result = coordinator.advanceStage(session);

    assert.strictEqual(result, false); // no next stage
    assert.strictEqual(session.stages[0].status, 'completed');
    assert.strictEqual(session.status, 'completed');
  });

  test('should not advance when stage is not complete', function () {
    var session = {
      stages: [
        { stage_id: 1, status: 'active', windows: ['win-1'] }
      ],
      windows: {
        'win-1': { heartbeat: { pending: 2, in_progress: 0 } }
      },
      stage_transitions: []
    };

    var result = coordinator.advanceStage(session);
    assert.strictEqual(result, false);
    assert.strictEqual(session.stages[0].status, 'active');
  });
});

// ─────────────────────────────────────────────
// Section 3b: Stage Transition Protocol
// ─────────────────────────────────────────────

test.describe('findStageForWindow', function () {
  test('should find stage containing the window', function () {
    var session = {
      stages: [
        { stage_id: 1, windows: ['win-1', 'win-2'] },
        { stage_id: 2, windows: ['win-1', 'win-2'] }
      ]
    };
    var stage = coordinator.findStageForWindow(session, 'win-2');
    assert.strictEqual(stage.stage_id, 1);
  });

  test('should return null when window not in any stage', function () {
    var session = {
      stages: [
        { stage_id: 1, windows: ['win-1'] }
      ]
    };
    assert.strictEqual(coordinator.findStageForWindow(session, 'win-ghost'), null);
  });

  test('should return null for empty stages', function () {
    var session = { stages: [] };
    assert.strictEqual(coordinator.findStageForWindow(session, 'win-1'), null);
  });

  test('should find stage even when window appears in multiple stages', function () {
    var session = {
      stages: [
        { stage_id: 1, windows: ['win-1'] },
        { stage_id: 2, windows: ['win-1', 'win-2'] }
      ]
    };
    // Returns first matching stage
    var stage = coordinator.findStageForWindow(session, 'win-1');
    assert.strictEqual(stage.stage_id, 1);
  });
});

test.describe('writeStageSignal', function () {
  test('should update current_stage in window state.json', function () {
    var tmpDir = makeTmpDir();
    try {
      var windowsDir = path.join(tmpDir, 'windows');
      writeJson(path.join(windowsDir, 'win-1', 'state.json'), {
        window_id: 'win-1',
        current_stage: 1,
        assigned_wps: ['WP-172']
      });

      var result = coordinator.writeStageSignal(windowsDir, 'win-1', 2, ['WP-175', 'WP-176']);
      assert.strictEqual(result, true);

      var updated = coordinator.readJsonSafe(path.join(windowsDir, 'win-1', 'state.json'));
      assert.strictEqual(updated.current_stage, 2);
      assert.deepStrictEqual(updated.assigned_wps, ['WP-175', 'WP-176']);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('should update current_stage without changing assigned_wps when not provided', function () {
    var tmpDir = makeTmpDir();
    try {
      var windowsDir = path.join(tmpDir, 'windows');
      writeJson(path.join(windowsDir, 'win-1', 'state.json'), {
        window_id: 'win-1',
        current_stage: 1,
        assigned_wps: ['WP-172']
      });

      var result = coordinator.writeStageSignal(windowsDir, 'win-1', 2);
      assert.strictEqual(result, true);

      var updated = coordinator.readJsonSafe(path.join(windowsDir, 'win-1', 'state.json'));
      assert.strictEqual(updated.current_stage, 2);
      assert.deepStrictEqual(updated.assigned_wps, ['WP-172']); // preserved
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('should return false for non-existent window state file', function () {
    var tmpDir = makeTmpDir();
    try {
      var windowsDir = path.join(tmpDir, 'windows');
      fs.mkdirSync(windowsDir, { recursive: true });

      var result = coordinator.writeStageSignal(windowsDir, 'win-ghost', 1);
      assert.strictEqual(result, false);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('should preserve other fields in state.json', function () {
    var tmpDir = makeTmpDir();
    try {
      var windowsDir = path.join(tmpDir, 'windows');
      writeJson(path.join(windowsDir, 'win-1', 'state.json'), {
        window_id: 'win-1',
        session_id: 'mws-test',
        team_name: 'batch-test',
        current_stage: 1,
        assigned_wps: ['WP-172'],
        loop_iteration: 42,
        status: 'monitoring'
      });

      coordinator.writeStageSignal(windowsDir, 'win-1', 2, ['WP-175']);

      var updated = coordinator.readJsonSafe(path.join(windowsDir, 'win-1', 'state.json'));
      assert.strictEqual(updated.window_id, 'win-1');
      assert.strictEqual(updated.session_id, 'mws-test');
      assert.strictEqual(updated.team_name, 'batch-test');
      assert.strictEqual(updated.loop_iteration, 42);
      assert.strictEqual(updated.status, 'monitoring');
      assert.strictEqual(updated.current_stage, 2);
      assert.deepStrictEqual(updated.assigned_wps, ['WP-175']);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });
});

// ─────────────────────────────────────────────
// Section 4: current_batch Persistence Fix
// ─────────────────────────────────────────────

test.describe('resolveCurrentBatch', function () {
  test('should prefer in-memory batch when non-empty', function () {
    var result = coordinator.resolveCurrentBatch(['1', '2'], { current_batch: ['3'] });
    assert.deepStrictEqual(result, ['1', '2']);
  });

  test('should fall back to disk value when in-memory is empty', function () {
    var result = coordinator.resolveCurrentBatch([], { current_batch: ['3', '4'] });
    assert.deepStrictEqual(result, ['3', '4']);
  });

  test('should return empty array when both are empty', function () {
    var result = coordinator.resolveCurrentBatch([], { current_batch: [] });
    assert.deepStrictEqual(result, []);
  });

  test('should handle null/undefined in-memory value', function () {
    var result = coordinator.resolveCurrentBatch(null, { current_batch: ['5'] });
    assert.deepStrictEqual(result, ['5']);
  });

  test('should handle missing stateFromDisk', function () {
    var result = coordinator.resolveCurrentBatch(['1'], null);
    assert.deepStrictEqual(result, ['1']);
  });
});

test.describe('buildStatePayload', function () {
  test('should build complete state payload', function () {
    var now = new Date();
    var payload = coordinator.buildStatePayload({
      team_name: 'batch-test',
      teamee_map: { '1': 'expert-t1' },
      wp_assignments: { '1': { role: 'dev' } },
      start_time: now,
      loop_iteration: 5,
      processed_action_ids: ['act-001'],
      total_tasks: 3,
      status: 'monitoring',
      max_batch_size: 5,
      current_batch: ['1', '2'],
      pending_batches: ['3'],
      global_pause_flag: false
    });

    assert.strictEqual(payload.team_name, 'batch-test');
    assert.deepStrictEqual(payload.current_batch, ['1', '2']);
    assert.deepStrictEqual(payload.pending_batches, ['3']);
    assert.strictEqual(payload.start_time, now.toISOString());
    assert.strictEqual(payload.total_tasks, 3);
  });

  test('should default current_batch to empty array if missing', function () {
    var payload = coordinator.buildStatePayload({
      team_name: 'test',
      start_time: '2026-06-06T10:00:00Z',
      loop_iteration: 0,
      total_tasks: 0
    });
    assert.deepStrictEqual(payload.current_batch, []);
    assert.deepStrictEqual(payload.pending_batches, []);
  });

  test('should handle Date object for start_time', function () {
    var d = new Date('2026-06-06T12:00:00Z');
    var payload = coordinator.buildStatePayload({
      team_name: 'test',
      start_time: d,
      loop_iteration: 0,
      total_tasks: 0
    });
    assert.strictEqual(payload.start_time, '2026-06-06T12:00:00.000Z');
  });

  test('should handle string start_time', function () {
    var payload = coordinator.buildStatePayload({
      team_name: 'test',
      start_time: '2026-06-06T12:00:00Z',
      loop_iteration: 0,
      total_tasks: 0
    });
    assert.strictEqual(payload.start_time, '2026-06-06T12:00:00Z');
  });
});

// ─────────────────────────────────────────────
// Section 5: Internal Helpers
// ─────────────────────────────────────────────

test.describe('readJsonSafe', function () {
  test('should read a valid JSON file', function () {
    var tmpDir = makeTmpDir();
    try {
      var filePath = path.join(tmpDir, 'test.json');
      writeJson(filePath, { key: 'value' });
      var result = coordinator.readJsonSafe(filePath);
      assert.deepStrictEqual(result, { key: 'value' });
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('should return null for non-existent file', function () {
    var result = coordinator.readJsonSafe('/non/existent/file.json');
    assert.strictEqual(result, null);
  });

  test('should return null for invalid JSON', function () {
    var tmpDir = makeTmpDir();
    try {
      var filePath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(filePath, 'not json', 'utf-8');
      var result = coordinator.readJsonSafe(filePath);
      assert.strictEqual(result, null);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });
});

test.describe('listSubdirs', function () {
  test('should list subdirectories', function () {
    var tmpDir = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmpDir, 'a'));
      fs.mkdirSync(path.join(tmpDir, 'b'));
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'x');

      var dirs = coordinator.listSubdirs(tmpDir);
      assert.ok(dirs.includes('a'));
      assert.ok(dirs.includes('b'));
      assert.ok(!dirs.includes('file.txt'));
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('should return empty array for non-existent path', function () {
    var dirs = coordinator.listSubdirs('/non/existent/path');
    assert.deepStrictEqual(dirs, []);
  });
});

// ─────────────────────────────────────────────
// Section 6: Additional Aggregation Edge Cases
// ─────────────────────────────────────────────

test.describe('aggregateWindowStates — edge cases', function () {
  test('should aggregate mixed window statuses (active + completed + disconnected)', function () {
    var tmpDir = makeTmpDir();
    try {
      var windowsDir = path.join(tmpDir, 'windows');

      writeJson(path.join(windowsDir, 'win-1', 'heartbeat.json'), {
        window_id: 'win-1',
        pid: 111,
        total_tasks: 3,
        completed_tasks: 3,
        in_progress_tasks: 0,
        pending_tasks: 0,
        last_update: new Date().toISOString(),
        status: 'completed'
      });

      writeJson(path.join(windowsDir, 'win-2', 'heartbeat.json'), {
        window_id: 'win-2',
        pid: 222,
        total_tasks: 2,
        completed_tasks: 1,
        in_progress_tasks: 1,
        pending_tasks: 0,
        last_update: new Date().toISOString(),
        status: 'monitoring'
      });

      var staleTime = new Date(Date.now() - 300000).toISOString();
      writeJson(path.join(windowsDir, 'win-3', 'heartbeat.json'), {
        window_id: 'win-3',
        pid: 333,
        total_tasks: 1,
        completed_tasks: 0,
        in_progress_tasks: 0,
        pending_tasks: 1,
        last_update: staleTime,
        status: 'monitoring'
      });

      var session = coordinator.aggregateWindowStates(windowsDir);

      assert.strictEqual(session.total_windows, 3);
      assert.strictEqual(session.total_tasks, 6);
      assert.strictEqual(session.completed_tasks, 4);
      assert.strictEqual(session.windows['win-1'].status, 'completed');
      assert.strictEqual(session.windows['win-2'].status, 'active');
      assert.strictEqual(session.windows['win-3'].status, 'disconnected');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('should aggregate idle window (pending=0, in_progress=0, not completed)', function () {
    var tmpDir = makeTmpDir();
    try {
      var windowsDir = path.join(tmpDir, 'windows');
      writeJson(path.join(windowsDir, 'win-1', 'heartbeat.json'), {
        window_id: 'win-1',
        pid: 111,
        total_tasks: 2,
        completed_tasks: 2,
        in_progress_tasks: 0,
        pending_tasks: 0,
        last_update: new Date().toISOString(),
        status: 'monitoring'
      });

      var session = coordinator.aggregateWindowStates(windowsDir);

      assert.strictEqual(session.total_windows, 1);
      // status is 'monitoring' with in_progress=0 and pending=0 → 'active' (by implementation)
      assert.strictEqual(session.windows['win-1'].status, 'active');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('should aggregate window with failed_tasks from state.json', function () {
    var tmpDir = makeTmpDir();
    try {
      var windowsDir = path.join(tmpDir, 'windows');
      writeJson(path.join(windowsDir, 'win-1', 'state.json'), {
        window_id: 'win-1',
        team_name: 'batch-w1',
        failed_tasks: 2
      });
      writeJson(path.join(windowsDir, 'win-1', 'heartbeat.json'), {
        window_id: 'win-1',
        pid: 111,
        total_tasks: 5,
        completed_tasks: 3,
        in_progress_tasks: 0,
        pending_tasks: 0,
        last_update: new Date().toISOString(),
        status: 'monitoring'
      });

      var session = coordinator.aggregateWindowStates(windowsDir);

      assert.strictEqual(session.total_windows, 1);
      assert.strictEqual(session.total_tasks, 5);
      assert.strictEqual(session.completed_tasks, 3);
      assert.strictEqual(session.failed_tasks, 2);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('should aggregate single window correctly', function () {
    var tmpDir = makeTmpDir();
    try {
      var windowsDir = path.join(tmpDir, 'windows');
      writeJson(path.join(windowsDir, 'win-1', 'state.json'), {
        window_id: 'win-1',
        team_name: 'batch-solo',
        current_stage: 1,
        assigned_wps: ['WP-100']
      });
      writeJson(path.join(windowsDir, 'win-1', 'heartbeat.json'), {
        window_id: 'win-1',
        pid: 999,
        total_tasks: 1,
        completed_tasks: 1,
        in_progress_tasks: 0,
        pending_tasks: 0,
        last_update: new Date().toISOString(),
        status: 'completed'
      });

      var session = coordinator.aggregateWindowStates(windowsDir);

      assert.strictEqual(session.total_windows, 1);
      assert.strictEqual(session.total_tasks, 1);
      assert.strictEqual(session.completed_tasks, 1);
      assert.strictEqual(session.windows['win-1'].status, 'completed');
      assert.strictEqual(session.windows['win-1'].current_stage, 1);
      assert.deepStrictEqual(session.windows['win-1'].assigned_wps, ['WP-100']);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('should handle window with state.json but no heartbeat.json', function () {
    var tmpDir = makeTmpDir();
    try {
      var windowsDir = path.join(tmpDir, 'windows');
      writeJson(path.join(windowsDir, 'win-1', 'state.json'), {
        window_id: 'win-1',
        team_name: 'batch-w1',
        current_stage: 1
      });

      var session = coordinator.aggregateWindowStates(windowsDir);

      assert.strictEqual(session.total_windows, 1);
      assert.strictEqual(session.windows['win-1'].status, 'disconnected');
      assert.strictEqual(session.windows['win-1'].heartbeat, null);
      assert.strictEqual(session.windows['win-1'].current_stage, 1);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });
});

// ─────────────────────────────────────────────
// Section 7: Additional computeSessionStatus Edge Cases
// ─────────────────────────────────────────────

test.describe('computeSessionStatus — edge cases', function () {
  test('should return active when mix of active and disconnected', function () {
    var session = {
      status: 'active',
      windows: {
        'win-1': { status: 'active' },
        'win-2': { status: 'disconnected' }
      }
    };
    assert.strictEqual(coordinator.computeSessionStatus(session, ['win-1', 'win-2']), 'active');
  });

  test('should return completed for single completed window', function () {
    var session = {
      status: 'active',
      windows: {
        'win-1': { status: 'completed' }
      }
    };
    assert.strictEqual(coordinator.computeSessionStatus(session, ['win-1']), 'completed');
  });

  test('should return active when all windows disconnected', function () {
    var session = {
      status: 'active',
      windows: {
        'win-1': { status: 'disconnected' },
        'win-2': { status: 'disconnected' }
      }
    };
    // disconnected is not failed and not completed, so allCompleted=false, anyFailed=false → active
    assert.strictEqual(coordinator.computeSessionStatus(session, ['win-1', 'win-2']), 'active');
  });

  test('should return failed over completed when both present', function () {
    var session = {
      status: 'active',
      windows: {
        'win-1': { status: 'completed' },
        'win-2': { status: 'failed' },
        'win-3': { status: 'completed' }
      }
    };
    assert.strictEqual(coordinator.computeSessionStatus(session, ['win-1', 'win-2', 'win-3']), 'failed');
  });
});

// ─────────────────────────────────────────────
// Section 8: Additional isStageComplete Edge Cases
// ─────────────────────────────────────────────

test.describe('isStageComplete — edge cases', function () {
  test('should handle window with null heartbeat', function () {
    var session = {
      stages: [{ stage_id: 1, windows: ['win-1'] }],
      windows: {
        'win-1': { heartbeat: null }
      }
    };
    // null heartbeat → no pending/in_progress check triggers → returns true
    assert.strictEqual(coordinator.isStageComplete(session, 1), true);
  });

  test('should return true when heartbeat shows completed status', function () {
    var session = {
      stages: [{ stage_id: 1, windows: ['win-1', 'win-2'] }],
      windows: {
        'win-1': { heartbeat: { pending: 0, in_progress: 0, completed: 3 } },
        'win-2': { heartbeat: { pending: 0, in_progress: 0, completed: 2 } }
      }
    };
    assert.strictEqual(coordinator.isStageComplete(session, 1), true);
  });
});

// ─────────────────────────────────────────────
// Section 9: Additional findActiveStage Edge Cases
// ─────────────────────────────────────────────

test.describe('findActiveStage — edge cases', function () {
  test('should return first active stage when multiple exist', function () {
    var session = {
      stages: [
        { stage_id: 1, status: 'active' },
        { stage_id: 2, status: 'active' }
      ]
    };
    var active = coordinator.findActiveStage(session);
    assert.strictEqual(active.stage_id, 1);
  });

  test('should return null for empty stages array', function () {
    var session = { stages: [] };
    assert.strictEqual(coordinator.findActiveStage(session), null);
  });
});

// ─────────────────────────────────────────────
// Section 10: Additional advanceStage Edge Cases
// ─────────────────────────────────────────────

test.describe('advanceStage — edge cases', function () {
  test('should return false when no active stage exists', function () {
    var session = {
      stages: [
        { stage_id: 1, status: 'completed' },
        { stage_id: 2, status: 'pending' }
      ],
      windows: {},
      stage_transitions: []
    };
    var result = coordinator.advanceStage(session);
    assert.strictEqual(result, false);
  });

  test('should advance through multiple stages sequentially', function () {
    var session = {
      stages: [
        { stage_id: 1, status: 'active', windows: ['win-1'], started_at: '2026-06-06T10:00:00Z' },
        { stage_id: 2, status: 'pending', windows: ['win-1'] },
        { stage_id: 3, status: 'pending', windows: ['win-1'] }
      ],
      windows: {
        'win-1': { heartbeat: { pending: 0, in_progress: 0 } }
      },
      stage_transitions: [],
      status: 'active'
    };

    // Advance 1→2
    var result1 = coordinator.advanceStage(session);
    assert.strictEqual(result1, true);
    assert.strictEqual(session.stages[0].status, 'completed');
    assert.strictEqual(session.stages[1].status, 'active');
    assert.strictEqual(session.stages[2].status, 'pending');

    // Simulate stage 2 completion
    session.windows['win-1'].heartbeat.pending = 0;
    session.windows['win-1'].heartbeat.in_progress = 0;

    // Advance 2→3
    var result2 = coordinator.advanceStage(session);
    assert.strictEqual(result2, true);
    assert.strictEqual(session.stages[1].status, 'completed');
    assert.strictEqual(session.stages[2].status, 'active');

    // Simulate stage 3 completion
    var result3 = coordinator.advanceStage(session);
    assert.strictEqual(result3, false); // no next stage
    assert.strictEqual(session.stages[2].status, 'completed');
    assert.strictEqual(session.status, 'completed');
    assert.strictEqual(session.stage_transitions.length, 3);
  });
});

// ─────────────────────────────────────────────
// Section 11: Additional findStageForWindow Edge Cases
// ─────────────────────────────────────────────

test.describe('findStageForWindow — edge cases', function () {
  test('should return null when stages have no windows property', function () {
    var session = {
      stages: [
        { stage_id: 1 },
        { stage_id: 2 }
      ]
    };
    assert.strictEqual(coordinator.findStageForWindow(session, 'win-1'), null);
  });
});

// ─────────────────────────────────────────────
// Section 12: Additional writeStageSignal Edge Cases
// ─────────────────────────────────────────────

test.describe('writeStageSignal — edge cases', function () {
  test('should preserve session_id when updating stage signal', function () {
    var tmpDir = makeTmpDir();
    try {
      var windowsDir = path.join(tmpDir, 'windows');
      writeJson(path.join(windowsDir, 'win-1', 'state.json'), {
        window_id: 'win-1',
        session_id: 'mws-preserve-test',
        team_name: 'batch-test',
        current_stage: 1,
        assigned_wps: ['WP-172']
      });

      coordinator.writeStageSignal(windowsDir, 'win-1', 2, ['WP-175']);

      var updated = coordinator.readJsonSafe(path.join(windowsDir, 'win-1', 'state.json'));
      assert.strictEqual(updated.session_id, 'mws-preserve-test');
      assert.strictEqual(updated.window_id, 'win-1');
      assert.strictEqual(updated.current_stage, 2);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });
});

// ─────────────────────────────────────────────
// Section 13: Additional resolveCurrentBatch Edge Cases
// ─────────────────────────────────────────────

test.describe('resolveCurrentBatch — edge cases', function () {
  test('should handle undefined stateFromDisk', function () {
    var result = coordinator.resolveCurrentBatch(['1'], undefined);
    assert.deepStrictEqual(result, ['1']);
  });

  test('should return empty array when in-memory is null and disk has empty array', function () {
    var result = coordinator.resolveCurrentBatch(null, { current_batch: [] });
    assert.deepStrictEqual(result, []);
  });
});
