import { useEffect, useState } from "react";

function formatClock(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function useClock() {
  const [time, setTime] = useState(() => formatClock(new Date()));
  useEffect(() => {
    const id = setInterval(() => setTime(formatClock(new Date())), 1000);
    return () => clearInterval(id);
  }, []);
  return time;
}
