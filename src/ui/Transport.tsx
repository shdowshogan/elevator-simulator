import { useMemo } from 'react';
import { demandCurve } from '../sim/traffic';
import { DemandTimeline } from './charts';
import { fmtClock, fmtSec, Seg } from './components';
import { runtime } from './runtime';
import { useStore } from './store';

const SPEEDS = [1, 5, 20, 60, 200, 600];

export function Transport() {
  const playing = useStore((s) => s.playing);
  const speed = useStore((s) => s.speed);
  const showLabels = useStore((s) => s.showLabels);
  const liveTab = useStore((s) => s.liveTab);
  const towers = useStore((s) => s.config);
  const hostel = useStore((s) => s.hostel);
  const config = liveTab === 'hostel' ? hostel : towers;
  const live = useStore((s) => s.live);
  const set = useStore((s) => s.set);
  const restart = useStore((s) => s.restart);
  const sandbox = liveTab === 'sandbox';
  const curve = useMemo(() => demandCurve(config), [config]);
  const clock = live?.clock ?? config.startHour * 3600;
  const day = Math.floor(clock / 86400) + 1;

  return (
    <div className="transport">
      <div className="transport-left">
        <button className="play" onClick={() => set({ playing: !playing })} title={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="ghost big" onClick={restart} title="Restart from the beginning">↺</button>
        <div className="clock">
          {sandbox ? (
            <>
              <b>{fmtSec(live?.time ?? 0)}</b>
              <span>{live?.done ? 'everyone delivered' : `${live?.pending ?? 0} still travelling`}</span>
            </>
          ) : (
            <>
              <b>{fmtClock(clock)}</b>
              <span>Day {day}</span>
            </>
          )}
        </div>
      </div>

      <div className="transport-mid">
        {sandbox ? (
          <p className="note">Sandbox: a hand-built situation with no background traffic. Press play to watch it resolve, or step the speed down to 1× to follow each decision.</p>
        ) : (
          <DemandTimeline curve={curve} clock={clock} />
        )}
      </div>

      <div className="transport-right">
        <div className="field">
          <span>Speed</span>
          <Seg value={speed} onChange={(v) => set({ speed: v })} options={SPEEDS.map((v) => ({ value: v, label: `${v}×` }))} />
        </div>
        <div className="field">
          <span>View</span>
          <div className="seg">
            <button onClick={() => runtime.scene?.focus('overview')}>Overview</button>
            <button onClick={() => runtime.scene?.focus('side')}>Front</button>
            <button onClick={() => runtime.scene?.focus('lobby')}>Lobby</button>
            <button onClick={() => runtime.scene?.focus('top')}>Top</button>
            <button onClick={() => runtime.scene?.focus('plan')} title="Straight down, like a floor plan">Plan</button>
            <button className={showLabels ? 'on' : ''} onClick={() => set({ showLabels: !showLabels })} title="Show or hide the labels above each car">Labels</button>
          </div>
        </div>
      </div>
    </div>
  );
}
