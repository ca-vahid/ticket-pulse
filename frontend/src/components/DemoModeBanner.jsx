import { Camera } from 'lucide-react';
import { useDemoMode } from '../utils/demoMode';

/**
 * DemoModeBanner — fixed bottom-right pill shown on every page while demo
 * mode is active. Acts as a constant visual reminder so the user never
 * accidentally records real data thinking demo was on.
 */
export default function DemoModeBanner() {
  const enabled = useDemoMode();
  if (!enabled) return null;
  return (
    <div
      className="fixed bottom-3 right-3 z-[9999] pointer-events-none select-none"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/95 text-white text-xs font-semibold shadow-lg ring-1 ring-amber-600">
        <Camera className="w-3.5 h-3.5" />
        DEMO MODE - identities anonymized
      </div>
    </div>
  );
}
