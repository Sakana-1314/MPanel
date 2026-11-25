import { Suspense } from 'react';
import { BrowserRouter, useRoutes } from 'react-router-dom';
import { routes } from '../routes';
import { Providers } from './Providers';
import { Spinner } from '../components/ui/Spinner';

const basename = import.meta.env.BASE_URL.replace(/\/+$/, '') || '/';

export default function App(): JSX.Element {
  return (
    <Providers>
      <BrowserRouter basename={basename}>
        <Suspense
          fallback={
            <div className="flex min-h-screen items-center justify-center bg-app-bg">
              <Spinner size="lg" label="加载 MPanel…" />
            </div>
          }
        >
          <RouteTree />
        </Suspense>
      </BrowserRouter>
    </Providers>
  );
}

function RouteTree(): JSX.Element {
  const element = useRoutes(routes);
  return <>{element}</>;
}
