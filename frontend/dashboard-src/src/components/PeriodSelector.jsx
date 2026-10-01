import { periodLabel } from "../lib/format";
import { usePeriod } from "../hooks/usePeriod";
import { useToast } from "../hooks/useToast";

const PERIODS = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  // Placeholder for custom date ranges: shown to match the demo, but inert -
  // PeriodContext is day-count-only for now.
  { days: null, label: "Custom", disabled: true },
];

export default function PeriodSelector() {
  const { period, setPeriod } = usePeriod();
  const { toast } = useToast();

  return (
    <div className="seg" role="group" aria-label="Reporting period">
      {PERIODS.map((p) => (
        <button
          key={p.label}
          className={period === p.days ? "on" : ""}
          disabled={p.disabled}
          title={p.disabled ? "Custom periods are coming soon" : undefined}
          onClick={() => {
            if (p.disabled) return;
            setPeriod(p.days);
            toast(`Showing the ${periodLabel(p.days)}`);
          }}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
