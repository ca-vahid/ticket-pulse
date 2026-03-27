import { useState, useEffect, useCallback } from 'react';
import { settingsAPI } from '../../services/api';
import {
  Shield, Plus, Trash2, Loader, CheckCircle, XCircle, AlertTriangle,
} from 'lucide-react';

export default function AdminManagementPanel() {
  const [emails, setEmails] = useState([]);
  const [source, setSource] = useState(null);
  const [newEmail, setNewEmail] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const fetchAdmins = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await settingsAPI.getAdmins();
      setEmails(res.data.emails || []);
      setSource(res.data.source || 'env');
    } catch (err) {
      setError(err.message || 'Failed to load admins');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchAdmins(); }, [fetchAdmins]);

  const addEmail = useCallback(async () => {
    const email = newEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) return;
    if (emails.includes(email)) {
      setError('This email is already an admin');
      return;
    }

    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = [...emails, email];
      const res = await settingsAPI.updateAdmins(updated);
      setEmails(res.data.emails);
      setSource('database');
      setNewEmail('');
      setSuccess(`Added ${email} as admin`);
    } catch (err) {
      setError(err.message || 'Failed to add admin');
    } finally {
      setIsSaving(false);
    }
  }, [newEmail, emails]);

  const removeEmail = useCallback(async (emailToRemove) => {
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = emails.filter(e => e !== emailToRemove);
      const res = await settingsAPI.updateAdmins(updated);
      setEmails(res.data.emails);
      setSuccess(`Removed ${emailToRemove}`);
    } catch (err) {
      setError(err.message || 'Failed to remove admin');
    } finally {
      setIsSaving(false);
    }
  }, [emails]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 bg-amber-100 rounded-lg">
          <Shield className="w-5 h-5 text-amber-600" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Admin Management</h3>
          <p className="text-sm text-gray-500">
            Manage who has admin access to Ticket Pulse. Admins can see all workspaces, manage settings, and access all features.
          </p>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
          <XCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
          <span className="text-sm text-red-800">{error}</span>
        </div>
      )}

      {success && (
        <div className="flex items-start gap-2 p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
          <CheckCircle className="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" />
          <span className="text-sm text-emerald-800">{success}</span>
        </div>
      )}

      {source === 'env' && (
        <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-amber-800">
            <strong>Using environment variable.</strong> Admin emails are currently read from the <code className="bg-amber-100 px-1 rounded">ADMIN_EMAILS</code> env var.
            Add or remove an admin below to switch to database storage (persists without server restarts).
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader className="w-5 h-5 animate-spin text-gray-400" />
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          {/* Admin list */}
          <div className="divide-y divide-gray-100">
            {emails.map((email) => (
              <div key={email} className="px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Shield className="w-4 h-4 text-amber-500" />
                  <span className="text-sm font-medium text-gray-900">{email}</span>
                </div>
                <button
                  onClick={() => removeEmail(email)}
                  disabled={isSaving || emails.length <= 1}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg border border-transparent hover:border-red-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={emails.length <= 1 ? 'Cannot remove the last admin' : `Remove ${email}`}
                >
                  <Trash2 className="w-3 h-3" />
                  Remove
                </button>
              </div>
            ))}
          </div>

          {/* Add new admin */}
          <div className="px-4 py-3 bg-gray-50 border-t border-gray-200">
            <div className="flex items-center gap-2">
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addEmail()}
                placeholder="email@example.com"
                className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
              />
              <button
                onClick={addEmail}
                disabled={isSaving || !newEmail.trim()}
                className="flex items-center gap-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-amber-400 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {isSaving ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Add Admin
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
