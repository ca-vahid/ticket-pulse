import { useState, useEffect, useCallback } from 'react';
import { workspaceAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { Users, Loader, Plus, Trash2, AlertTriangle, ShieldCheck, Eye } from 'lucide-react';

const ROLE_OPTIONS = [
  { value: 'viewer', label: 'Viewer', description: 'Can view dashboard data' },
  { value: 'admin', label: 'Admin', description: 'Can manage settings and configuration' },
];

export default function WorkspaceAccessPanel() {
  const { currentWorkspace } = useWorkspace();
  const [accessList, setAccessList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('viewer');
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState(null);

  const wsId = currentWorkspace?.id;

  const fetchAccess = useCallback(async () => {
    if (!wsId) return;
    setError(null);
    try {
      const res = await workspaceAPI.getAccess(wsId);
      setAccessList(res?.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load access list');
    }
    setLoading(false);
  }, [wsId]);

  useEffect(() => { fetchAccess(); }, [fetchAccess]);

  const handleGrant = async (e) => {
    e.preventDefault();
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    setGranting(true);
    setError(null);
    try {
      await workspaceAPI.grantAccess(wsId, email, newRole);
      setNewEmail('');
      setNewRole('viewer');
      await fetchAccess();
    } catch (err) {
      setError(err.message || 'Failed to grant access');
    }
    setGranting(false);
  };

  const handleRevoke = async (email) => {
    if (!confirm(`Remove access for ${email}?`)) return;
    setRevoking(email);
    setError(null);
    try {
      await workspaceAPI.revokeAccess(wsId, email);
      await fetchAccess();
    } catch (err) {
      setError(err.message || 'Failed to revoke access');
    }
    setRevoking(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 bg-indigo-100 rounded-lg">
          <Users className="w-5 h-5 text-indigo-600" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-gray-900">
            Workspace Access — {currentWorkspace?.name || 'Unknown'}
          </h3>
          <p className="text-sm text-gray-500">
            Control who can access this workspace and their permission level.
          </p>
        </div>
        <div className="ml-auto text-xs text-gray-500">
          {accessList.length} user{accessList.length !== 1 ? 's' : ''}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Grant access form */}
      <form onSubmit={handleGrant} className="flex items-end gap-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-600 mb-1">Email address</label>
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="user@example.com"
            className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-400"
            required
          />
        </div>
        <div className="w-32">
          <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-400"
          >
            {ROLE_OPTIONS.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={granting || !newEmail.trim()}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-50"
        >
          <Plus className="w-3.5 h-3.5" />
          {granting ? 'Granting...' : 'Grant'}
        </button>
      </form>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-2.5 font-medium text-gray-600">Email</th>
                <th className="text-center px-4 py-2.5 font-medium text-gray-600">Role</th>
                <th className="text-center px-4 py-2.5 font-medium text-gray-600">Granted</th>
                <th className="text-center px-4 py-2.5 font-medium text-gray-600 w-16">Remove</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {accessList.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-gray-400 text-sm">
                    No explicit access grants. Only global admins can access this workspace.
                  </td>
                </tr>
              ) : accessList.map((item) => (
                <tr key={item.email} className="hover:bg-gray-50/50">
                  <td className="px-4 py-2.5 font-medium text-gray-900">{item.email}</td>
                  <td className="px-4 py-2.5 text-center">
                    {item.role === 'admin' ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700 border border-amber-300 rounded">
                        <ShieldCheck className="w-3 h-3" /> Admin
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700 border border-blue-300 rounded">
                        <Eye className="w-3 h-3" /> Viewer
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-center text-xs text-gray-400">
                    {item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '--'}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <button
                      onClick={() => handleRevoke(item.email)}
                      disabled={revoking === item.email}
                      className="p-1 text-gray-400 hover:text-red-500 disabled:opacity-50"
                      title={`Remove ${item.email}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
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
