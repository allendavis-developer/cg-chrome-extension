/* eslint-disable no-var, no-console */
/**
 * Full recursive Web EPOS category-tree scrape with per-top-level streaming.
 *
 * Runs inside `/products/new` (MAIN world). Iterates every option on
 * `#catLevel{N}` depth-first: for each option → setNativeValue → wait for
 * catLevel{N+1} to render → recurse into all its children → backtrack to the
 * next sibling. Leaves (options that don't produce a next select) are
 * recorded and skipped quickly.
 *
 * Streaming: whenever a top-level category's entire subtree is complete,
 * the walker pushes a batch `{ topLevel: { uuid, name }, nodes: [...] }`
 * onto `state.pendingBatches`. The orchestrator polls READ, drains batches,
 * and emits an EXTENSION_PROGRESS_TO_PAGE to the app tab so the frontend can
 * persist + render the new rows incrementally.
 *
 * START kicks off an async run and returns immediately; READ is a synchronous
 * snapshot. The orchestrator polls READ until `done`. Keeps the MV3 boundary
 * simple — every round-trip is a plain object.
 *
 *   window.__CG_WEB_EPOS_CATEGORY_TREE_WALK_START(options?) → { started, reason? }
 *   window.__CG_WEB_EPOS_CATEGORY_TREE_WALK_READ() → {
 *     running, done, nodesCaptured, progressPath, log: string[],
 *     pendingBatches: [{ topLevel: { uuid, name }, nodes: [...] }],
 *     result: { ok, nodes?, error? } | null
 *   }
 */
