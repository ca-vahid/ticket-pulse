import { Hand, PenLine, Star } from 'lucide-react';

// Self and Logged share one column (Vahid, 23 Oct 2026): both are tickets the
// technician took themselves, so they sit together, but stay two numbers.
// Purple hand = picked up from the queue; teal pen = wrote it themselves
// (+ New ticket) and took it. With nothing logged the cell is the plain Self
// tile, so the common case stays as quiet as before.

export function selfLoggedTitle(self, logged) {
  const picked = `${self} picked up from the queue`;
  if (!logged) return `Self: ${picked}`;
  return `Self: ${picked}\nLogged: ${logged} they wrote themselves (+ New ticket) and took. These never reached the queue, so they are left out of the AI-assigned gauge.`;
}

/** Teal "+2" with a pen: the logged half of a plain-number cell. */
export function LoggedPlus({ n, className = '' }) {
  if (!n) return null;
  return (
    <span className={`inline-flex items-center gap-0.5 font-semibold text-teal-700 dark:text-teal-300 ${className}`}>
      +<PenLine className="h-3 w-3" aria-hidden="true" />{n}
      <span className="sr-only"> logged</span>
    </span>
  );
}

/** Plain-number style: "5 +✎2". */
export function SelfLoggedPlain({ self, logged, className = 'text-base' }) {
  const any = self > 0 || logged > 0;
  return (
    <span className={`inline-flex items-baseline gap-1 ${className}`} title={selfLoggedTitle(self, logged)}>
      <span className={`font-semibold ${any ? 'text-foreground' : 'text-muted-foreground/50'}`}>{self}</span>
      <LoggedPlus n={logged} className="text-xs" />
    </span>
  );
}

const SIZES = {
  // Compact table cell (44 px tall).
  sm: { box: 'h-11', half: 'min-w-[26px] px-1', icon: 'w-3.5 h-3.5 mb-0.5', num: 'text-base', label: null, fill: 'bg-purple-50 dark:bg-purple-500/15' },
  // Card tile (the card's primary metric, so a stronger purple). Always split:
  // the card grid keeps muted placeholders at 0 so every card lines up.
  lg: { box: '', half: 'min-w-[30px] px-1 py-2', icon: 'w-5 h-5 mb-1', num: 'text-lg', label: 'text-[9px]', fill: 'bg-purple-100 dark:bg-purple-500/20' },
};

/** Icon tile: purple Self, split with a teal Logged half when there are any (always on cards). */
export function SelfLoggedTile({ self, logged, size = 'sm' }) {
  const s = SIZES[size];
  const title = selfLoggedTitle(self, logged);
  const selfHalf = (
    <span className="flex flex-col items-center leading-none">
      <Hand className={`${s.icon} text-purple-600 dark:text-purple-300`} aria-hidden="true" />
      <span className={`${s.num} font-bold text-purple-800 dark:text-purple-200`}>{self}</span>
      {s.label && <span className={`${s.label} mt-1 uppercase font-bold text-purple-700 dark:text-purple-200`}>Self</span>}
    </span>
  );
  if (!logged && size === 'sm') {
    return (
      <div
        className={`flex w-11 h-11 items-center justify-center rounded-md border border-purple-200 dark:border-purple-500/30 ${s.fill}`}
        title={title}
      >
        {selfHalf}
      </div>
    );
  }
  return (
    <div className={`flex ${s.box} ${size === 'lg' ? 'w-full shadow-sm rounded-lg' : ''}`} title={title}>
      <span className={`flex flex-1 items-center justify-center border border-purple-200 dark:border-purple-500/30 ${s.fill} ${size === 'lg' ? 'rounded-l-lg' : 'rounded-l-md'} ${s.half}`}>
        {selfHalf}
      </span>
      <span className={`-ml-px flex flex-1 items-center justify-center border ${logged ? 'border-teal-200 bg-teal-50 dark:border-teal-500/30 dark:bg-teal-500/15' : 'border-border/60 bg-muted/25'} ${size === 'lg' ? 'rounded-r-lg' : 'rounded-r-md'} ${s.half}`}>
        <span className={`flex flex-col items-center leading-none ${logged ? '' : 'opacity-50'}`}>
          <PenLine className={`${s.icon} ${logged ? 'text-teal-600 dark:text-teal-300' : 'text-muted-foreground/50'}`} aria-hidden="true" />
          <span className={`${s.num} font-bold ${logged ? 'text-teal-800 dark:text-teal-200' : 'text-muted-foreground/50'}`}>{logged}</span>
          {s.label && <span className={`${s.label} mt-1 uppercase font-bold ${logged ? 'text-teal-700 dark:text-teal-300' : 'text-muted-foreground/50'}`}>Log</span>}
        </span>
      </span>
    </div>
  );
}

/** Row badge: "Logged" (pen, teal) or "Self" (star, purple). */
export function TakenBadge({ kind, size = 'xs' }) {
  const text = size === 'sm' ? 'text-[10px] px-1.5' : 'text-[9px] px-1';
  const icon = size === 'sm' ? 'w-2.5 h-2.5' : 'w-2 h-2';
  if (kind === 'logged') {
    return (
      <span
        className={`bg-teal-50 dark:bg-teal-500/15 text-teal-700 dark:text-teal-300 py-0.5 rounded flex-shrink-0 flex items-center gap-0.5 ${text}`}
        title="Logged: they wrote this ticket themselves (+ New ticket) and took it, so it never reached the queue"
      >
        <PenLine className={icon} aria-hidden="true" />
        Logged
      </span>
    );
  }
  if (kind === 'self') {
    return (
      <span className={`bg-purple-50 dark:bg-purple-500/15 text-purple-600 dark:text-purple-300 py-0.5 rounded flex-shrink-0 flex items-center gap-0.5 ${text}`} title="Self: picked up from the queue">
        <Star className={`${icon} fill-purple-600`} aria-hidden="true" />
        Self
      </span>
    );
  }
  return null;
}
