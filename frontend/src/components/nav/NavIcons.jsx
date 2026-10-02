// Primary navigation icons (2 Oct 2026, the product owner's new set, chosen as
// "option I": 24 px in the rail, 16 px between rows). Each icon is a PNG
// silhouette in /brand/nav/<id>.png used as a CSS mask filled with
// `currentColor`, so — like the lucide icons they replaced — the tile's text
// colour drives the hue: slate at rest, the page accent when active, and dark
// mode for free. Swapping an icon = replacing its PNG (transparent background,
// artwork trimmed to ~92% of a square; 144 px is plenty for every size used).

function maskIcon(id, label) {
  function NavMaskIcon({ className = 'h-6 w-6' }) {
    const url = `url(/brand/nav/${id}.png)`;
    return (
      <span
        aria-hidden="true"
        data-nav-icon={id}
        className={`inline-block flex-none ${className}`}
        style={{
          backgroundColor: 'currentColor',
          WebkitMaskImage: url,
          maskImage: url,
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
        }}
      />
    );
  }
  NavMaskIcon.displayName = `${label}NavIcon`;
  return NavMaskIcon;
}

export const DashboardNavIcon = maskIcon('dashboard', 'Dashboard');
export const TicketsNavIcon = maskIcon('tickets', 'Tickets');
export const TimelineNavIcon = maskIcon('timeline', 'Timeline');
export const AnalyticsNavIcon = maskIcon('analytics', 'Analytics');
export const KnowledgeNavIcon = maskIcon('knowledge', 'Knowledge');
export const OnboardingNavIcon = maskIcon('onboarding', 'Comings & Goings');
export const AssignmentNavIcon = maskIcon('assignments', 'Assignment');
export const WorkflowNavIcon = maskIcon('workflows', 'Workflow');
export const MapNavIcon = maskIcon('map', 'Map');
export const ApprovalsNavIcon = maskIcon('approvals', 'Approvals');
