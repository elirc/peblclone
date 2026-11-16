import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/ui';
import './index.css';
import { AuthProvider } from './lib/auth';
import { queryClient } from './lib/query';
import { AppRoutes } from './routes';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

// Providers, outermost first: crash safety -> server cache -> routing -> identity -> toasts.
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <ToastProvider>
              <AppRoutes />
            </ToastProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
