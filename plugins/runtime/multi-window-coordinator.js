/**
 * Multi-Window Coordinator — Aggregates per-window states into a global session view
 *
 * @module multi-window-coordinator
 *
 * This module provides:
 *   - Data structure factories for multi-window-session.json, window state.json, heartbeat.json
 *   - Aggregation logic: reads windows/{id}/state.json + heartbeat.json, produces session-level view
 *   - Stage completion detection and global progress calculation
 *
 * Design doc: docs/reports/multi-window-monitoring-design.html (Section 5)
 * Work package: WP-172-1-impl-a
 */

'use strict';

var fs = require('fs');
var path = require('path');

// ─────────────────────────────────────────────
// Section 1: Data Structure Factories
// ─────────────────────────────────────────────

/**
 * Create a multi-window-session.json template.
 *
 * @param {object} opts
 * @param {string} opts.session_id - Unique session identifier (e.g. "mws-20260606-143000")
 * @param {number} opts.total_windows - Number of windows in this session
 * @param {Array<object>} [opts.stages] - Stage definitions
 * @returns {object} Session skeleton conforming to the multi-window-session.json schema
 */
function createSessionSchema(opts) {
  var now = new Date().toISOString();
  return {
    session_id: opts.session_id,
    created_at: now,
    updated_at: now,
    status: 'active',                // active | paused | completed | failed
    total_windows: opts.total_windows || 0,
    total_tasks: 0,
    completed_tasks: 0,
    failed_tasks: 0,
    stages: opts.stages || [],
    windows: {},
    global_concurrency: {
      max_total: 8,                  // cross-window max concurrent teamees
      current_active: 0
    },
    stage_transitions: []
  };
}

/**
 * Create a windows/{win-id}/state.json template.
 * Backward-compatible with dispatcher-state.json; adds window_id, session_id,
 * current_stage, assigned_wps.
 *
 * @param {object} opts
 * @param {string} opts.window_id - Window identifier (e.g. "win-1")
 * @param {string} opts.session_id - Parent session ID
 * @param {string} opts.team_name - Team name for this window
 * @param {number} [opts.total_tasks=0] - Total tasks assigned to this window
 * @returns {object} Window state skeleton
 */
function createWindowStateSchema(opts) {
  return {
    window_id: opts.window_id,
    session_id: opts.session_id,
    team_name: opts.team_name || '',
    teamee_map: {},
    wp_assignments: {},
    start_time: new Date().toISOString(),
    loop_iteration: 0,
    processed_action_ids: [],
    total_tasks: opts.total_tasks || 0,
    status: 'monitoring',            // monitoring | completed
    max_batch_size: 5,
    current_batch: [],
    pending_batches: [],
    global_pause_flag: false,
    current_stage: opts.current_stage || null,
    assigned_wps: opts.assigned_wps || []
  };
}

/**
 * Create a windows/{win-id}/heartbeat.json template.
 * Extends existing heartbeat.json with window_id field.
 *
 * @param {object} opts
 * @param {string} opts.window_id - Window identifier
 * @param {string} opts.session_id - Parent session / team name
 * @param {number} [opts.pid=0] - OS process ID
 * @param {string} opts.team_name - Team name
 * @returns {object} Heartbeat skeleton
 */
function createWindowHeartbeatSchema(opts) {
  return {
    window_id: opts.window_id,
    session_id: opts.session_id || '',
    pid: opts.pid || 0,
    team_name: opts.team_name || '',
    loop_iteration: 0,
    total_tasks: 0,
    completed_tasks: 0,
    in_progress_tasks: 0,
    pending_tasks: 0,
    last_update: new Date().toISOString(),
    status: 'monitoring'             // monitoring | shutting_down | completed
  };
}

// ─────────────────────────────────────────────
// Section 2: Aggregation Logic
// ─────────────────────────────────────────────

/**
 * Read and parse a JSON file. Returns null on any error.
 * @param {string} filePath
 * @returns {object|null}
 */
function readJsonSafe(filePath) {
  try {
    var content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (_e) {
    return null;
  }
}

/**
 * List subdirectory names under a directory. Returns [] on error.
 * @param {string} dirPath
 * @returns {string[]}
 */
function listSubdirs(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(function (d) { return d.isDirectory(); })
      .map(function (d) { return d.name; });
  } catch (_e) {
    return [];
  }
}

