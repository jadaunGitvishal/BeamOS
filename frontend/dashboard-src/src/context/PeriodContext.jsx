import { createContext, useCallback, useState } from "react";
import { store } from "../lib/store";

export const PeriodContext = createContext(null);

export function PeriodProvider({ children }) {
  const [period, setPeriodState] = useState(() => Number(store.get("beamos.period")) || 7);

  const setPeriod = useCallback((p) => {
    setPeriodState(p);
    store.set("beamos.period", String(p));
  }, []);

  return <PeriodContext.Provider value={{ period, setPeriod }}>{children}</PeriodContext.Provider>;
}
