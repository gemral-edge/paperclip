// Content Center Layout — Paperclip Dashboard
// Light theme mặc định, dark mode toggle, cc-scope wrapper

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet } from '@/lib/router';
import { Moon, Sun } from 'lucide-react';
import { ToastContainer } from '@gem/ui';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 2, staleTime: 60_000, refetchOnWindowFocus: false },
  },
});

export default function CCLayout() {
  const [darkMode, setDarkMode] = useState(false);

  return (
    <QueryClientProvider client={queryClient}>
      <div
        className={`cc-scope${darkMode ? ' dark' : ''}`}
        style={{
          background: darkMode ? '#0a0a20' : 'transparent',
          minHeight: '100%',
          color: darkMode ? '#e8e8f0' : '#111827',
        }}
      >
        {/* Nút chuyển chế độ sáng/tối */}
        <div className="flex justify-end px-4 py-2">
          <button
            onClick={() => setDarkMode(!darkMode)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors ${
              darkMode
                ? 'border-purple-500/30 text-purple-300 hover:bg-purple-500/10' // dark-surface-ok
                : 'border-gray-300 text-gray-600 hover:bg-gray-100'
            }`}
          >
            {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            {darkMode ? 'Chế độ sáng' : 'Chế độ tối'}
          </button>
        </div>
        <Outlet />
        <ToastContainer position="bottom-right" />
      </div>
    </QueryClientProvider>
  );
}
