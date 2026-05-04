import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2, Clock3, LogOut, Search, ShieldCheck, UserRound,
  XCircle, Loader2, AlertCircle, BriefcaseBusiness,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { agentAPI } from '../services/api';

const LEVELS = [
  { value: '', label: 'No experience', short: '-', rank: 0, className: 'bg-slate-100 text-slate-400 border-slate-200' },
  { value: 'basic', label: 'Basic', short: '1', rank: 1, className: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
  { value: 'intermediate', label: 'Comfortable', short: '2', rank: 2, className: 'bg-blue-100 text-blue-800 border-blue-200' },
  { value: 'advanced', label: 'Advanced', short: '3', rank: 3, className: 'bg-indigo-100 text-indigo-800 border-indigo-200' },
  { value: 'expert', label: 'Expert / SME', short: '4', rank: 4, className: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
];

const levelByValue = Object.fromEntries(LEVELS.map((level) => [level.value, level]));

function initials(name) {
  return String(name || 'U').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'U';
}

function flattenCategories(tree, fallbackCategories) {
  if (tree?.length) {
    return tree.flatMap((category) => [
      { ...category, depth: 0 },
      ...(category.subcategories || []).map((subcategory) => ({
        ...subcategory,
        depth: 1,
        parentName: category.name,
      })),
    ]);
  }
  return (fallbackCategories || []).map((category) => ({ ...category, depth: category.parentId ? 1 : 0 }));
}

function formatRequest(request) {
  const requested = levelByValue[request.requestedLevel || '']?.label || 'No experience';
  const current = levelByValue[request.currentLevel || '']?.label || 'No experience';
  if (request.status === 'auto_applied') return `${current} to ${requested} auto-applied`;
  return `${current} to ${requested}`;
}

export default function MyCompetencies() {
  const { user, logout } = useAuth();
  const [data, setData] = useState(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingCell, setSavingCell] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const fetchData = async (targetWorkspaceId = workspaceId) => {
    try {
      setLoading(true);
      setError(null);
      const res = await agentAPI.getMyCompetencies(targetWorkspaceId ? { workspaceId: targetWorkspaceId } : {});
      setData(res.data);
      setWorkspaceId(String(res.data?.technician?.workspaceId || ''));
    } catch (err) {
      setError(err.message || 'Could not load your competency profile');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mappingMap = useMemo(() => {
    const map = {};
    for (const mapping of data?.mappings || []) {
      if (!map[mapping.technicianId]) map[mapping.technicianId] = {};
      map[mapping.technicianId][mapping.competencyCategoryId] = mapping.proficiencyLevel;
    }
    return map;
  }, [data?.mappings]);

  const pendingByCategory = useMemo(() => {
    const map = {};
    for (const request of data?.requests || []) {
      if (request.status === 'pending') map[request.competencyCategoryId] = request;
    }
    return map;
  }, [data?.requests]);

  const categories = useMemo(() => {
    const rows = flattenCategories(data?.categoryTree, data?.categories);
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((category) => (
      category.name.toLowerCase().includes(needle)
      || String(category.parentName || '').toLowerCase().includes(needle)
      || String(category.description || '').toLowerCase().includes(needle)
    ));
  }, [data?.categories, data?.categoryTree, query]);

  const myTechId = data?.technician?.id;
  const myMappedCount = Object.keys(mappingMap[myTechId] || {}).length;
  const pendingCount = (data?.requests || []).filter((request) => request.status === 'pending').length;

  const handleChange = async (category, nextLevel) => {
    const currentLevel = mappingMap[myTechId]?.[category.id] || '';
    if (nextLevel === currentLevel) return;
    if (!currentLevel && nextLevel && !category.parentId) {
      setMessage({ type: 'warning', text: 'New skills must be requested from an existing subcategory.' });
      return;
    }

    setSavingCell(category.id);
    setMessage(null);
    try {
      const res = await agentAPI.submitCompetencyChange({
        workspaceId: data.technician.workspaceId,
        competencyCategoryId: category.id,
        requestedLevel: nextLevel || null,
        note,
      });
      setData(res.data);
      setMessage({
        type: res.autoApplied ? 'success' : 'info',
        text: res.autoApplied ? 'Change saved immediately.' : 'Request submitted for admin approval.',
      });
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Change could not be submitted.' });
    } finally {
      setSavingCell(null);
    }
  };

  const handleLogout = async () => {
    await logout();
  };

  return (
    <div className="min-h-screen bg-slate-100 bg-[url('/brand/dashboard-background.webp')] bg-cover bg-fixed">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 shadow-sm backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-2">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/brand/logo-wordmark.png" alt="Ticket Pulse" className="h-14 w-auto" />
            <div className="hidden h-8 w-px bg-slate-200 sm:block" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-900">My Competencies</div>
              <div className="truncate text-xs text-slate-500">Review the matrix and request updates to your own skills.</div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-4">
        {loading && (
          <div className="flex min-h-[50vh] items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
          </div>
        )}

        {!loading && error && (
          <div className="mx-auto max-w-xl rounded-xl border border-amber-200 bg-white p-6 text-center shadow-sm">
            <AlertCircle className="mx-auto mb-3 h-10 w-10 text-amber-500" />
            <h1 className="text-lg font-semibold text-slate-900">Technician profile not linked</h1>
            <p className="mt-2 text-sm text-slate-600">{error}</p>
            <p className="mt-3 text-xs text-slate-500">Signed in as {user?.email}. Ask an admin to confirm your SSO email matches your Ticket Pulse technician record.</p>
          </div>
        )}

        {!loading && data && (
          <div className="space-y-4">
            <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    {data.technician.photoUrl ? (
                      <img src={data.technician.photoUrl} alt="" className="h-14 w-14 rounded-full object-cover ring-2 ring-blue-100" />
                    ) : (
                      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-100 text-lg font-bold text-blue-700">
                        {initials(data.technician.name)}
                      </span>
                    )}
                    <div>
                      <h1 className="text-xl font-semibold text-slate-950">{data.technician.name}</h1>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                        <span className="flex items-center gap-1"><UserRound className="h-3.5 w-3.5" />{data.technician.email}</span>
                        <span className="flex items-center gap-1"><BriefcaseBusiness className="h-3.5 w-3.5" />{data.technician.workspace?.name}</span>
                      </div>
                    </div>
                  </div>
                  {data.profiles.length > 1 && (
                    <select
                      value={workspaceId}
                      onChange={(event) => fetchData(event.target.value)}
                      className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700 outline-none focus:border-blue-300 focus:bg-white"
                    >
                      {data.profiles.map((profile) => (
                        <option key={profile.workspaceId} value={profile.workspaceId}>{profile.workspace.name}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                  <div className="text-xs font-semibold uppercase text-slate-500">My skills</div>
                  <div className="mt-2 text-2xl font-bold text-slate-950">{myMappedCount}</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                  <div className="text-xs font-semibold uppercase text-slate-500">Pending</div>
                  <div className="mt-2 text-2xl font-bold text-amber-600">{pendingCount}</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                  <div className="text-xs font-semibold uppercase text-slate-500">Team</div>
                  <div className="mt-2 text-2xl font-bold text-slate-950">{data.technicians.length}</div>
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="relative min-w-0 flex-1">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search categories and subcategories"
                    className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none transition focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  {LEVELS.map((level) => (
                    <span key={level.value || 'none'} className={`rounded-md border px-2 py-1 font-semibold ${level.className}`}>
                      {level.short} {level.label}
                    </span>
                  ))}
                </div>
              </div>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Optional note for your next request"
                className="mt-3 min-h-[48px] w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none transition focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100"
              />
              {message && (
                <div className={`mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                  message.type === 'error' ? 'bg-red-50 text-red-700'
                    : message.type === 'warning' ? 'bg-amber-50 text-amber-700'
                      : message.type === 'success' ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-blue-50 text-blue-700'
                }`}>
                  {message.type === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <Clock3 className="h-4 w-4" />}
                  {message.text}
                </div>
              )}
            </section>

            <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="sticky left-0 z-20 min-w-[240px] bg-slate-50 px-3 py-3 text-left text-xs font-semibold uppercase text-slate-500">Category / subcategory</th>
                      {data.technicians.map((tech) => {
                        const isMe = tech.id === myTechId;
                        return (
                          <th key={tech.id} className={`min-w-[74px] px-2 py-2 text-center ${isMe ? 'bg-blue-50' : ''}`}>
                            <div className="flex flex-col items-center gap-1">
                              {tech.photoUrl ? (
                                <img src={tech.photoUrl} alt="" className={`h-8 w-8 rounded-full object-cover ${isMe ? 'ring-2 ring-blue-500' : ''}`} />
                              ) : (
                                <span className={`flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-bold ${isMe ? 'bg-blue-600 text-white ring-2 ring-blue-200' : 'bg-slate-200 text-slate-500'}`}>
                                  {initials(tech.name)}
                                </span>
                              )}
                              <span className={`max-w-[64px] truncate text-[10px] font-semibold ${isMe ? 'text-blue-700' : 'text-slate-500'}`}>
                                {isMe ? 'You' : tech.name.split(' ')[0]}
                              </span>
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {categories.map((category) => {
                      const pending = pendingByCategory[category.id];
                      return (
                        <tr key={category.id} className={`border-t border-slate-100 ${category.depth === 0 ? 'bg-slate-50/70' : 'hover:bg-slate-50'}`}>
                          <td className={`sticky left-0 z-10 px-3 py-2 ${category.depth === 0 ? 'bg-slate-50 font-semibold text-slate-800' : 'bg-white text-slate-700'}`}>
                            <div className="flex items-center gap-2">
                              {category.depth === 1 && <span className="ml-3 h-px w-4 bg-slate-300" />}
                              <span>{category.name}</span>
                              {category.depth === 1 && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">sub</span>}
                              {pending && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">pending</span>}
                            </div>
                          </td>
                          {data.technicians.map((tech) => {
                            const isMe = tech.id === myTechId;
                            const level = mappingMap[tech.id]?.[category.id] || '';
                            const levelInfo = levelByValue[level] || levelByValue[''];
                            return (
                              <td key={tech.id} className={`px-1 py-1 text-center ${isMe ? 'bg-blue-50/50' : ''}`}>
                                {isMe ? (
                                  <select
                                    value={pending?.requestedLevel ?? level}
                                    disabled={savingCell === category.id}
                                    onChange={(event) => handleChange(category, event.target.value)}
                                    className={`h-8 w-16 rounded-lg border text-center text-xs font-bold outline-none transition hover:shadow-sm focus:ring-2 focus:ring-blue-100 ${pending ? 'border-amber-300 bg-amber-50 text-amber-800' : levelInfo.className}`}
                                    title={pending ? `Pending: ${formatRequest(pending)}` : `${category.name}: ${levelInfo.label}`}
                                  >
                                    {LEVELS.map((option) => (
                                      <option key={option.value || 'none'} value={option.value}>{option.short}</option>
                                    ))}
                                  </select>
                                ) : (
                                  <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border text-xs font-bold ${levelInfo.className}`}>
                                    {levelInfo.short}
                                  </span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                    {categories.length === 0 && (
                      <tr>
                        <td colSpan={(data.technicians?.length || 0) + 1} className="px-4 py-10 text-center text-sm text-slate-400">
                          No matching categories.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Clock3 className="h-4 w-4 text-amber-500" /> Pending Requests</h2>
                <div className="mt-3 space-y-2">
                  {(data.requests || []).filter((request) => request.status === 'pending').map((request) => (
                    <div key={request.id} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
                      <div className="font-semibold text-slate-900">{request.competencyCategory?.name}</div>
                      <div className="text-xs text-amber-800">{formatRequest(request)}</div>
                    </div>
                  ))}
                  {pendingCount === 0 && <p className="text-sm text-slate-500">No pending changes.</p>}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><ShieldCheck className="h-4 w-4 text-emerald-600" /> Recent History</h2>
                <div className="mt-3 space-y-2">
                  {(data.requests || []).filter((request) => request.status !== 'pending').slice(0, 8).map((request) => (
                    <div key={request.id} className="flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                      {request.status === 'rejected' ? <XCircle className="mt-0.5 h-4 w-4 text-red-500" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" />}
                      <div>
                        <div className="font-semibold text-slate-900">{request.competencyCategory?.name}</div>
                        <div className="text-xs text-slate-500">{request.status.replace('_', ' ')} - {formatRequest(request)}</div>
                      </div>
                    </div>
                  ))}
                  {!(data.requests || []).some((request) => request.status !== 'pending') && <p className="text-sm text-slate-500">No history yet.</p>}
                </div>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
