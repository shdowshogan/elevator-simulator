import { useEffect, useRef, useState } from 'react';
import { CompareTab } from './CompareTab';
import { ConfigPanel } from './ConfigPanel';
import { EditorTab } from './EditorTab';
import { startRuntime } from './runtime';
import { SandboxPanel } from './SandboxPanel';
import { StatsPanel } from './StatsPanel';
import { useStore, type Tab } from './store';
import { Transport } from './Transport';

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'simulate', label: 'Simulate', hint: 'A full day of traffic in your buildings' },
  { id: 'sandbox', label: 'Sandbox', hint: 'Hand-build one exact situation' },
  { id: 'compare', label: 'Compare', hint: 'Benchmark algorithms and setups side by side' },
  { id: 'editor', label: 'Algorithm editor', hint: 'Write your own algorithm' },
];

export function App() {
  const viewport = useRef<HTMLDivElement>(null);
  const tab = useStore((s) => s.tab);
  const set = useStore((s) => s.set);
  const [left, setLeft] = useState(true);
  const [right, setRight] = useState(true);
  const [webglError, setWebglError] = useState<string | null>(null);

  useEffect(() => {
    try {
      return startRuntime(viewport.current!);
    } catch (e) {
      setWebglError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, .cm-editor')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        set({ playing: !useStore.getState().playing });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [set]);

  const live = tab === 'simulate' || tab === 'sandbox';

  return (
    <div className={`app ${live ? '' : 'dimmed'}`}>
      <div className="viewport" ref={viewport} />
      {webglError && <div className="fatal">The 3D view could not start: {webglError}. Check that WebGL is enabled in this browser.</div>}

      <header className="topbar">
        <div className="brand">
          <span className="logo">▲▼</span>
          <b>Elevator Lab</b>
        </div>
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={t.id === tab ? 'on' : ''} title={t.hint} onClick={() => set({ tab: t.id })}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          {live && (
            <>
              <button className={`ghost ${left ? 'on' : ''}`} title="Show or hide the settings" onClick={() => setLeft(!left)}>◧ Settings</button>
              <button className={`ghost ${right ? 'on' : ''}`} title="Show or hide the results" onClick={() => setRight(!right)}>Results ◨</button>
            </>
          )}
        </div>
      </header>

      {live && left && <aside className="panel left">{tab === 'sandbox' ? <SandboxPanel /> : <ConfigPanel />}</aside>}
      {live && right && <aside className="panel right"><StatsPanel /></aside>}
      {live && <Transport />}
      {tab === 'compare' && <div className="overlay"><CompareTab /></div>}
      {tab === 'editor' && <div className="overlay"><EditorTab /></div>}
    </div>
  );
}
