import { useCallback, useMemo, useRef, useState } from 'react';
import { useCourse } from '@classroom/core-client';
import './builder.css';

const NODE_W = 190;
const COL = 250;
const ROW = 104;

/**
 * Kahn's algorithm, run twice over: once to place nodes in columns, once to find
 * what is left over. Anything still unvisited at the end is inside a cycle.
 *
 * The server decides for real — CurriculumGraph.js rejects a cycle on save and
 * PublishDialog refuses to publish one. This runs locally so the author sees the
 * loop the instant they draw it, in red, instead of at publish time.
 */
function layout(modules, edges) {
  const indegree = new Map(modules.map((m) => [m.id, 0]));
  const out = new Map(modules.map((m) => [m.id, []]));

  for (const e of edges) {
    if (!indegree.has(e.to) || !out.has(e.from)) continue;
    indegree.set(e.to, indegree.get(e.to) + 1);
    out.get(e.from).push(e.to);
  }

  const level = new Map();
  const queue = modules.filter((m) => indegree.get(m.id) === 0).map((m) => m.id);
  queue.forEach((id) => level.set(id, 0));

  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    for (const next of out.get(id) ?? []) {
      level.set(next, Math.max(level.get(next) ?? 0, (level.get(id) ?? 0) + 1));
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }

  const inCycle = new Set(modules.filter((m) => !level.has(m.id)).map((m) => m.id));

  // Nodes in a cycle still need somewhere to sit, or they vanish from the view
  // that is supposed to show the problem.
  let stray = 0;
  const perLevel = new Map();
  const positions = new Map();

  for (const m of modules) {
    const lvl = level.has(m.id) ? level.get(m.id) : (stray += 1, 0);
    const row = perLevel.get(lvl) ?? 0;
    perLevel.set(lvl, row + 1);
    positions.set(m.id, { x: 24 + lvl * COL, y: 24 + row * ROW });
  }

  const width = 24 + (Math.max(0, perLevel.size - 1) * COL) + NODE_W + 40;
  const height = 24 + Math.max(1, Math.max(...perLevel.values(), 1)) * ROW + 40;

  return { positions, inCycle, width, height };
}

function edgePath(from, to) {
  const x1 = from.x + NODE_W;
  const y1 = from.y + 34;
  const x2 = to.x;
  const y2 = to.y + 34;
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/**
 * A learning path is a DAG of modules, not a list. This view is where that shape
 * is edited: drag from a module's right handle onto another module to say "that
 * one unlocks this one", click an edge to remove it.
 *
 * PrerequisiteResolver evaluates these edges per learner, so an edge added here
 * changes what is locked for people already enrolled — which is why removing one
 * never locks anything that was already open.
 */
export default function PathGraphEditor({ courseId }) {
  const { modules, edges, addEdge, removeEdge, readOnly, lessonsByModule } = useCourse(courseId);
  const areaRef = useRef(null);
  const [pending, setPending] = useState(null); // { fromId, x, y }

  const { positions, inCycle, width, height } = useMemo(
    () => layout(modules, edges),
    [modules, edges],
  );

  const pointFrom = useCallback((e) => {
    const rect = areaRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left + areaRef.current.scrollLeft, y: e.clientY - rect.top + areaRef.current.scrollTop };
  }, []);

  const startEdge = (moduleId) => (e) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    setPending({ fromId: moduleId, ...pointFrom(e) });
  };

  const finishEdge = (toId) => () => {
    if (!pending || readOnly) return;
    if (pending.fromId !== toId) addEdge({ from: pending.fromId, to: toId });
    setPending(null);
  };

  if (modules.length === 0) {
    return (
      <section className="cb cb-column">
        <header className="cb-column__head">
          <p className="cb-column__title">Prerequisites</p>
        </header>
        <div className="cb-column__body">
          <p className="cb-note">Add a module in the Structure view first.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="cb cb-column" aria-label="Prerequisites">
      <header className="cb-column__head">
        <p className="cb-column__title">Prerequisites</p>
        {inCycle.size ? (
          <span className="cb-note cb-note--danger">
            {inCycle.size} module(s) are in a loop — nothing in a loop can ever unlock.
          </span>
        ) : (
          <span className="cb-note">Drag from a module's right dot onto another module.</span>
        )}
      </header>

      <div
        className="cb-graph"
        ref={areaRef}
        onPointerMove={(e) => pending && setPending({ ...pending, ...pointFrom(e) })}
        onPointerUp={() => setPending(null)}
        onPointerLeave={() => setPending(null)}
      >
        <div className="cb-graph__nodes" style={{ width, height }}>
          <svg className="cb-graph__svg" width={width} height={height} aria-hidden="true">
            <defs>
              <marker
                id="cb-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
              </marker>
            </defs>

            {edges.map((e) => {
              const from = positions.get(e.from);
              const to = positions.get(e.to);
              if (!from || !to) return null;
              const bad = inCycle.has(e.from) && inCycle.has(e.to);
              const d = edgePath(from, to);

              return (
                <g key={`${e.from}->${e.to}`} color="var(--cb-muted)">
                  <path
                    className={`cb-graph__edge${bad ? ' cb-graph__edge--cycle' : ''}`}
                    d={d}
                    markerEnd="url(#cb-arrow)"
                  />
                  {readOnly ? null : (
                    <path
                      className="cb-graph__hit"
                      d={d}
                      onClick={() => removeEdge(e)}
                      style={{ pointerEvents: 'stroke' }}
                    >
                      <title>Remove this prerequisite</title>
                    </path>
                  )}
                </g>
              );
            })}

            {pending
              ? (() => {
                  const from = positions.get(pending.fromId);
                  if (!from) return null;
                  return (
                    <path
                      className="cb-graph__edge cb-graph__edge--live"
                      d={edgePath(from, { x: pending.x, y: pending.y - 34 })}
                    />
                  );
                })()
              : null}
          </svg>

          {modules.map((m) => {
            const pos = positions.get(m.id);
            const count = (lessonsByModule?.[m.id] ?? []).length;
            return (
              <div
                key={m.id}
                className="cb-node"
                data-cycle={inCycle.has(m.id)}
                style={{ left: pos.x, top: pos.y }}
                onPointerUp={finishEdge(m.id)}
              >
                <span className="cb-node__title">{m.title || 'Untitled module'}</span>
                <span className="cb-node__meta">
                  {count} {count === 1 ? 'lesson' : 'lessons'}
                  {inCycle.has(m.id) ? ' · in a loop' : ''}
                </span>

                {readOnly ? null : (
                  <>
                    <button
                      type="button"
                      className="cb-node__handle cb-node__handle--in"
                      aria-label={`Make ${m.title || 'this module'} depend on another`}
                      onPointerUp={finishEdge(m.id)}
                    />
                    <button
                      type="button"
                      className="cb-node__handle cb-node__handle--out"
                      aria-label={`Start a prerequisite from ${m.title || 'this module'}`}
                      onPointerDown={startEdge(m.id)}
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}