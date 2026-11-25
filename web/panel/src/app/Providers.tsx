import { useEffect } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { queryClient } from '../lib/query-client';
import { ToastProvider } from '../components/ui/Toast';
import { installWsConnectionGuard } from '../api/ws';
import { ErrorBoundary } from './ErrorBoundary';
import { ThemeProvider } from './ThemeProvider';

export function Providers(props: { children: ReactNode }): JSX.Element {
  useEffect(() => {
    installWsConnectionGuard();
  }, []);

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>{props.children}</ToastProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
