import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { basicSetup, EditorView } from 'codemirror';
import { useEffect, useRef, useState } from 'react';
import { compileAlgorithm, EDITOR_REFERENCE, EDITOR_TEMPLATE } from '../algorithms/compile';
import { FILE_ALGORITHMS } from '../algorithms/registry';
import { useStore } from './store';

function CodeEditor(props: { docKey: string; value: string; onChange: (v: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;
  useEffect(() => {
    const view = new EditorView({
      doc: props.value,
      parent: host.current!,
      extensions: [
        basicSetup,
        javascript(),
        oneDark,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange.current(u.state.doc.toString());
        }),
      ],
    });
    return () => view.destroy();
    // the editor is recreated only when another algorithm is opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.docKey]);
  return <div className="code" ref={host} />;
}

export function EditorTab() {
  const editorAlgos = useStore((s) => s.editorAlgos);
  const algoId = useStore((s) => s.algoId);
  const set = useStore((s) => s.set);
  const setTab = useStore((s) => s.setTab);
  const liveTab = useStore((s) => s.liveTab);
  const [active, setActive] = useState<string | null>(editorAlgos.find((e) => e.id === algoId)?.id ?? editorAlgos[0]?.id ?? null);
  const current = editorAlgos.find((e) => e.id === active) ?? null;
  const [draft, setDraft] = useState(current?.source ?? '');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setDraft(current?.source ?? '');
    setStatus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const create = () => {
    const id = `editor:${Date.now().toString(36)}`;
    set({ editorAlgos: [...editorAlgos, { id, name: 'My algorithm', source: EDITOR_TEMPLATE }] });
    setActive(id);
  };
  const save = (use: boolean) => {
    if (!current) return;
    try {
      const algo = compileAlgorithm(draft, current.id);
      set({
        editorAlgos: editorAlgos.map((e) => (e.id === current.id ? { ...e, name: algo.name, source: draft } : e)),
        ...(use ? { algoId: current.id } : {}),
      });
      setStatus({ ok: true, text: use ? `Saved. “${algo.name}” is now running in the simulation.` : 'Saved.' });
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };
  const remove = () => {
    if (!current || !confirm(`Delete “${current.name}”?`)) return;
    const rest = editorAlgos.filter((e) => e.id !== current.id);
    set({ editorAlgos: rest, ...(algoId === current.id ? { algoId: 'eta' } : {}) });
    setActive(rest[0]?.id ?? null);
  };
  const dirty = !!current && draft !== current.source;

  return (
    <div className="page editor-page">
      <div className="page-side">
        <h2>Your algorithms</h2>
        <p className="note">Write an algorithm here and it runs immediately in the 3D simulation and in Compare. It is saved in this browser.</p>
        <div className="algo-list">
          {editorAlgos.map((e) => (
            <button key={e.id} className={e.id === active ? 'on' : ''} onClick={() => setActive(e.id)}>
              {e.name}{e.id === algoId && <em>running</em>}
            </button>
          ))}
        </div>
        <div className="chips">
          <button className="primary" onClick={create}>+ New algorithm</button>
        </div>
        <h4>Prefer files?</h4>
        <p className="note">
          Any <code>.ts</code> file in <code>src/algorithms/custom/</code> that default-exports an algorithm appears in the algorithm list too, with full type checking in VS Code.
          {FILE_ALGORITHMS.length > 0 && <> Found now: {FILE_ALGORITHMS.map((a) => a.name).join(', ')}.</>}
        </p>
      </div>

      <div className="page-main editor-main">
        {current ? (
          <>
            <div className="editor-bar">
              <b>{current.name}</b>
              {dirty && <span className="muted">unsaved changes</span>}
              <span className="spacer" />
              <button onClick={remove}>Delete</button>
              <button onClick={() => save(false)} disabled={!dirty}>Save</button>
              <button className="primary" onClick={() => { save(true); }}>Save &amp; run</button>
              <button onClick={() => setTab(liveTab)}>Watch in 3D →</button>
            </div>
            {status && <p className={status.ok ? 'ok' : 'warn'}>{status.text}</p>}
            <CodeEditor docKey={current.id} value={current.source} onChange={setDraft} />
          </>
        ) : (
          <div className="empty">
            <h3>Write your own elevator algorithm</h3>
            <p>Start from a working template: a normal collective elevator with one extra rule, ready to change.</p>
            <button className="primary" onClick={create}>+ New algorithm</button>
          </div>
        )}
      </div>

      <div className="page-ref">
        <h4>How it works</h4>
        <p className="note">
          The engine handles physics, doors and boarding. It asks your code <code>nextStop(car, world)</code> whenever a car needs a decision. Return a floor number, <code>{'{ floor, direction }'}</code>, or <code>null</code>.
          Riders are never stranded: if you return <code>null</code> with people on board, the car goes to the nearest floor one of them wants.
        </p>
        {EDITOR_REFERENCE.map((g) => (
          <div key={g.title} className="ref-group">
            <h5>{g.title}</h5>
            <dl>
              {g.rows.map(([k, v]) => (
                <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
              ))}
            </dl>
          </div>
        ))}
        <p className="note">A loop that never ends will freeze this tab; reload the page to recover (your last saved code is kept).</p>
      </div>
    </div>
  );
}
