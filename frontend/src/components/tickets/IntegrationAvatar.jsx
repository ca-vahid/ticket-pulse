
/**
 * Round avatar for an integration voice (Simorgh phoenix, Rostam). The
 * Simorgh mark has a light and a dark rendering — the app's own header uses
 * the blue/gold phoenix on both grounds — so the light one shows by default
 * and the dark one takes over under `.dark`.
 */
export function IntegrationAvatar({ identity, size = 'h-10 w-10', className = '' }) {
  if (!identity) return null;
  const rostam = identity.key === 'rostam';
  const ring = rostam
    ? 'bg-slate-900 ring-teal-400/60'
    : 'bg-sky-50 dark:bg-slate-900 ring-sky-200/80 dark:ring-sky-500/40';
  return (
    <span
      className={`${size} rounded-full flex items-center justify-center shadow-subtle overflow-hidden ring-1 flex-shrink-0 ${ring} ${className}`}
      title={`${identity.name} — ${identity.subtitle}`}
    >
      {rostam ? (
        <img src={identity.avatarUrl} alt={identity.name} className="h-full w-full object-cover" />
      ) : (
        <>
          <img src={identity.avatarUrl} alt={identity.name} className="h-full w-full object-contain p-1 dark:hidden" />
          <img src={identity.avatarDarkUrl || identity.avatarUrl} alt="" aria-hidden="true" className="h-full w-full object-contain p-0.5 hidden dark:block" />
        </>
      )}
    </span>
  );
}

export default IntegrationAvatar;
