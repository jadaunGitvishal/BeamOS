import { useContext } from "react";
import { PeriodContext } from "../context/PeriodContext";

export function usePeriod() {
  const ctx = useContext(PeriodContext);
  if (!ctx) throw new Error("usePeriod must be used within PeriodProvider");
  return ctx;
}
