import { useSearchParams } from 'react-router-dom';
import { Loading, ErrorNote } from './availabilityUi';
import LeaveTypesSection from './admin/LeaveTypesSection';
import GroupsSection from './admin/GroupsSection';
import RulesSection from './admin/RulesSection';
import OfficesSection from './admin/OfficesSection';
import PeopleSection from './admin/PeopleSection';
import BalancesSection from './admin/BalancesSection';
import ImportSection from './admin/ImportSection';
import GeneralSection from './admin/GeneralSection';

/**
 * Availability → Settings (Availability admins only). A quiet section list on
 * the left (a scrolling row on phones) and one section at a time on the right;
 * the open section lives in ?section= so a refresh stays put.
 */

const SECTIONS = [
  { id: 'types', label: 'Leave types', C: LeaveTypesSection },
  { id: 'groups', label: 'Approval groups', C: GroupsSection },
  { id: 'rules', label: 'Rules', C: RulesSection },
  { id: 'offices', label: 'Offices', C: OfficesSection },
  { id: 'people', label: 'People', C: PeopleSection },
  { id: 'balances', label: 'Balances', C: BalancesSection },
  { id: 'import', label: 'Import', C: ImportSection },
  { id: 'general', label: 'General', C: GeneralSection },
];

export default function AdminSettingsPanel({ config, error, reload, toast }) {
  const [params, setParams] = useSearchParams();
  const active = SECTIONS.find((s) => s.id === params.get('section')) || SECTIONS[0];

  if (error && !config) return <ErrorNote>{error}</ErrorNote>;
  if (!config) return <Loading label="Loading Availability settings…" />;

  const Section = active.C;
  return (
    <div className="grid gap-5 lg:grid-cols-[11rem_minmax(0,1fr)]">
      <nav aria-label="Availability settings" className="-mx-1 overflow-x-auto lg:mx-0 lg:overflow-visible">
        <ul className="flex gap-0.5 px-1 lg:flex-col lg:px-0">
          {SECTIONS.map((s) => {
            const on = s.id === active.id;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  aria-current={on ? 'page' : undefined}
                  onClick={() => setParams((p) => { const n = new URLSearchParams(p); n.set('section', s.id); return n; }, { replace: true })}
                  className={`tp-focus-ring w-full whitespace-nowrap rounded-md px-2.5 py-1.5 text-left text-sm ${on ? 'bg-primary/[0.07] font-medium text-primary dark:bg-primary/15' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                >
                  {s.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-subtle sm:p-5">
        <ErrorNote>{error}</ErrorNote>
        <Section key={active.id} config={config} reload={reload} toast={toast} />
      </div>
    </div>
  );
}
