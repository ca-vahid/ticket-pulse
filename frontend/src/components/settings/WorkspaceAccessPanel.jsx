import { useState, useEffect, useCallback, useRef } from 'react';
import { workspaceAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { Users, Loader, Plus, Trash2, AlertTriangle, ShieldCheck, Eye, Search, Check, Pencil } from 'lucide-react';

const ROLE_OPTIONS = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'admin', label: 'Admin' },
];

function UserSearchInput({ value, onChange, onSelect }) {
  const [query, setQuery] = useState(value);
  const [suggestions, setSuggestions] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef(null);
  const wrapperRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const doSearch = useCallback(async (q) => {
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    setSearching(true);
    try {
      const res = await workspaceAPI.searchUsers(q);
      setSuggestions(res?.data || []);
      setShowDropdown(true);
    } catch {
      setSuggestions([]);
    }
    setSearching(false);
  }, []);

  const handleChange = (e) => {
    const val = e.target.value;
    setQuery(val);
    onChange(val);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(val), 300);
  };

  const handleSelect = (user) => {
    const email = user.mail;
    setQuery(email);
    onChange(email);
    onSelect(user);
    setShowDropdown(false);
    setSuggestions([]);
  };

  return (
    <div className="relative flex-1" ref={wrapperRef}>
      <label className="block text-xs font-medium text-gray-600 mb-1">Name or email</label>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
        <input
          type="text"
          value={query}
          onChange={handleChange}
          onFocus={() => { if (suggestions.length > 0) setShowDropdown(true); }}
          placeholder="Start typing a name or email..."
          className="w-full pl-9 pr-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-400"
          autoComplete="off"
        />
        {searching && (
          <Loader className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-gray-400" />
        )}
      </div>

      {showDropdown && suggestions.length > 0 && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
          {suggestions.map((user, i) => (
            <button
              key={i}
              type="button"
              onClick={() => handleSelect(user)}
              className="w-full text-left px-3 py-2 hover:bg-indigo-50 flex items-center gap-3 border-b border-gray-50 last:border-0"
            >
              <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center text-xs font-bold text-indigo-700 flex-shrink-0">
                {(user.displayName || '?').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-gray-900 truncate">{user.displayName}</div>
                <div className="text-xs text-gray-500 truncate">{user.mail}{user.jobTitle ? ` · ${user.jobTitle}` : ''}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {showDropdown && suggestions.length === 0 && query.length >= 2 && !searching && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-xs text-gray-400 text-center">
          No users found
        </div>
      )}
    </div>
  );
}

export default function WorkspaceAccessPanel() {
  const { currentWorkspace } = useWorkspace();
  const [accessList, setAccessList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('viewer');
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState(null);
  const [editingEmail, setEditingEmail] = useState(null);
  const [editRole, setEditRole] = useState('viewer');
  const [savingEdit, setSavingEdit] = useState(false);

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

  const handleStartEdit = (item) => {
    setEditingEmail(item.email);
    setEditRole(item.role);
  };

  const handleSaveEdit = async (email) => {
    setSavingEdit(true);
    setError(null);
    try {
      await workspaceAPI.grantAccess(wsId, email, editRole);
      setEditingEmail(null);
      await fetchAccess();
    } catch (err) {
      setError(err.message || 'Failed to update role');
    }
    setSavingEdit(false);
  };

  const handleCancelEdit = () => {
    setEditingEmail(null);
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

      {/* Grant access form with GAL lookup */}
      <form onSubmit={handleGrant} className="flex items-end gap-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
        <UserSearchInput
          value={newEmail}
          onChange={setNewEmail}
          onSelect={(user) => setNewEmail(user.mail)}
        />
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
                <th className="text-center px-4 py-2.5 font-medium text-gray-600 w-24">Actions</th>
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
                    {editingEmail === item.email ? (
                      <select
                        value={editRole}
                        onChange={(e) => setEditRole(e.target.value)}
                        className="px-2 py-0.5 text-xs border border-indigo-300 rounded focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      >
                        {ROLE_OPTIONS.map(r => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                    ) : item.role === 'admin' ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700 border border-amber-300 rounded">
                        <ShieldCheck className="w-3 h-3" /> Admin
                      </span>
                    ) : item.role === 'reviewer' ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-700 border border-purple-300 rounded">
                        <Check className="w-3 h-3" /> Reviewer
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
                    {editingEmail === item.email ? (
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => handleSaveEdit(item.email)}
                          disabled={savingEdit}
                          className="p-1 text-emerald-600 hover:bg-emerald-50 rounded disabled:opacity-50"
                          title="Save"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={handleCancelEdit}
                          className="p-1 text-gray-400 hover:bg-gray-100 rounded text-xs"
                          title="Cancel"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => handleStartEdit(item)}
                          className="p-1 text-gray-400 hover:text-indigo-500 rounded"
                          title="Edit role"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleRevoke(item.email)}
                          disabled={revoking === item.email}
                          className="p-1 text-gray-400 hover:text-red-500 disabled:opacity-50 rounded"
                          title={`Remove ${item.email}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
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