(function () {
  if (window.__CG_WEB_EPOS_CATEGORY_TREE_WALK_START) return;

  var MAX_LEVELS = 10;
  var DEFAULT_WAIT_AFTER_SELECT_MS = 80;
  var DEFAULT_OPTION_APPEAR_TIMEOUT_MS = 8000;
  var DEFAULT_OPTION_POLL_MS = 40;
  // Two probe budgets:
  //   - FULL: used when we already know a deeper level exists somewhere in the
  //     tree (from a prior discovery). A parent at this level might or might
  //     not have children; give React/fetch time to populate.
  //   - SHORT: used when we're AT the deepest level we've seen so far. We
  //     don't expect children — just a speculative check in case a new branch
  //     extends the depth. If Web EPOS really caps at 3 levels, every level-3
  //     probe costs SHORT instead of FULL (huge win — most nodes are leaves).
  var DEFAULT_FULL_PROBE_TIMEOUT_MS = 500;
  var DEFAULT_SHORT_PROBE_TIMEOUT_MS = 250;
  // How many speculative probes we're willing to do at a new deepest level
  // before concluding it's terminal. Once a level has this many empty probes
  // without ever finding children, we stop probing at it entirely — all
  // remaining siblings at that level (anywhere in the tree) are captured
  // straight from the DOM with no setNativeValue. Cheap + accurate because
  // Web EPOS is at most 3 levels: level 3 proves terminal within 3 probes.
  var TERMINAL_LEVEL_CONCLUSION_THRESHOLD = 3;
  var LOG_PREFIX = '[CG Suite Category Walk]';

  var state = {
    running: false,
    done: false,
    result: null,
    log: [],
    nodesCaptured: 0,
    progressPath: '',
    pendingBatches: [],
    // Deepest catLevel{N} we've observed rendering with options during THIS
    // walk. Starts at 1 (catLevel1 is always present on page load). Bumped
    // whenever a probe reveals a new deeper level.
    maxEverSeenLevel: 1,
    // Probe accounting: `attempts[N]` = how many times we've setNativeValue at
    // level N to look for children, `successes[N]` = how many of those probes
    // found a catLevel{N+1} with options. When attempts-without-success hits
    // TERMINAL_LEVEL_CONCLUSION_THRESHOLD for level N, we mark N terminal —
    // all remaining and future siblings at N are captured straight from the
    // DOM with no setNativeValue dance.
    probeAttempts: {},
    probeSuccesses: {},
    terminalLevels: {},
  };

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function logLine(level, parts) {
    var msg = parts.map(function (p) {
      if (p == null) return String(p);
      if (typeof p === 'string') return p;
      try { return JSON.stringify(p); } catch (_) { return String(p); }
    }).join(' ');
    state.log.push('[' + new Date().toISOString().slice(11, 23) + '][' + level + '] ' + msg);
    try {
      if (level === 'warn') console.warn(LOG_PREFIX, msg);
      else if (level === 'error') console.error(LOG_PREFIX, msg);
      else console.log(LOG_PREFIX, msg);
    } catch (_) { /* console frozen */ }
  }
  var log = {
    info: function () { logLine('info', Array.prototype.slice.call(arguments)); },
    warn: function () { logLine('warn', Array.prototype.slice.call(arguments)); },
    error: function () { logLine('error', Array.prototype.slice.call(arguments)); },
  };

  /** React-safe setter: invoke the prototype's value setter + fire input/change. */
  function setNativeValue(el, value) {
    if (!el) return;
    var v = value == null ? '' : String(value);
    var proto = el.constructor && el.constructor.prototype;
    var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function selectEl(level) {
    return document.getElementById('catLevel' + level);
  }

  function readOptions(sel) {
    if (!sel) return [];
    var opts = [];
    for (var i = 0; i < sel.options.length; i += 1) {
      var o = sel.options[i];
      var value = String(o.value || '').trim();
      if (!value) continue;
      opts.push({ uuid: value, name: String(o.textContent || '').trim() });
    }
    return opts;
  }

  /**
   * After setting a parent select, wait for its child select to appear with
   * options. Short timeout: leaves never render a child so we don't want to
   * burn the full 8s per dead-end.
   */
  async function waitForChildOptions(level, timeoutMs, pollMs) {
    var deadline = Date.now() + Math.max(150, timeoutMs);
    while (Date.now() < deadline) {
      var sel = selectEl(level + 1);
      if (sel) {
        var opts = readOptions(sel);
        if (opts.length > 0) return opts;
      }
      await sleep(pollMs);
    }
    return null;
  }

  /**
   * Depth-first walk. Visits every option at every level, recursing into each
   * sibling before moving on. At level 1, emits a per-top-level batch onto
   * `state.pendingBatches` whenever a subtree completes.
   */
  async function walkAll(level, parentUuid, ancestorPath, cfg, out) {
    if (level > MAX_LEVELS) {
      log.warn('hit MAX_LEVELS', MAX_LEVELS, 'at path', ancestorPath || '(root)');
      return;
    }

    var sel = selectEl(level);
    if (!sel) return;

    var siblings = readOptions(sel);
    if (siblings.length === 0) return;

    for (var i = 0; i < siblings.length; i += 1) {
      var opt = siblings[i];
      var myPath = ancestorPath ? ancestorPath + ' › ' + opt.name : opt.name;
      var topLevelStartIndex = out.length; // used when level === 1

      out.push({ uuid: opt.uuid, name: opt.name, parent_uuid: parentUuid, level: level });
      state.nodesCaptured = out.length;
      state.progressPath = myPath;

      // Level proven terminal already → just read from DOM, no probe.
      // This is the speed-up the user called out: once we know level N never
      // has children (e.g. Web EPOS caps at 3 levels, so level 3 is terminal
      // globally), every sibling at level N is captured in ~0ms instead of
      // paying ~330ms of setNativeValue + probe per dead-end.
      if (state.terminalLevels[level]) {
        log.info(
          'L' + level + ' [' + (i + 1) + '/' + siblings.length + ']',
          '"' + opt.name + '"', '· captured (level', level, 'already proven terminal)'
        );
        // still re-fetch the select for the next iteration in case React
        // re-rendered during a parent cascade
        sel = selectEl(level);
        if (!sel) return;
        continue;
      }

      log.info(
        'L' + level + ' [' + (i + 1) + '/' + siblings.length + ']',
        '"' + opt.name + '"',
        '· uuid=' + opt.uuid,
        '· path=' + myPath
      );

      // Drive the parent select and see if a child level renders. Use a short
      // timeout when we're at the deepest level we've ever seen — most options
      // there are leaves so we don't want to burn 500ms per dead-end. Use the
      // full timeout at levels we've already proven go deeper (a parent there
      // usually has children, so we give React time to fetch+render).
      setNativeValue(sel, opt.uuid);
      await sleep(cfg.waitAfterSelectMs);
      var probeTimeout = level < state.maxEverSeenLevel
        ? cfg.fullProbeTimeoutMs
        : cfg.shortProbeTimeoutMs;
      var childOpts = await waitForChildOptions(level, probeTimeout, cfg.optionPollMs);

      // Accounting for terminal-level detection.
      state.probeAttempts[level] = (state.probeAttempts[level] || 0) + 1;
      if (childOpts && childOpts.length > 0) {
        state.probeSuccesses[level] = (state.probeSuccesses[level] || 0) + 1;
        if (level + 1 > state.maxEverSeenLevel) {
          state.maxEverSeenLevel = level + 1;
          log.info(
            'new maximum depth discovered: level', level + 1,
            '(will use full-length probes at levels shallower than this)'
          );
        }
        await walkAll(level + 1, opt.uuid, myPath, cfg, out);
      } else {
        // No children at this sibling. If we've hit the terminal threshold
        // for this level without ever finding children, stop probing here
        // forever — remaining + future siblings are read straight from DOM.
        var attempts = state.probeAttempts[level] || 0;
        var successes = state.probeSuccesses[level] || 0;
        if (successes === 0 && attempts >= TERMINAL_LEVEL_CONCLUSION_THRESHOLD) {
          state.terminalLevels[level] = true;
          log.info(
            'level', level, 'concluded TERMINAL after', attempts,
            'empty probes · remaining siblings will be captured from DOM only'
          );
        }
      }

      // Top-level subtree complete — emit a streaming batch.
      if (level === 1) {
        var batchNodes = out.slice(topLevelStartIndex);
        state.pendingBatches.push({
          topLevel: { uuid: opt.uuid, name: opt.name },
          nodes: batchNodes,
          index: i + 1,
          total: siblings.length,
        });
        log.info(
          'top-level', (i + 1) + '/' + siblings.length,
          '"' + opt.name + '" complete · subtree size', batchNodes.length,
          '· queued for streaming to app'
        );
      }

      // Re-fetch the select for this level — React may have replaced it
      // during the child walk's cascading re-renders.
      sel = selectEl(level);
      if (!sel) {
        log.warn('L' + level, '— select disappeared mid-iteration at sibling', i + 1);
        return;
      }
    }
  }

  window.__CG_WEB_EPOS_CATEGORY_TREE_WALK_START = function (options) {
    if (state.running) {
      try { console.warn(LOG_PREFIX, 'START called while a walk is already running — ignored'); } catch (_) {}
      return { started: false, reason: 'already-running' };
    }
    state = {
      running: true,
      done: false,
      result: null,
      log: [],
      nodesCaptured: 0,
      progressPath: '',
      pendingBatches: [],
      maxEverSeenLevel: 1,
      probeAttempts: {},
      probeSuccesses: {},
      terminalLevels: {},
    };
    log = {
      info: function () { logLine('info', Array.prototype.slice.call(arguments)); },
      warn: function () { logLine('warn', Array.prototype.slice.call(arguments)); },
      error: function () { logLine('error', Array.prototype.slice.call(arguments)); },
    };

    var cfg = Object.assign(
      {
        waitAfterSelectMs: DEFAULT_WAIT_AFTER_SELECT_MS,
        optionAppearTimeoutMs: DEFAULT_OPTION_APPEAR_TIMEOUT_MS,
        optionPollMs: DEFAULT_OPTION_POLL_MS,
        fullProbeTimeoutMs: DEFAULT_FULL_PROBE_TIMEOUT_MS,
        shortProbeTimeoutMs: DEFAULT_SHORT_PROBE_TIMEOUT_MS,
      },
      options || {}
    );

    log.info('full tree walk starting · url:', window.location.href);
    var rootSel = selectEl(1);
    if (!rootSel) {
      log.error('#catLevel1 not found — is this /products/new?');
      state.result = { ok: false, error: '#catLevel1 not found — is this /products/new?' };
      state.done = true;
      state.running = false;
      return { started: false, reason: 'no-catLevel1' };
    }
    log.info('initial #catLevel1 options:', readOptions(rootSel).length);

    (async function run() {
      try {
        var nodes = [];
        await walkAll(1, null, '', cfg, nodes);

        var levelBreakdown = {};
        for (var i = 0; i < nodes.length; i += 1) {
          var lv = nodes[i].level;
          levelBreakdown[lv] = (levelBreakdown[lv] || 0) + 1;
        }
        log.info(
          'walk finished · captured', nodes.length, 'nodes · breakdown:',
          JSON.stringify(levelBreakdown)
        );
        state.result = { ok: true, nodes: nodes };
      } catch (e) {
        log.error('walk threw:', (e && e.message) ? e.message : String(e));
        state.result = { ok: false, error: (e && e.message) ? String(e.message) : 'walk failed' };
      } finally {
        state.done = true;
        state.running = false;
      }
    })();

    return { started: true };
  };

  window.__CG_WEB_EPOS_CATEGORY_TREE_WALK_READ = function () {
    return {
      running: state.running,
      done: state.done,
      nodesCaptured: state.nodesCaptured,
      progressPath: state.progressPath,
      log: state.log.slice(),
      pendingBatches: state.pendingBatches.slice(),
      result: state.done ? state.result : null,
    };
  };
})();
