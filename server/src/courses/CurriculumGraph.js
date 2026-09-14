// classroom-app/server/src/courses/CurriculumGraph.js
/**
 * Curriculum graph  (F3)  [NEW]
 *
 * A learning path is a DAG over modules. This file is the only place that
 * knows it is a graph, and every function here is pure — no database, no
 * network — so the rules can be tested exhaustively and reused by the builder
 * for live validation as the author drags edges around.
 *
 * The invariant that matters: **no cycles**. A cycle makes a course
 * unfinishable — module A needs B, B needs A, and a learner sits looking at two
 * locked modules with no way forward and no explanation. Nothing else in the
 * curriculum can be wrong in a way that is this hard to notice, because the
 * author who built it already knows the material and never walks the path.
 *
 * Everything else here is a warning rather than an error. An unreachable module
 * is probably a mistake; a module with no prerequisites is probably deliberate.
 */

/**
 * @typedef {{ from: string, to: string, requirement?: 'complete'|'pass' }} PathEdge
 */

/** Adjacency in both directions. Built once per call; graphs are tiny. */
const index = (moduleIds, edges) => {
  const outgoing = new Map(moduleIds.map((id) => [id, []]));
  const incoming = new Map(moduleIds.map((id) => [id, []]));

  for (const edge of edges) {
    if (!outgoing.has(edge.from) || !incoming.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge);
    incoming.get(edge.to).push(edge);
  }

  return { outgoing, incoming };
};

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

/**
 * Depth-first, tracking the current stack so the cycle can be *reported* and
 * not merely detected. Kahn's algorithm is simpler but tells you only that a
 * cycle exists — and "your course has a cycle somewhere" is not an error
 * message anybody can act on.
 *
 * @returns {string[]|null} the module ids forming the cycle, in order
 */
export const findCycle = (moduleIds, edges) => {
  const { outgoing } = index(moduleIds, edges);
  const state = new Map(moduleIds.map((id) => [id, 'unvisited']));
  const stack = [];

  const visit = (id) => {
    state.set(id, 'visiting');
    stack.push(id);

    for (const edge of outgoing.get(id) ?? []) {
      const next = edge.to;
      if (state.get(next) === 'visiting') {
        // Found it: everything from `next` to the top of the stack.
        return [...stack.slice(stack.indexOf(next)), next];
      }
      if (state.get(next) === 'unvisited') {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }

    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const id of moduleIds) {
    if (state.get(id) !== 'unvisited') continue;
    const cycle = visit(id);
    if (cycle) return cycle;
  }

  return null;
};

export const hasCycle = (moduleIds, edges) => findCycle(moduleIds, edges) !== null;

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/** Modules with no prerequisite: where a learner may start. */
export const entryModules = (moduleIds, edges) => {
  const { incoming } = index(moduleIds, edges);
  return moduleIds.filter((id) => (incoming.get(id) ?? []).length === 0);
};

/** Modules nothing depends on: where a path ends. */
export const terminalModules = (moduleIds, edges) => {
  const { outgoing } = index(moduleIds, edges);
  return moduleIds.filter((id) => (outgoing.get(id) ?? []).length === 0);
};

/**
 * A valid ordering. Returns null when the graph has a cycle, because a cyclic
 * graph has no topological order by definition.
 */
export const topologicalOrder = (moduleIds, edges) => {
  const { outgoing, incoming } = index(moduleIds, edges);
  const degree = new Map(moduleIds.map((id) => [id, (incoming.get(id) ?? []).length]));
  const queue = moduleIds.filter((id) => degree.get(id) === 0);
  const order = [];

  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const edge of outgoing.get(id) ?? []) {
      const next = degree.get(edge.to) - 1;
      degree.set(edge.to, next);
      if (next === 0) queue.push(edge.to);
    }
  }

  return order.length === moduleIds.length ? order : null;
};

/**
 * Modules that cannot be reached from any entry point. Only possible when part
 * of the graph is cyclic while the rest is not — and a strong sign that an edge
 * was drawn the wrong way round.
 */
export const unreachableModules = (moduleIds, edges) => {
  const { outgoing } = index(moduleIds, edges);
  const seen = new Set();
  const queue = entryModules(moduleIds, edges);

  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of outgoing.get(id) ?? []) queue.push(edge.to);
  }

  return moduleIds.filter((id) => !seen.has(id));
};

/** Prerequisites of one module, direct only. */
export const prerequisitesOf = (moduleId, edges) =>
  edges.filter((edge) => edge.to === moduleId);

/** Everything that must be done first, transitively. */
export const allPrerequisitesOf = (moduleId, edges) => {
  const seen = new Set();
  const queue = [moduleId];

  while (queue.length > 0) {
    const id = queue.shift();
    for (const edge of edges.filter((candidate) => candidate.to === id)) {
      if (seen.has(edge.from)) continue;
      seen.add(edge.from);
      queue.push(edge.from);
    }
  }

  return [...seen];
};

/** Longest chain, for "this course takes N modules end to end". */
export const depth = (moduleIds, edges) => {
  const order = topologicalOrder(moduleIds, edges);
  if (!order) return 0;

  const { incoming } = index(moduleIds, edges);
  const longest = new Map(moduleIds.map((id) => [id, 1]));

  for (const id of order) {
    for (const edge of incoming.get(id) ?? []) {
      longest.set(id, Math.max(longest.get(id), longest.get(edge.from) + 1));
    }
  }

  return Math.max(0, ...longest.values());
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Everything the builder needs to decide whether a path can be saved.
 *
 * Errors block; warnings do not. The distinction is whether a learner would be
 * stuck: a cycle stops them, an orphan module merely means nobody sees it.
 *
 * @returns {{ valid: boolean, errors: object[], warnings: object[] }}
 */
export const validate = ({ moduleIds, edges }) => {
  const errors = [];
  const warnings = [];

  const ids = new Set(moduleIds);

  for (const [position, edge] of edges.entries()) {
    if (edge.from === edge.to) {
      errors.push({
        path: `edges.${position}`,
        code: 'self_reference',
        message: 'A module cannot require itself.',
      });
    }
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      errors.push({
        path: `edges.${position}`,
        code: 'unknown_module',
        message: 'This edge points at a module that is not part of the course.',
      });
    }
  }

  // Duplicates are harmless at runtime but always a mistake in the editor.
  const seen = new Set();
  for (const [position, edge] of edges.entries()) {
    const key = `${edge.from}->${edge.to}`;
    if (seen.has(key)) {
      warnings.push({
        path: `edges.${position}`,
        code: 'duplicate_edge',
        message: 'This prerequisite is listed twice.',
      });
    }
    seen.add(key);
  }

  const cycle = findCycle(moduleIds, edges);
  if (cycle) {
    errors.push({
      path: 'edges',
      code: 'curriculum_cycle',
      // Naming the modules is the difference between a fixable error and a
      // frustrating one.
      message: `These modules depend on each other in a loop: ${cycle.join(' → ')}.`,
      modules: cycle,
    });
  }

  if (!cycle) {
    if (entryModules(moduleIds, edges).length === 0 && moduleIds.length > 0) {
      errors.push({
        path: 'edges',
        code: 'no_entry_point',
        message: 'Every module has a prerequisite, so nobody can start the course.',
      });
    }

    for (const id of unreachableModules(moduleIds, edges)) {
      warnings.push({
        path: `modules.${id}`,
        code: 'unreachable',
        message: 'No learner can reach this module.',
        moduleId: id,
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
};

export default { validate, findCycle, topologicalOrder, entryModules, allPrerequisitesOf };