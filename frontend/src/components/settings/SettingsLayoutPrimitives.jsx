import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Badge, Card } from '../ui';

const toneClasses = {
  blue: {
    icon: 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 ring-blue-100 dark:ring-blue-500/30',
    eyebrow: 'text-blue-700 dark:text-blue-200',
    accent: 'from-blue-500 to-cyan-400',
  },
  slate: {
    icon: 'bg-muted text-foreground/85 ring-border',
    eyebrow: 'text-muted-foreground',
    accent: 'from-muted-foreground to-muted-foreground/40',
  },
  emerald: {
    icon: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 ring-emerald-100 dark:ring-emerald-500/30',
    eyebrow: 'text-emerald-700 dark:text-emerald-200',
    accent: 'from-emerald-500 to-teal-400',
  },
  amber: {
    icon: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 ring-amber-100 dark:ring-amber-500/30',
    eyebrow: 'text-amber-700 dark:text-amber-200',
    accent: 'from-amber-500 to-orange-400',
  },
  red: {
    icon: 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 ring-red-100 dark:ring-red-500/30',
    eyebrow: 'text-red-700 dark:text-red-200',
    accent: 'from-red-500 to-rose-400',
  },
  purple: {
    icon: 'bg-violet-50 dark:bg-violet-500/15 text-violet-700 dark:text-violet-200 ring-violet-100 dark:ring-violet-500/30',
    eyebrow: 'text-violet-700 dark:text-violet-200',
    accent: 'from-violet-500 to-fuchsia-400',
  },
};

export function SettingsHero({
  eyebrow,
  title,
  description,
  icon: Icon,
  tone = 'blue',
  actions,
  meta,
  className,
}) {
  const styles = toneClasses[tone] || toneClasses.blue;
  return (
    <section className={cn('tp-glass-strong overflow-hidden rounded-2xl border border-card/70 dark:border-white/10', className)}>
      <div className={cn('h-1.5 bg-gradient-to-r', styles.accent)} />
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-5 sm:px-6">
        <div className="flex min-w-0 gap-4">
          {Icon && (
            <span className={cn('mt-0.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1', styles.icon)}>
              <Icon className="h-5 w-5" />
            </span>
          )}
          <div className="min-w-0">
            {eyebrow && (
              <div className={cn('text-xs font-bold uppercase tracking-wide', styles.eyebrow)}>
                {eyebrow}
              </div>
            )}
            <h2 className="mt-1 text-2xl font-semibold tracking-normal text-foreground">{title}</h2>
            {description && <p className="mt-2 max-w-4xl text-sm leading-6 text-muted-foreground">{description}</p>}
            {meta && <div className="mt-3 flex flex-wrap gap-2">{meta}</div>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </section>
  );
}

export function SettingsSection({
  title,
  description,
  icon: Icon,
  actions,
  children,
  className,
  contentClassName,
}) {
  return (
    <Card className={cn('tp-glass overflow-hidden border-card/70 dark:border-white/10 shadow-soft', className)}>
      {(title || description || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-card/65 dark:border-white/[0.08] px-5 py-4">
          <div className="flex min-w-0 gap-3">
            {Icon && (
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-card/80 text-blue-700 dark:text-blue-200 ring-1 ring-border/80">
                <Icon className="h-4 w-4" />
              </span>
            )}
            <div className="min-w-0">
              {title && <h3 className="text-base font-semibold text-foreground">{title}</h3>}
              {description && <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn('p-5', contentClassName)}>{children}</div>
    </Card>
  );
}

export function SettingsActionBar({ children, className }) {
  return (
    <div className={cn('tp-glass sticky top-3 z-20 flex flex-wrap items-center justify-end gap-2 rounded-xl border border-card/70 dark:border-white/10 px-3 py-2 shadow-subtle', className)}>
      {children}
    </div>
  );
}

export function StatusBanner({ type = 'info', title, children, className }) {
  const config = {
    info: { Icon: Info, cls: 'border-blue-200 dark:border-blue-500/30 bg-blue-50/85 dark:bg-blue-500/10 text-blue-900 dark:text-blue-200', badge: 'outline' },
    success: { Icon: CheckCircle2, cls: 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/85 dark:bg-emerald-500/10 text-emerald-900 dark:text-emerald-200', badge: 'success' },
    warning: { Icon: TriangleAlert, cls: 'border-amber-200 dark:border-amber-500/30 bg-amber-50/90 dark:bg-amber-500/10 text-amber-950 dark:text-amber-200', badge: 'warning' },
    error: { Icon: AlertCircle, cls: 'border-red-200 dark:border-red-500/30 bg-red-50/90 dark:bg-red-500/10 text-red-950 dark:text-red-200', badge: 'danger' },
  }[type] || {};
  const Icon = config.Icon || Info;
  return (
    <div className={cn('flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-subtle', config.cls, className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        {title && <div className="font-semibold">{title}</div>}
        <div className={cn(title && 'mt-1')}>{children}</div>
      </div>
    </div>
  );
}

export function SettingsChip({ children, variant = 'glass', className }) {
  return (
    <Badge variant={variant} className={cn('gap-1.5 px-3 py-1', className)}>
      {children}
    </Badge>
  );
}
