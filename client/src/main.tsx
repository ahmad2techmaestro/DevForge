import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ApiError, configureClient } from './services/api/client';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { useAuth } from './store/auth';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
  },
});

// Configure the API client before the first render: child queries fire before App's effects run,
// so without this a page reload sends its first requests without the saved token.
configureClient({
  getToken: () => useAuth.getState().token,
  onUnauthorized: () => {
    useAuth.getState().clear();
    queryClient.clear();
  },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
