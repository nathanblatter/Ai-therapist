import { useState, useEffect } from 'react';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'react-feather';

let toastIdCounter = 0;
const listeners = new Set();

// Global toast manager
export const toast = {
  success: (message, duration = 5000) => {
    showToast({ type: 'success', message, duration });
  },
  error: (message, duration = 7000) => {
    showToast({ type: 'error', message, duration });
  },
  warning: (message, duration = 6000) => {
    showToast({ type: 'warning', message, duration });
  },
  info: (message, duration = 5000) => {
    showToast({ type: 'info', message, duration });
  }
};

function showToast(toast) {
  const id = toastIdCounter++;
  const toastWithId = { ...toast, id };
  listeners.forEach(listener => listener(toastWithId));
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const listener = (toast) => {
      setToasts(prev => [...prev, toast]);

      if (toast.duration > 0) {
        setTimeout(() => {
          removeToast(toast.id);
        }, toast.duration);
      }
    };

    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);

  const removeToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const getIcon = (type) => {
    switch (type) {
      case 'success': return <CheckCircle size={20} />;
      case 'error': return <AlertCircle size={20} />;
      case 'warning': return <AlertTriangle size={20} />;
      case 'info': return <Info size={20} />;
      default: return null;
    }
  };

  const getColors = (type) => {
    switch (type) {
      case 'success': return 'bg-green-50 border-green-500 text-green-800';
      case 'error': return 'bg-red-50 border-red-500 text-red-800';
      case 'warning': return 'bg-yellow-50 border-yellow-500 text-yellow-800';
      case 'info': return 'bg-blue-50 border-blue-500 text-blue-800';
      default: return 'bg-gray-50 border-gray-500 text-gray-800';
    }
  };

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm w-full pointer-events-none"
      aria-live="polite"
      aria-atomic="true"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`${getColors(toast.type)} border-l-4 p-4 rounded-lg shadow-lg flex items-start gap-3 animate-slideIn pointer-events-auto`}
          role="alert"
          aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
        >
          <div className="flex-shrink-0 mt-0.5">
            {getIcon(toast.type)}
          </div>
          <div className="flex-1 text-sm font-medium">
            {toast.message}
          </div>
          <button
            onClick={() => removeToast(toast.id)}
            className="flex-shrink-0 hover:opacity-70 transition-opacity"
            aria-label="Dismiss notification"
          >
            <X size={18} />
          </button>
        </div>
      ))}
    </div>
  );
}
