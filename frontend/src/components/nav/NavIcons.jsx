// Inline line-art glyphs for the primary navigation tiles. Each draws with
// `currentColor` so the tile's text color drives the icon hue — identical to the
// lucide nav icons — which lets one set of accent/active classes style them.
// Artwork supplied by the product owner (Voted-icons.docx).

const BASE = 'h-[22px] w-[22px]';

// Assignment — a person with an approval check.
export function AssignmentNavIcon({ className = BASE }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="10.5" cy="9" r="3.2" />
      <path d="M4 20a6.5 6.5 0 0 1 13 0" />
      <path d="M15.6 6.1l1.6 1.6 3.2-3.4" />
    </svg>
  );
}

// Workflow — an email envelope fanning out to multiple recipients.
export function WorkflowNavIcon({ className = BASE }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5.5" y="3.5" width="13" height="9" rx="2" />
      <path d="M6.3 4.8l5.7 4 5.7-4" />
      <path d="M12 12.5v3.5" />
      <path d="M4 18.2Q4 16 12 16 20 16 20 18.2" />
      <path d="M4 18.2V19.6" />
      <path d="M12 16V19.6" />
      <path d="M20 18.2V19.6" />
      <circle cx="4" cy="20.1" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="20.1" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="20" cy="20.1" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Map — a globe (location / agent map).
export function MapNavIcon({ className = BASE }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a13.5 13.5 0 0 1 0 18 13.5 13.5 0 0 1 0-18z" />
    </svg>
  );
}

// Knowledge — an open book with the Ticket Pulse heartbeat across its pages
// (v4.0.01, 27 Sep 2026: the pulse becomes knowledge).
export function KnowledgeNavIcon({ className = BASE }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 7.2C10.2 5.7 7.6 5 4.5 5.2v12.3c3.1-.2 5.7.5 7.5 2" />
      <path d="M12 7.2c1.8-1.5 4.4-2.2 7.5-2v12.3c-3.1-.2-5.7.5-7.5 2" />
      <path d="M12 7.2v12.3" />
      <path d="M2.5 12.2h3.4l1.2-2.2 1.6 4.4 1.2-2.2H12" />
    </svg>
  );
}
