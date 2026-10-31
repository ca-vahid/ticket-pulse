// Noise and repeats as two separate counts under the Demand & Flow chart (Vahid, 31 Oct 2026).
// A repeat is the same alert or request arriving again, folded into the first ticket; noise is
// junk. Each ticket counts once, and both shares are of the tickets created in range.
const fmt = (n) => Number(n || 0).toLocaleString();

export default function NoiseRepeatsLine({ breakdowns, excludeNoise = false }) {
  if (!breakdowns) return null;
  if (excludeNoise) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        Noise and repeats are left out (Exclude noise is on).
      </p>
    );
  }
  const noise = breakdowns.noiseShare || { count: 0, pct: 0 };
  const repeats = breakdowns.repeatShare || { count: 0, pct: 0 };
  const created = breakdowns.createdInRange;
  const base = Number.isFinite(created) ? `of ${fmt(created)} created in range` : 'of tickets created in range';
  return (
    <p className="mt-2 text-xs tabular-nums text-muted-foreground" data-testid="noise-repeats-line">
      <span title={`Noise: junk and auto-mail, ${base}`}>
        Noise {fmt(noise.count)} ({noise.pct}%)
      </span>
      <span aria-hidden="true"> · </span>
      <span title={`Repeats: the same alert or request again, grouped into the first ticket, ${base}`}>
        Repeats {fmt(repeats.count)} ({repeats.pct}%)
      </span>
      {Number.isFinite(created) && <span className="text-muted-foreground/75"> · {base}</span>}
    </p>
  );
}
