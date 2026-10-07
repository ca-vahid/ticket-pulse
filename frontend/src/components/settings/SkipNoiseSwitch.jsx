import { VolumeX } from 'lucide-react';
import { noiseState, skipNoisePatch } from '../../utils/conditionNoise';

/** The condition step's "Skip noise tickets" switch (QA 10-06 #2) — see utils/conditionNoise.js. */
export default function SkipNoiseSwitch({ data, onPatch }) {
  const { on } = noiseState(data);
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5" data-testid="skip-noise-switch">
      <VolumeX className={`mt-0.5 h-4 w-4 flex-shrink-0 ${on ? 'text-primary' : 'text-muted-foreground/60'}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">Skip noise tickets</div>
        <p className="text-xs text-muted-foreground">
          {on
            ? 'Tickets marked as noise or spam stop here and take the False path. Checked before the conditions below.'
            : 'Noise and spam tickets are not stopped here — only the conditions below decide.'}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Skip noise tickets"
        onClick={() => onPatch(skipNoisePatch(data, !on))}
        className={`tp-focus-ring relative mt-0.5 inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${on ? 'bg-primary' : 'bg-muted-foreground/40'}`}
      >
        <span className={`inline-block h-4 w-4 rounded-full bg-card shadow transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );
}