/**
 * Aggregate all window states into a multi-window-session object.
 *
 * Reads windows/{win-id}/state.json and windows/{win-id}/heartbeat.json
 * for every subdirectory under `windowsDir`, then computes global totals.
 *
 * @param {string} windowsDir - Absolute path to the windows/ directory
 * @param {object} [existingSession] - Optional existing session to update (preserves stages, transitions)
 * @returns {object} Aggregated multi-window-session.json content
 */
function aggregateWindowStates(windowsDir, existingSession) {
  var windowDirs = listSubdirs(windowsDir);
  var now = new Date().toISOString();

  var session = existingSession || createSessionSchema({
    session_id: 'mws-' + now.replace(/[:.]/g, '').slice(0, 15),
    total_windows: windowDirs.length
  });

  session.updated_at = now;
  session.total_windows = windowDirs.length;

  var globalTotalTasks = 0;
  var globalCompleted = 0;
  var globalFailed = 0;
  var globalActive = 0;

  // Reset windows map to reflect current scan
  session.windows = {};

  for (var i = 0; i < windowDirs.length; i++) {
    var winId = windowDirs[i];
    var winDir = path.join(windowsDir, winId);

    var state = readJsonSafe(path.join(winDir, 'state.json'));
    var heartbeat = readJsonSafe(path.join(winDir, 'heartbeat.json'));

    // Build aggregated window entry
    var winEntry = aggregateSingleWindow(winId, state, heartbeat);
    session.windows[winId] = winEntry;

    // Accumulate global counters from heartbeat (source of truth for task counts)
    if (heartbeat) {
      globalTotalTasks += (heartbeat.total_tasks || 0);
      globalCompleted += (heartbeat.completed_tasks || 0);
      // Count failed from state if available, otherwise 0
      globalFailed += (state && state.failed_tasks) || 0;
    }

    if (winEntry.status === 'active') {
      globalActive += (heartbeat && heartbeat.in_progress_tasks) || 0;
    }
  }

  session.total_tasks = globalTotalTasks;
  session.completed_tasks = globalCompleted;
  session.failed_tasks = globalFailed;
  session.global_concurrency.current_active = globalActive;

  // Determine overall session status
  session.status = computeSessionStatus(session, windowDirs);

  return session;
}

/**
 * Aggregate a single window's state + heartbeat into a summary entry.
 *
 * @param {string} winId
 * @param {object|null} state - Parsed state.json
 * @param {object|null} heartbeat - Parsed heartbeat.json
 * @returns {object} Window summary for session.windows[winId]
 */
function aggregateSingleWindow(winId, state, heartbeat) {
  var windowStatus = 'disconnected';
  var error = null;

  if (heartbeat) {
    var lastUpdateMs = new Date(heartbeat.last_update).getTime();
    var heartbeatAge = Date.now() - lastUpdateMs;
    var STALE_THRESHOLD_MS = 120000; // 2 minutes

    // B11: a malformed/missing last_update yields NaN age. NaN > THRESHOLD is
    // false, so without this guard the window would be misclassified as
    // alive. Treat NaN age as disconnected (safest — we have no valid signal).
    if (isNaN(heartbeatAge) || heartbeatAge > STALE_THRESHOLD_MS) {
      windowStatus = 'disconnected';
    } else if (heartbeat.status === 'completed') {
      windowStatus = 'completed';
    } else if (heartbeat.in_progress_tasks > 0) {
      windowStatus = 'active';
    } else if (heartbeat.pending_tasks > 0) {
      windowStatus = 'idle';
    } else {
      windowStatus = 'active';
    }
  }

  return {
    window_id: winId,
    pid: heartbeat ? heartbeat.pid : 0,
    status: windowStatus,
    current_stage: state ? state.current_stage : null,
    assigned_wps: state ? (state.assigned_wps || []) : [],
    heartbeat: heartbeat ? {
      last_update: heartbeat.last_update,
      loop_iteration: heartbeat.loop_iteration,
      completed: heartbeat.completed_tasks || 0,
      in_progress: heartbeat.in_progress_tasks || 0,
      pending: heartbeat.pending_tasks || 0
    } : null,
    error: error
  };
}

