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

export function formatElapsedSec(sec: number): string {
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
