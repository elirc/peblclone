import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/**
 * Catches a render-time crash anywhere below it and shows a recovery screen
 * instead of a blank white page. (Error boundaries must still be class
 * components — there is no hook equivalent.)
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // In production this is where an error-reporting service would be called.
    console.error('Unhandled UI error', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold text-ink-900">Something went wrong</h1>
          <p className="mt-2 text-sm text-ink-500">
            The page hit an unexpected error. Reloading usually fixes it.
          </p>
          <button
            type="button"
            className="mt-5 rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"
            onClick={() => window.location.assign('/')}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
