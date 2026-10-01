import { useEffect, useState } from "react";

// HH:MM - minutes are enough for an "as of" stamp, and a seconds counter was
// re-rendering the page every second for no information.
function formatClock(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function useClock() {
  const [time, setTime] = useState(() => formatClock(new Date()));
  useEffect(() => {
    const id = setInterval(() => setTime(formatClock(new Date())), 10000);
    return () => clearInterval(id);
  }, []);
  return time;
}