/**
 * Compute overall session status from aggregated data.
 *
 * @param {object} session
 * @param {string[]} windowDirs
 * @returns {string} 'active' | 'completed' | 'failed' | 'paused'
 */
function computeSessionStatus(session, windowDirs) {
  if (session.status === 'paused') {
    return 'paused';
  }

  var allCompleted = true;
  var anyFailed = false;
  var anyActive = false;

  var winIds = Object.keys(session.windows);
  for (var i = 0; i < winIds.length; i++) {
    var w = session.windows[winIds[i]];
    if (w.status !== 'completed') {
      allCompleted = false;
    }
    if (w.status === 'failed') {
      anyFailed = true;
    }
    if (w.status === 'active') {
      anyActive = true;
    }
  }

  if (anyFailed) return 'failed';
  if (allCompleted && winIds.length > 0) return 'completed';
  if (anyActive) return 'active';
  return 'active';
}

// ─────────────────────────────────────────────
// Section 3: Stage Management
// ─────────────────────────────────────────────

/**
 * Check whether a stage is complete: all windows in the stage have
 * completed all their assigned work_packages.
 *
 * @param {object} session - Aggregated session
 * @param {number} stageId
 * @returns {boolean}
 */
function isStageComplete(session, stageId) {
  var stage = null;
  for (var i = 0; i < session.stages.length; i++) {
    if (session.stages[i].stage_id === stageId) {
      stage = session.stages[i];
      break;
    }
  }
  if (!stage) return false;

  for (var j = 0; j < stage.windows.length; j++) {
    var winId = stage.windows[j];
    var winState = session.windows[winId];
    if (!winState) return false;

    // Check that all WPs assigned to this window for this stage are reflected
    // as completed in the heartbeat
    if (winState.heartbeat && winState.heartbeat.pending > 0) {
      return false;
    }
    if (winState.heartbeat && winState.heartbeat.in_progress > 0) {
      return false;
    }
  }

  return true;
}

/**
 * Find the currently active stage.
 *
 * @param {object} session
 * @returns {object|null} The active stage, or null
 */
function findActiveStage(session) {
  for (var i = 0; i < session.stages.length; i++) {
    if (session.stages[i].status === 'active') {
      return session.stages[i];
    }
  }
  return null;
}

/**
 * Get the next stage after the given one.
 *
 * @param {object} session
 * @param {number} currentStageId
 * @returns {object|null}
 */
function getNextStage(session, currentStageId) {
  for (var i = 0; i < session.stages.length; i++) {
    if (session.stages[i].stage_id === currentStageId && i + 1 < session.stages.length) {
      return session.stages[i + 1];
    }
  }
  return null;
}

/**
 * Advance the session to the next stage. Marks current stage completed,
 * next stage active, and records the transition.
 *
 * @param {object} session - Mutated in place
 * @returns {boolean} true if advanced, false if no next stage
 */
function advanceStage(session) {
  var active = findActiveStage(session);
  if (!active) return false;

  if (!isStageComplete(session, active.stage_id)) return false;

  var now = new Date().toISOString();
  active.status = 'completed';
  active.completed_at = now;

  var next = getNextStage(session, active.stage_id);
  if (next) {
    next.status = 'active';
    next.started_at = now;
    session.stage_transitions.push({
      from_stage: active.stage_id,
      to_stage: next.stage_id,
      trigger: 'auto',
      condition: 'all_windows_completed',
      transitioned_at: now
    });
    return true;
  } else {
    // All stages done
    session.status = 'completed';
    session.stage_transitions.push({
      from_stage: active.stage_id,
      to_stage: null,
      trigger: 'auto',
      condition: 'all_stages_completed',
      transitioned_at: now
    });
    return false;
  }
}

// ─────────────────────────────────────────────
// Section 4: Stage Transition Protocol
// ─────────────────────────────────────────────

/**
 * Find the stage entry that includes the given window_id.
 *
 * @param {object} session - Multi-window session
 * @param {string} windowId - Window identifier
 * @returns {object|null} The stage entry, or null
 */
function findStageForWindow(session, windowId) {
  for (var i = 0; i < session.stages.length; i++) {
    var stage = session.stages[i];
    if (stage.windows && stage.windows.indexOf(windowId) !== -1) {
      return stage;
    }
  }
  return null;
}

