import { VolumeX } from 'lucide-react';
import { noiseState, skipNoisePatch } from '../../utils/conditionNoise';
import { Switch } from '../ui/switch';

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
      {/* QA 11-05: the app's one switch. */}
      <Switch
        checked={on}
        aria-label="Skip noise tickets"
        onCheckedChange={() => onPatch(skipNoisePatch(data, !on))}
        className="mt-0.5"
      />
    </div>
  );
}
