import { useState, useEffect, useCallback } from 'react';
import { settingsAPI } from '../../services/api';
import { Users, Loader, Eye, EyeOff, AlertTriangle } from 'lucide-react';

export default function TechnicianVisibilityPanel() {
  const [technicians, setTechnicians] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toggling, setToggling] = useState(null);

  const fetchTechnicians = useCallback(async () => {
    setError(null);
    try {
      const res = await settingsAPI.getTechnicians();
      setTechnicians(res?.data || []);
    } catch (err) {
      const msg = err.status === 401 || err.status === 403
        ? 'Admin access required to manage technician visibility.'
        : `Failed to load technicians: ${err.message || 'Unknown error'}`;
      setError(msg);
      console.error('TechnicianVisibilityPanel fetch error:', err);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchTechnicians(); }, [fetchTechnicians]);

  const handleToggle = async (id, currentActive) => {
    const newActive = !currentActive;
    setToggling(id);
    try {
      await settingsAPI.setTechnicianActive(id, newActive);
      setTechnicians(prev => prev.map(t => t.id === id ? { ...t, isActive: newActive } : t));
    } catch (err) {
      alert(`Failed to update technician: ${err.message || 'Unknown error'}`);
    }
    setToggling(null);
  };

  const activeCount = technicians.filter(t => t.isActive).length;
  const inactiveCount = technicians.length - activeCount;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 bg-blue-100 rounded-lg">
          <Users className="w-5 h-5 text-blue-600" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Technician Visibility</h3>
          <p className="text-sm text-gray-500">
            Disable technicians to permanently hide them from the dashboard. Disabled technicians won&apos;t appear in any view.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <Eye className="w-3 h-3 text-emerald-500" /> {activeCount} active
          </span>
          <span className="flex items-center gap-1">
            <EyeOff className="w-3 h-3 text-gray-400" /> {inactiveCount} disabled
          </span>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
          <button onClick={fetchTechnicians} className="ml-auto text-xs font-medium underline hover:no-underline">Retry</button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : !error && (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-2.5 font-medium text-gray-600">Technician</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-600">Email</th>
                <th className="text-center px-4 py-2.5 font-medium text-gray-600">Status</th>
                <th className="text-center px-4 py-2.5 font-medium text-gray-600 w-20">Toggle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {technicians
                .sort((a, b) => {
                  if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
                  return a.name.localeCompare(b.name);
                })
                .map((tech) => (
                  <tr key={tech.id} className={`${tech.isActive ? 'hover:bg-gray-50/50' : 'bg-gray-50/80 opacity-60'}`}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        {tech.photoUrl ? (
                          <img src={tech.photoUrl} alt={tech.name} className="w-7 h-7 rounded-full object-cover border border-gray-200" />
                        ) : (
                          <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center text-xs font-bold text-gray-600">
                            {tech.name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()}
                          </div>
                        )}
                        <span className={`font-medium ${tech.isActive ? 'text-gray-900' : 'text-gray-400 line-through'}`}>
                          {tech.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{tech.email || '--'}</td>
                    <td className="px-4 py-2.5 text-center">
                      {tech.isActive ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-emerald-100 text-emerald-700 border border-emerald-300 rounded">
                          <Eye className="w-3 h-3" /> Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-gray-100 text-gray-500 border border-gray-300 rounded">
                          <EyeOff className="w-3 h-3" /> Disabled
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <button
                        onClick={() => handleToggle(tech.id, tech.isActive)}
                        disabled={toggling === tech.id}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-blue-400 ${
                          tech.isActive ? 'bg-emerald-500' : 'bg-gray-300'
                        } ${toggling === tech.id ? 'opacity-50' : ''}`}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                          tech.isActive ? 'translate-x-[18px]' : 'translate-x-[3px]'
                        }`} />
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
