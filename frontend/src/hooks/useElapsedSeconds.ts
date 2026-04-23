import { useEffect, useState } from "react";

/** Секунды от начала активного ожидания ответа (счётчик у кнопок). */
export function useElapsedSeconds(active: boolean): number {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!active) {
      setSec(0);
      return;
    }
    const t0 = performance.now();
    setSec(0);
    const id = window.setInterval(() => {
      setSec(Math.floor((performance.now() - t0) / 1000));
    }, 250);
    return () => window.clearInterval(id);
  }, [active]);
  return sec;
}

/**
 * Как useElapsedSeconds, но если задан anchorStartMs (unix ms с сервера), таймер идёт от него —
 * нужно после F5 для длительных задач few-shot.
 */
export function useElapsedSecondsAnchored(active: boolean, anchorStartMs: number | null): number {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!active) {
      setSec(0);
      return;
    }
    const base =
      anchorStartMs != null && Number.isFinite(anchorStartMs) ? anchorStartMs : performance.now();
    const tick = () => setSec(Math.max(0, Math.floor((Date.now() - base) / 1000)));
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [active, anchorStartMs]);
  return sec;
}

export function formatElapsedSec(sec: number): string {
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
