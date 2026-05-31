import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Badge, Card } from '../ui';

const toneClasses = {
  blue: {
    icon: 'bg-blue-50 text-blue-700 ring-blue-100',
    eyebrow: 'text-blue-700',
    accent: 'from-blue-500 to-cyan-400',
  },
  slate: {
    icon: 'bg-slate-100 text-slate-700 ring-slate-200',
    eyebrow: 'text-slate-600',
    accent: 'from-slate-500 to-slate-300',
  },
  emerald: {
    icon: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
    eyebrow: 'text-emerald-700',
    accent: 'from-emerald-500 to-teal-400',
  },
  amber: {
    icon: 'bg-amber-50 text-amber-700 ring-amber-100',
    eyebrow: 'text-amber-700',
    accent: 'from-amber-500 to-orange-400',
  },
  red: {
    icon: 'bg-red-50 text-red-700 ring-red-100',
    eyebrow: 'text-red-700',
    accent: 'from-red-500 to-rose-400',
  },
  purple: {
    icon: 'bg-violet-50 text-violet-700 ring-violet-100',
    eyebrow: 'text-violet-700',
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
    <section className={cn('tp-glass-strong overflow-hidden rounded-2xl border border-white/70', className)}>
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
            <h2 className="mt-1 text-2xl font-semibold tracking-normal text-slate-950">{title}</h2>
            {description && <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-600">{description}</p>}
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
    <Card className={cn('tp-glass overflow-hidden border-white/70 shadow-soft', className)}>
      {(title || description || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/65 px-5 py-4">
          <div className="flex min-w-0 gap-3">
            {Icon && (
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/80 text-blue-700 ring-1 ring-slate-200/80">
                <Icon className="h-4 w-4" />
              </span>
            )}
            <div className="min-w-0">
              {title && <h3 className="text-base font-semibold text-slate-950">{title}</h3>}
              {description && <p className="mt-1 text-sm leading-5 text-slate-600">{description}</p>}
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
    <div className={cn('tp-glass sticky top-3 z-20 flex flex-wrap items-center justify-end gap-2 rounded-xl border border-white/70 px-3 py-2 shadow-subtle', className)}>
      {children}
    </div>
  );
}

export function StatusBanner({ type = 'info', title, children, className }) {
  const config = {
    info: { Icon: Info, cls: 'border-blue-200 bg-blue-50/85 text-blue-900', badge: 'outline' },
    success: { Icon: CheckCircle2, cls: 'border-emerald-200 bg-emerald-50/85 text-emerald-900', badge: 'success' },
    warning: { Icon: TriangleAlert, cls: 'border-amber-200 bg-amber-50/90 text-amber-950', badge: 'warning' },
    error: { Icon: AlertCircle, cls: 'border-red-200 bg-red-50/90 text-red-950', badge: 'danger' },
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
