import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useAuthToken, useClassroom } from '@classroom/core-client';
import './classroom.css';

const COLORS = ['#1f2933', '#d7263d', '#1b7f4f', '#1f6feb', '#c26a00'];
const WIDTHS = [2, 4, 8];

/**
 * One Yjs document per room, served by server/src/realtime/collabServer.js —
 * the same websocket the course builder uses, so there is one collab transport
 * to operate, not two.
 *
 * Split of concerns inside the document:
 *   strokes (Y.Array)  durable — every finished stroke, replayable, survives a
 *                      reload and a server restart (the doc is persisted).
 *   awareness          ephemeral — the cursor position and the stroke currently
 *                      under the pointer. Never persisted, gone on disconnect.
 *
 * That split is what keeps a 40-minute lesson from turning into a CRDT the size
 * of a video file: live drawing costs awareness updates, not document history.
 */
export default function WhiteboardCanvas({ readOnly = false }) {
  const { room, self } = useClassroom();
  const token = useAuthToken();

  const canvasRef = useRef(null);
  const surfaceRef = useRef(null);
  const drawingRef = useRef(null);

  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(WIDTHS[1]);
  const [status, setStatus] = useState('connecting');
  const [cursors, setCursors] = useState([]);

  const isHost = self.role === 'host' || self.role === 'teacher';
  const canDraw = !readOnly && (isHost || room.whiteboard?.openToAll !== false);

  const { doc, strokes, provider, undoManager } = useMemo(() => {
    const d = new Y.Doc();
    const arr = d.getArray('strokes');
    const p = new WebsocketProvider(
      import.meta.env.VITE_WS_URL ?? `${location.origin.replace(/^http/, 'ws')}`,
      `whiteboard:${room.id}`,
      d,
      { connect: false, params: { token }, resyncInterval: 10_000 },
    );
    // Undo is scoped to this client, so a learner cannot undo the teacher's work.
    const um = new Y.UndoManager(arr, { trackedOrigins: new Set([self.id]) });
    return { doc: d, strokes: arr, provider: p, undoManager: um };
  }, [room.id, token, self.id]);

  useEffect(() => {
    provider.connect();
    provider.awareness.setLocalStateField('user', {
      id: self.id,
      name: self.displayName,
      color,
    });
    const onStatus = ({ status: s }) => setStatus(s);
    provider.on('status', onStatus);

    return () => {
      provider.off('status', onStatus);
      undoManager.destroy();
      provider.destroy();
      doc.destroy();
    };
  }, [provider, doc, undoManager, self.id, self.displayName, color]);

  /* ---------------- rendering ---------------- */

  const drawStroke = (ctx, stroke) => {
    const pts = stroke.points;
    if (!pts || pts.length < 4) return;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.stroke();
  };

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const surface = surfaceRef.current;
    if (!canvas || !surface) return;

    const dpr = window.devicePixelRatio || 1;
    const { width: w, height: h } = surface.getBoundingClientRect();
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr * w, 0, 0, dpr * w, 0, 0); // normalised 0..1 coordinates
    ctx.clearRect(0, 0, w, h);

    strokes.toArray().forEach((s) => drawStroke(ctx, s));

    // Strokes still under someone's pointer, including this client's.
    provider.awareness.getStates().forEach((state) => {
      if (state.stroke) drawStroke(ctx, state.stroke);
    });
    if (drawingRef.current) drawStroke(ctx, drawingRef.current);
  }, [strokes, provider]);

  useEffect(() => {
    render();
    const onDoc = () => render();
    const onAwareness = () => {
      setCursors(
        [...provider.awareness.getStates().entries()]
          .filter(([clientId, s]) => clientId !== doc.clientID && s.cursor && s.user)
          .map(([clientId, s]) => ({ clientId, ...s.cursor, user: s.user })),
      );
      render();
    };

    strokes.observe(onDoc);
    provider.awareness.on('change', onAwareness);

    const ro = new ResizeObserver(render);
    if (surfaceRef.current) ro.observe(surfaceRef.current);

    return () => {
      strokes.unobserve(onDoc);
      provider.awareness.off('change', onAwareness);
      ro.disconnect();
    };
  }, [strokes, provider, doc, render]);

  /* ---------------- pointer ---------------- */

  // Coordinates are normalised against the width, so a phone and a projector
  // see the same drawing at different sizes instead of a scaled-off mess.
  const toPoint = (e) => {
    const rect = surfaceRef.current.getBoundingClientRect();
    return [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.width];
  };

  const onPointerDown = (e) => {
    if (!canDraw || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = toPoint(e);
    drawingRef.current = {
      id: crypto.randomUUID(),
      authorId: self.id,
      color,
      width: width / 1000,
      points: [x, y],
    };
  };

  const onPointerMove = (e) => {
    const [x, y] = toPoint(e);
    provider.awareness.setLocalStateField('cursor', { x, y });

    const stroke = drawingRef.current;
    if (!stroke) return;

    // getCoalescedEvents keeps a fast pen smooth without raising the event rate.
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    for (const ev of events) {
      const rect = surfaceRef.current.getBoundingClientRect();
      stroke.points.push((ev.clientX - rect.left) / rect.width, (ev.clientY - rect.top) / rect.width);
    }
    provider.awareness.setLocalStateField('stroke', stroke);
    render();
  };

  const finish = (e) => {
    const stroke = drawingRef.current;
    drawingRef.current = null;
    provider.awareness.setLocalStateField('stroke', null);
    if (!stroke || stroke.points.length < 4) return render();
    // Origin tag is what makes UndoManager undo only this client's strokes.
    doc.transact(() => strokes.push([stroke]), self.id);
    e?.currentTarget?.releasePointerCapture?.(e.pointerId);
  };

  const clearAll = () => {
    if (!isHost) return;
    doc.transact(() => strokes.delete(0, strokes.length), self.id);
  };

  return (
    <div className="cr cr-board">
      <div className="cr-board__toolbar" role="toolbar" aria-label="Whiteboard tools">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className="cr-board__swatch"
            style={{ background: c }}
            aria-pressed={color === c}
            aria-label={`Draw in ${c}`}
            disabled={!canDraw}
            onClick={() => setColor(c)}
          />
        ))}

        <span aria-hidden="true" style={{ opacity: 0.3 }}>|</span>

        {WIDTHS.map((w) => (
          <button
            key={w}
            type="button"
            className={`cr-btn cr-btn--icon${width === w ? ' cr-btn--active' : ''}`}
            aria-pressed={width === w}
            aria-label={`Line width ${w}`}
            disabled={!canDraw}
            onClick={() => setWidth(w)}
          >
            {w}
          </button>
        ))}

        <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 6 }}>
          <button type="button" className="cr-btn" disabled={!canDraw} onClick={() => undoManager.undo()}>
            Undo
          </button>
          <button type="button" className="cr-btn" disabled={!canDraw} onClick={() => undoManager.redo()}>
            Redo
          </button>
          {isHost ? (
            <button type="button" className="cr-btn cr-btn--danger" onClick={clearAll}>
              Clear board
            </button>
          ) : null}
        </span>
      </div>

      <div
        ref={surfaceRef}
        className="cr-board__surface"
        style={{ cursor: canDraw ? 'crosshair' : 'default' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onPointerLeave={() => provider.awareness.setLocalStateField('cursor', null)}
      >
        <canvas ref={canvasRef} className="cr-board__canvas" />

        {cursors.map((c) => (
          <span
            key={c.clientId}
            className="cr-board__cursor"
            style={{
              left: `${c.x * 100}%`,
              top: `${c.y * (surfaceRef.current?.getBoundingClientRect().width ?? 0)}px`,
              background: c.user.color,
            }}
          >
            {c.user.name}
          </span>
        ))}

        {status !== 'connected' ? (
          <p className="cr-board__status">
            {status === 'connecting' ? 'Connecting the board…' : 'Offline — your strokes will sync'}
          </p>
        ) : null}
      </div>
    </div>
  );
}