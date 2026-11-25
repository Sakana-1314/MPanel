import { Suspense, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from '../components/layout/Sidebar';
import { TopBar } from '../components/layout/TopBar';
import { CommandPalette } from '../components/CommandPalette';
import { Spinner } from '../components/ui/Spinner';
import { ConnectionGate } from './ConnectionGate';
import { LoginGate } from './LoginGate';
import { MachineGate } from './MachineGate';

export function AppShell(): JSX.Element {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-app-bg text-app-text">
      <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenuClick={() => setMobileOpen(true)} />
        <main className="flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-[1440px] px-3 py-4 md:px-6 md:py-6">
            <ConnectionGate>
              <LoginGate>
                <MachineGate>
                  <Suspense
                    fallback={
                      <div className="flex min-h-[40vh] items-center justify-center">
                        <Spinner size="lg" label="加载页面…" />
                      </div>
                    }
                  >
                    <Outlet />
                  </Suspense>
                </MachineGate>
              </LoginGate>
            </ConnectionGate>
          </div>
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}
