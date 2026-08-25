import { periodLabel } from "../lib/format";
import { usePeriod } from "../hooks/usePeriod";
import { useToast } from "../hooks/useToast";

const PERIODS = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
];

export default function PeriodSelector() {
  const { period, setPeriod } = usePeriod();
  const { toast } = useToast();

  return (
    <div className="seg" role="group" aria-label="Reporting period">
      {PERIODS.map((p) => (
        <button
          key={p.days}
          className={period === p.days ? "on" : ""}
          onClick={() => {
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