/**
 * Write a stage signal to a window's state.json file.
 * Updates the current_stage field so the window's agent-dispatcher
 * can detect stage transitions during its Phase 0 check.
 *
 * @param {string} windowsDir - Absolute path to the windows/ directory
 * @param {string} windowId - Target window identifier
 * @param {number} stageId - The stage ID to signal
 * @param {Array<string>} [workPackages] - Optional work packages for the new stage
 * @returns {boolean} true if written successfully
 */
function writeStageSignal(windowsDir, windowId, stageId, workPackages) {
  var statePath = path.join(windowsDir, windowId, 'state.json');
  var state = readJsonSafe(statePath);
  if (!state) return false;

  state.current_stage = stageId;
  if (workPackages) {
    state.assigned_wps = workPackages;
  }

  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
    return true;
  } catch (_e) {
    return false;
  }
}

// ─────────────────────────────────────────────
// Section 5: current_batch Persistence Fix
// ─────────────────────────────────────────────

/**
 * Ensure current_batch is correctly preserved in a state write-back object.
 *
 * The bug (wp-069-3 diagnostic): Phase B.5/C.5/D.5 state write-backs could
 * lose the current_batch value if the variable was stale or reset. This
 * function validates and returns the correct current_batch value.
 *
 * @param {*} currentBatch - The current_batch value from memory
 * @param {object} stateFromDisk - The state read from disk (Phase 0 recovery)
 * @returns {Array} The authoritative current_batch
 */
function resolveCurrentBatch(currentBatch, stateFromDisk) {
  // If in-memory batch is a non-empty array, it takes priority
  if (Array.isArray(currentBatch) && currentBatch.length > 0) {
    return currentBatch;
  }
  // Fall back to disk value
  if (stateFromDisk && Array.isArray(stateFromDisk.current_batch) && stateFromDisk.current_batch.length > 0) {
    return stateFromDisk.current_batch;
  }
  // Both empty — this is valid (no active batch)
  return Array.isArray(currentBatch) ? currentBatch : [];
}

/**
 * Build a complete state write-back payload that guarantees current_batch
 * and pending_batches are never lost.
 *
 * @param {object} params
 * @param {string} params.team_name
 * @param {object} params.teamee_map
 * @param {object} params.wp_assignments
 * @param {string|Date} params.start_time
 * @param {number} params.loop_iteration
 * @param {string[]} params.processed_action_ids
 * @param {number} params.total_tasks
 * @param {string} params.status
 * @param {number} params.max_batch_size
 * @param {Array} params.current_batch
 * @param {Array} params.pending_batches
 * @param {boolean} params.global_pause_flag
 * @returns {object} Complete state object ready for JSON serialization
 */
function buildStatePayload(params) {
  return {
    team_name: params.team_name,
    teamee_map: params.teamee_map || {},
    wp_assignments: params.wp_assignments || {},
    start_time: params.start_time instanceof Date
      ? params.start_time.toISOString()
      : params.start_time,
    loop_iteration: params.loop_iteration,
    processed_action_ids: params.processed_action_ids || [],
    total_tasks: params.total_tasks,
    status: params.status || 'monitoring',
    max_batch_size: params.max_batch_size,
    current_batch: Array.isArray(params.current_batch) ? params.current_batch : [],
    pending_batches: Array.isArray(params.pending_batches) ? params.pending_batches : [],
    global_pause_flag: params.global_pause_flag || false
  };
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

module.exports = {
  // Data structure factories
  createSessionSchema: createSessionSchema,
  createWindowStateSchema: createWindowStateSchema,
  createWindowHeartbeatSchema: createWindowHeartbeatSchema,

  // Aggregation
  aggregateWindowStates: aggregateWindowStates,
  aggregateSingleWindow: aggregateSingleWindow,
  computeSessionStatus: computeSessionStatus,

  // Stage management
  isStageComplete: isStageComplete,
  findActiveStage: findActiveStage,
  getNextStage: getNextStage,
  advanceStage: advanceStage,

  // Stage transition protocol
  findStageForWindow: findStageForWindow,
  writeStageSignal: writeStageSignal,

  // current_batch fix
  resolveCurrentBatch: resolveCurrentBatch,
  buildStatePayload: buildStatePayload,

  // Internal helpers (exposed for testing)
  readJsonSafe: readJsonSafe,
  listSubdirs: listSubdirs
};
