import { useState, useEffect, useRef } from "react";
import { Users, Plus, Edit2, Trash2, X, Save, Key, Search, Shield, Filter } from "react-feather";

const VOICE_OPTIONS = [
  { value: 'alloy', label: 'Alloy' },
  { value: 'ash', label: 'Ash' },
  { value: 'ballad', label: 'Ballad' },
  { value: 'cedar', label: 'Cedar' },
  { value: 'coral', label: 'Coral' },
  { value: 'echo', label: 'Echo' },
  { value: 'marin', label: 'Marin' },
  { value: 'sage', label: 'Sage' },
  { value: 'shimmer', label: 'Shimmer' },
  { value: 'verse', label: 'Verse' }
];

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English (US)' },
  { value: 'es-ES', label: 'Spanish (Spain)' },
  { value: 'es-419', label: 'Spanish (Latin America)' },
  { value: 'fr-FR', label: 'French (France)' },
  { value: 'fr-CA', label: 'French (Canada)' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'pt-PT', label: 'Portuguese (Portugal)' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ru', label: 'Russian' }
];

const ROLE_OPTIONS = [
  { value: 'participant', label: 'Participant' },
  { value: 'therapist', label: 'Therapist' },
  { value: 'researcher', label: 'Researcher' }
];

export default function UserManagement() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingUser, setEditingUser] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [formData, setFormData] = useState({ username: '', password: '', role: 'participant' });
  const [formError, setFormError] = useState(null);

  // Filter state
  const [filters, setFilters] = useState({
    search: '',
    roles: [],
    voices: [],
    languages: [],
    mfaStatus: '' // '', 'enabled', 'disabled'
  });
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    fetchUsers();
  }, []);

  const generateSecurePassword = () => {
    const length = 16;
    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?";
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    let password = '';
    for (let i = 0; i < length; i++) {
      password += charset[array[i] % charset.length];
    }
    return password;
  };

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/users');
      if (!response.ok) {
        throw new Error('Failed to fetch users');
      }
      const data = await response.json();
      setUsers(data.users);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    setFormError(null);

    if (!formData.username || !formData.password || !formData.role) {
      setFormError('All fields are required');
      return;
    }

    try {
      const response = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create user');
      }

      setShowAddModal(false);
      setFormData({ username: '', password: '', role: 'participant' });
      await fetchUsers();
    } catch (err) {
      setFormError(err.message);
    }
  };

  const handleEditUser = async (userid, updates) => {
    setFormError(null);

    try {
      const response = await fetch(`/api/users/${userid}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update user');
      }

      setEditingUser(null);
      await fetchUsers();
    } catch (err) {
      setFormError(err.message);
    }
  };

  const handleDeleteUser = async (userid, username) => {
    if (!confirm(`Are you sure you want to delete user "${username}"? This action cannot be undone.`)) {
      return;
    }

    try {
      const response = await fetch(`/api/users/${userid}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete user');
      }

      await fetchUsers();
    } catch (err) {
      setError(err.message);
    }
  };

  const EditModal = ({ user, onClose, onSave }) => {
    const [editData, setEditData] = useState({
      username: user.username,
      role: user.role,
      password: ''
    });
    const usernameInputRef = useRef(null);

    // Focus first input when modal opens
    useEffect(() => {
      if (usernameInputRef.current) {
        usernameInputRef.current.focus();
      }
    }, []);

    // Handle Escape key to close modal
    useEffect(() => {
      const handleEscape = (e) => {
        if (e.key === 'Escape') {
          onClose();
        }
      };

      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }, [onClose]);

    const handleSubmit = (e) => {
      e.preventDefault();
      const updates = { username: editData.username, role: editData.role };
      if (editData.password) {
        updates.password = editData.password;
      }
      onSave(user.userid, updates);
    };

    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" role="dialog" aria-modal="true" aria-labelledby="edit-user-modal-title">
        <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
          <div className="flex justify-between items-center mb-4">
            <h2 id="edit-user-modal-title" className="text-xl font-bold">Edit User</h2>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-700 min-h-[44px] min-w-[44px] flex items-center justify-center" aria-label="Close edit user dialog">
              <X size={24} />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="edit-username" className="block text-sm font-medium text-gray-700 mb-1">
                Username
              </label>
              <input
                ref={usernameInputRef}
                id="edit-username"
                type="text"
                value={editData.username}
                onChange={(e) => setEditData(prev => ({ ...prev, username: e.target.value }))}
                aria-label="Username"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-byuRoyal min-h-[44px]"
                required
              />
            </div>

            <div>
              <label htmlFor="edit-role" className="block text-sm font-medium text-gray-700 mb-1">
                Role
              </label>
              <select
                id="edit-role"
                value={editData.role}
                onChange={(e) => setEditData(prev => ({ ...prev, role: e.target.value }))}
                aria-label="User role"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-byuRoyal min-h-[44px]"
              >
                <option value="participant">Participant</option>
                <option value="therapist">Therapist</option>
                <option value="researcher">Researcher</option>
              </select>
            </div>

            <div>
              <label htmlFor="edit-password" className="block text-sm font-medium text-gray-700 mb-1">
                New Password (leave blank to keep current)
              </label>
              <div className="flex gap-2">
                <input
                  id="edit-password"
                  type="text"
                  value={editData.password}
                  onChange={(e) => setEditData(prev => ({ ...prev, password: e.target.value }))}
                  aria-label="New password (optional)"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-byuRoyal min-h-[44px]"
                  placeholder="Leave blank to keep current password"
                />
                <button
                  type="button"
                  onClick={() => {
                    const newPassword = generateSecurePassword();
                    setEditData(prev => ({ ...prev, password: newPassword }));
                  }}
                  className="px-3 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 flex items-center gap-1 whitespace-nowrap min-h-[44px]"
                  aria-label="Generate secure password"
                >
                  <Key size={16} aria-hidden="true" />
                  Generate
                </button>
              </div>
            </div>

            {formError && (
              <div className="text-red-600 text-sm" role="alert">{formError}</div>
            )}

            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300 min-h-[44px]"
                aria-label="Cancel editing"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-byuRoyal text-white rounded-md hover:bg-blue-700 flex items-center gap-2 min-h-[44px]"
                aria-label="Save user changes"
              >
                <Save size={16} aria-hidden="true" />
                Save Changes
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  };

  const AddUserModal = () => {
    const addUsernameInputRef = useRef(null);

    // Focus first input when modal opens
    useEffect(() => {
      if (addUsernameInputRef.current) {
        addUsernameInputRef.current.focus();
      }
    }, []);

    // Handle Escape key to close modal
    useEffect(() => {
      const handleEscape = (e) => {
        if (e.key === 'Escape') {
          setShowAddModal(false);
        }
      };

      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }, []);

    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" role="dialog" aria-modal="true" aria-labelledby="add-user-modal-title">
        <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
          <div className="flex justify-between items-center mb-4">
            <h2 id="add-user-modal-title" className="text-xl font-bold">Add New User</h2>
            <button onClick={() => setShowAddModal(false)} className="text-gray-500 hover:text-gray-700 min-h-[44px] min-w-[44px] flex items-center justify-center" aria-label="Close add user dialog">
              <X size={24} />
            </button>
          </div>

        <form onSubmit={handleAddUser} className="space-y-4">
          <div>
            <label htmlFor="add-username" className="block text-sm font-medium text-gray-700 mb-1">
              Username
            </label>
            <input
              ref={addUsernameInputRef}
              id="add-username"
              type="text"
              value={formData.username}
              onChange={(e) => setFormData(prev => ({ ...prev, username: e.target.value }))}
              aria-label="New user username"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-byuRoyal min-h-[44px]"
              required
            />
          </div>

          <div>
            <label htmlFor="add-password" className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <div className="flex gap-2">
              <input
                id="add-password"
                type="text"
                value={formData.password}
                onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                aria-label="New user password"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-byuRoyal min-h-[44px]"
                required
              />
              <button
                type="button"
                onClick={() => {
                  const newPassword = generateSecurePassword();
                  setFormData(prev => ({ ...prev, password: newPassword }));
                }}
                className="px-3 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 flex items-center gap-1 whitespace-nowrap min-h-[44px]"
                aria-label="Generate secure random password"
              >
                <Key size={16} aria-hidden="true" />
                Generate
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-500">Click "Generate" to create a secure random password</p>
          </div>

          <div>
            <label htmlFor="add-role" className="block text-sm font-medium text-gray-700 mb-1">
              Role
            </label>
            <select
              id="add-role"
              value={formData.role}
              onChange={(e) => setFormData(prev => ({ ...prev, role: e.target.value }))}
              aria-label="New user role"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-byuRoyal min-h-[44px]"
            >
              <option value="participant">Participant</option>
              <option value="therapist">Therapist</option>
              <option value="researcher">Researcher</option>
            </select>
          </div>

          {formError && (
            <div className="text-red-600 text-sm" role="alert">{formError}</div>
          )}

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setShowAddModal(false)}
              className="px-4 py-2 text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300 min-h-[44px]"
              aria-label="Cancel adding user"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-byuRoyal text-white rounded-md hover:bg-blue-700 flex items-center gap-2 min-h-[44px]"
              aria-label="Submit new user"
            >
              <Plus size={16} aria-hidden="true" />
              Add User
            </button>
          </div>
        </form>
      </div>
    </div>
    );
  };

  // Filter users based on current filters
  const filteredUsers = users.filter(user => {
    // Search filter (username or userid)
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      const matchesUsername = user.username.toLowerCase().includes(searchLower);
      const matchesUserId = user.userid.toString().includes(searchLower);
      if (!matchesUsername && !matchesUserId) return false;
    }

    // Role filter
    if (filters.roles.length > 0 && !filters.roles.includes(user.role)) {
      return false;
    }

    // Voice filter
    if (filters.voices.length > 0) {
      const userVoice = user.preferred_voice || 'cedar';
      if (!filters.voices.includes(userVoice)) return false;
    }

    // Language filter
    if (filters.languages.length > 0) {
      const userLanguage = user.preferred_language || 'en';
      if (!filters.languages.includes(userLanguage)) return false;
    }

    // MFA status filter
    if (filters.mfaStatus === 'enabled' && !user.mfa_enabled) {
      return false;
    }
    if (filters.mfaStatus === 'disabled' && user.mfa_enabled) {
      return false;
    }

    return true;
  });

  const toggleFilter = (filterKey, value) => {
    setFilters(prev => {
      const currentValues = prev[filterKey];
      const newValues = currentValues.includes(value)
        ? currentValues.filter(v => v !== value)
        : [...currentValues, value];
      return { ...prev, [filterKey]: newValues };
    });
  };

  const clearFilters = () => {
    setFilters({
      search: '',
      roles: [],
      voices: [],
      languages: [],
      mfaStatus: ''
    });
  };

  const activeFilterCount =
    (filters.search ? 1 : 0) +
    filters.roles.length +
    filters.voices.length +
    filters.languages.length +
    (filters.mfaStatus ? 1 : 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">Loading users...</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">User Management</h2>
          <p className="text-gray-600 mt-1">
            {filteredUsers.length} of {users.length} users
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="bg-byuRoyal text-white px-4 py-2 rounded-md hover:bg-blue-700 flex items-center gap-2 min-h-[44px]"
          aria-label="Add new user"
        >
          <Plus size={20} aria-hidden="true" />
          Add User
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 space-y-4">
        {/* Search and Filter Toggle Row */}
        <div className="flex gap-3 items-center">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={20} />
            <input
              type="text"
              placeholder="Search by username or user ID..."
              value={filters.search}
              onChange={(e) => setFilters(prev => ({ ...prev, search: e.target.value }))}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-byuRoyal"
            />
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg border ${
              showFilters || activeFilterCount > 0
                ? 'bg-byuRoyal text-white border-byuRoyal'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
            }`}
          >
            <Filter size={20} />
            <span>Filters</span>
            {activeFilterCount > 0 && (
              <span className="bg-white text-byuRoyal rounded-full px-2 py-0.5 text-xs font-bold">
                {activeFilterCount}
              </span>
            )}
          </button>
          {activeFilterCount > 0 && (
            <button
              onClick={clearFilters}
              className="text-sm text-gray-600 hover:text-gray-800 underline"
            >
              Clear all
            </button>
          )}
        </div>

        {/* Advanced Filters (Collapsible) */}
        {showFilters && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 grid grid-cols-4 gap-4">
            {/* Role Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Role</label>
              <div className="space-y-2">
                {ROLE_OPTIONS.map(role => (
                  <label key={role.value} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filters.roles.includes(role.value)}
                      onChange={() => toggleFilter('roles', role.value)}
                      className="rounded border-gray-300 text-byuRoyal focus:ring-byuRoyal"
                    />
                    <span className="text-sm text-gray-700">{role.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Voice Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Preferred Voice</label>
              <div className="space-y-2 max-h-32 overflow-y-auto">
                {VOICE_OPTIONS.map(voice => (
                  <label key={voice.value} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filters.voices.includes(voice.value)}
                      onChange={() => toggleFilter('voices', voice.value)}
                      className="rounded border-gray-300 text-byuRoyal focus:ring-byuRoyal"
                    />
                    <span className="text-sm text-gray-700">{voice.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Language Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Language</label>
              <div className="space-y-2 max-h-32 overflow-y-auto">
                {LANGUAGE_OPTIONS.map(lang => (
                  <label key={lang.value} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filters.languages.includes(lang.value)}
                      onChange={() => toggleFilter('languages', lang.value)}
                      className="rounded border-gray-300 text-byuRoyal focus:ring-byuRoyal"
                    />
                    <span className="text-sm text-gray-700">{lang.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* MFA Status Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">MFA Status</label>
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="mfaStatus"
                    checked={filters.mfaStatus === ''}
                    onChange={() => setFilters(prev => ({ ...prev, mfaStatus: '' }))}
                    className="border-gray-300 text-byuRoyal focus:ring-byuRoyal"
                  />
                  <span className="text-sm text-gray-700">All</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="mfaStatus"
                    checked={filters.mfaStatus === 'enabled'}
                    onChange={() => setFilters(prev => ({ ...prev, mfaStatus: 'enabled' }))}
                    className="border-gray-300 text-byuRoyal focus:ring-byuRoyal"
                  />
                  <span className="text-sm text-gray-700">MFA Enabled</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="mfaStatus"
                    checked={filters.mfaStatus === 'disabled'}
                    onChange={() => setFilters(prev => ({ ...prev, mfaStatus: 'disabled' }))}
                    className="border-gray-300 text-byuRoyal focus:ring-byuRoyal"
                  />
                  <span className="text-sm text-gray-700">MFA Disabled</span>
                </label>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden" role="region" aria-label="User management table">
        <table className="min-w-full divide-y divide-gray-200" role="table">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                User ID
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                Username
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                Role
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                Preferred Voice
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                Language
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                MFA Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                Created At
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {filteredUsers.map((user) => (
              <tr key={user.userid} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                  {user.userid}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                  {user.username}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${
                    user.role === 'researcher' ? 'bg-purple-100 text-purple-800' :
                    user.role === 'therapist' ? 'bg-blue-100 text-blue-800' :
                    'bg-green-100 text-green-800'
                  }`}>
                    {user.role}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                  <span className="capitalize">{user.preferred_voice || 'cedar'}</span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                  {user.preferred_language || 'en'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm">
                  {(user.role === 'therapist' || user.role === 'researcher') ? (
                    user.mfa_enabled ? (
                      <span className="flex items-center gap-1 text-green-700">
                        <Shield size={16} className="text-green-600" />
                        <span className="font-medium">Enabled</span>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-yellow-700">
                        <Shield size={16} className="text-yellow-600" />
                        <span>Disabled</span>
                      </span>
                    )
                  ) : (
                    <span className="text-gray-400 text-xs">N/A</span>
                  )}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {new Date(user.created_at).toLocaleDateString()}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                  <div className="flex gap-2">
                    <button
                      onClick={() => setEditingUser(user)}
                      className="text-byuRoyal hover:text-blue-700 flex items-center gap-1 min-h-[44px]"
                      aria-label={`Edit user ${user.username}`}
                    >
                      <Edit2 size={16} aria-hidden="true" />
                      Edit
                    </button>
                    <button
                      onClick={() => handleDeleteUser(user.userid, user.username)}
                      className="text-red-600 hover:text-red-800 flex items-center gap-1 min-h-[44px]"
                      aria-label={`Delete user ${user.username}`}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {filteredUsers.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            <Users size={48} className="mx-auto mb-2 text-gray-400" />
            <p>{users.length === 0 ? 'No users found' : 'No users match the current filters'}</p>
          </div>
        )}
      </div>

      {showAddModal && <AddUserModal />}
      {editingUser && (
        <EditModal
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onSave={handleEditUser}
        />
      )}
    </div>
  );
}
