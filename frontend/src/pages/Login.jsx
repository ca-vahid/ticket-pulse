import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const { loginWithSSO, isAuthenticated, isLoading, error } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/dashboard');
    }
  }, [isAuthenticated, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-500 to-purple-600">
      <div className="bg-white rounded-lg shadow-2xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-800 mb-2">
            Ticket Pulse
          </h1>
          <p className="text-gray-600">
            FreshService IT Dashboard
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-6">
            {error}
          </div>
        )}

        <button
          onClick={loginWithSSO}
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-3 bg-[#0078d4] hover:bg-[#106ebe] text-white font-semibold py-3 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg className="w-5 h-5" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="10" height="10" fill="#f25022"/>
            <rect x="11" width="10" height="10" fill="#7fba00"/>
            <rect y="11" width="10" height="10" fill="#00a4ef"/>
            <rect x="11" y="11" width="10" height="10" fill="#ffb900"/>
          </svg>
          {isLoading ? 'Signing in...' : 'Sign in with Microsoft'}
        </button>

        <div className="mt-6 text-center text-sm text-gray-500">
          <p>Real-time IT ticket monitoring</p>
        </div>
      </div>
    </div>
  );
}
