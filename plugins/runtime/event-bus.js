/**
 * EventBus - Event dispatch system for AI Agent Harness
 *
 * Features:
 *   - on(event, handler)    register a listener
 *   - once(event, handler)  one-time listener
 *   - off(event, handler)   unregister a listener
 *   - emit(event, data)     dispatch an event
 *   - History recording and query for debugging
 *   - Subscription objects with unsubscribe() support
 */

'use strict';

class EventBus {
  /**
   * @param {object} [options]
   * @param {number} [options.maxHistory=100] - max event history entries
   */
  constructor(options) {
    options = options || {};
    /** @type {Map<string, Set<Function>>} event -> handlers */
    this._handlers = new Map();
    /** @type {object[]} */
    this._history = [];
    /** @type {number} */
    this._maxHistory = options.maxHistory || 100;
  }

  // --- public API ---

  /**
   * Register an event handler.
   * @param {string} event - event name
   * @param {Function} handler - callback(eventData)
   * @returns {{ unsubscribe: Function }} subscription handle
   */
  on(event, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('EventBus.on(): handler must be a function');
    }
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    this._handlers.get(event).add(handler);

    var self = this;
    var handlers = this._handlers.get(event);
    return {
      unsubscribe: function () {
        handlers.delete(handler);
        if (handlers.size === 0) {
          self._handlers.delete(event);
        }
      },
    };
  }

  /**
   * Register a one-time event handler. Automatically removed after first invocation.
   * @param {string} event
   * @param {Function} handler - callback(eventData)
   * @returns {{ unsubscribe: Function }}
   */
  once(event, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('EventBus.once(): handler must be a function');
    }
    var self = this;
    var wrapped = function (data) {
      handler(data);
      innerSub.unsubscribe();
    };
    var innerSub = this.on(event, wrapped);
    return innerSub;
  }

  /**
   * Unregister a specific handler from an event.
   * @param {string} event
   * @param {Function} handler - the exact function reference originally passed to on()
   */
  off(event, handler) {
    var handlers = this._handlers.get(event);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) {
      this._handlers.delete(event);
    }
  }

  /**
   * Emit an event, calling all registered handlers synchronously.
   * Errors in individual handlers are caught and logged, not propagated.
   * @param {string} event
   * @param {*} data
   */
  emit(event, data) {
    // Record in history
    this._history.push({
      event: event,
      data: data,
      timestamp: Date.now(),
    });
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }

    // Dispatch to handlers
    var handlers = this._handlers.get(event);
    if (!handlers) return;

    handlers.forEach(function (handler) {
      try {
        handler(data);
      } catch (err) {
        console.error(
          '[EventBus] Error in handler for event "' + event + '":',
          err.message
        );
      }
    });
  }

  /**
   * Query event history for debugging.
   * @param {object} [filter]
   * @param {string} [filter.event]  - substring match on event name
   * @param {number} [filter.since]  - timestamp lower bound (ms)
   * @param {number} [filter.until]  - timestamp upper bound (ms)
   * @param {number} [filter.limit]  - max entries to return
   * @returns {object[]}
   */
  getHistory(filter) {
    filter = filter || {};
    var results = this._history;

    if (filter.event) {
      var substr = filter.event;
      results = results.filter(function (e) {
        return e.event.indexOf(substr) !== -1;
      });
    }
    if (filter.since) {
      results = results.filter(function (e) { return e.timestamp >= filter.since; });
    }
    if (filter.until) {
      results = results.filter(function (e) { return e.timestamp <= filter.until; });
    }
    if (filter.limit) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  /**
   * Clear all event history.
   */
  clearHistory() {
    this._history = [];
  }

  /**
   * Remove all handlers for a specific event, or all events.
   * @param {string} [event] - if omitted, clears all handlers
   */
  removeAllListeners(event) {
    if (event) {
      this._handlers.delete(event);
    } else {
      this._handlers.clear();
    }
  }

  /**
   * Get the number of handlers registered for a given event.
   * @param {string} event
   * @returns {number}
   */
  listenerCount(event) {
    var handlers = this._handlers.get(event);
    return handlers ? handlers.size : 0;
  }
}

module.exports = EventBus;
