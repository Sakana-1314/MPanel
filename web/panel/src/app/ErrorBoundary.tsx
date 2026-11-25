import React from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';

interface ErrorBoundaryState {
  error: Error | null;
  info: string | null;
}

/** 兜底错误边界：任何渲染异常都显示可恢复界面，而不是白屏。 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ info: info.componentStack ?? null });
    if (import.meta.env.DEV) {
      console.error('MPanel render error:', error, info);
    }
  }

  override render(): React.ReactNode {
    if (this.state.error === null) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-app-bg p-6 text-app-text">
        <div className="w-full max-w-xl rounded-xl border border-app-danger/40 bg-app-surface p-6 shadow-panel">
          <div className="flex items-center gap-2 text-app-danger">
            <CircleAlert className="h-5 w-5" />
            <h1 className="text-lg font-semibold">界面渲染出错</h1>
          </div>
          <p className="mt-2 text-sm text-app-muted">
            页面遇到了未处理的异常。可以先重新加载；若持续出现，请把下面的信息反馈给管理员。
          </p>
          <pre className="mt-3 max-h-48 overflow-auto rounded-md border border-app-border bg-app-bg p-3 font-mono text-xs text-app-danger">
            {this.state.error.message}
            {this.state.info === null ? '' : `\n${this.state.info}`}
          </pre>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                this.setState({ error: null, info: null });
              }}
              className="rounded-md border border-app-border bg-app-elevated px-3 py-1.5 text-sm text-app-text hover:bg-app-surface"
            >
              重试渲染
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-1.5 rounded-md bg-app-accent px-3 py-1.5 text-sm text-white hover:bg-app-accent-strong"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}
