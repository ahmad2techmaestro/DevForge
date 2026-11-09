import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '../ui/Button';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
        <h1 className="text-2xl">This screen crashed</h1>
        <p className="mt-2 text-sm text-muted">The rest of the app is fine. Reload the screen to continue; if it keeps happening, the message below helps when reporting it.</p>
        <pre className="mt-4 max-w-full overflow-auto rounded-lg border border-line bg-raised p-3 text-left font-mono text-xs text-bad">{this.state.error.message}</pre>
        <Button variant="primary" className="mt-5" onClick={() => this.setState({ error: null })}>
          Reload screen
        </Button>
      </div>
    );
  }
}
