import { byId, el } from './dom.js';

const BARS = 40;
// Without level events (the recorder failed), text arriving still shows the meter is alive.
const LEVEL_TIMEOUT_MS = 2000;

const levels: number[] = new Array<number>(BARS).fill(0);
let lastLevelAt = 0;

function draw(): void {
  const bars = byId('levelMeter').children;
  levels.forEach((level, i) => {
    (bars[i] as HTMLElement).style.transform = `scaleY(${Math.max(0.08, level)})`;
  });
}

function push(level: number): void {
  levels.shift();
  levels.push(level);
  draw();
}

export function initLevelMeter(): void {
  byId('levelMeter').replaceChildren(...levels.map(() => el('span', 'bar')));
  window.api.onSessionLevel((level) => {
    lastLevelAt = Date.now();
    push(level);
  });
  window.api.onSessionSegment(() => {
    if (Date.now() - lastLevelAt < LEVEL_TIMEOUT_MS) return;
    push(0.7);
    setTimeout(() => push(0.25), 150);
  });
}
