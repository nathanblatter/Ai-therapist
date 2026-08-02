// Error boundary (ai-therapist-114): a render crash in one admin view used to
// unmount the entire portal to a white screen (no nav, no recovery). This
// contains the blast radius to the failing view and offers a retry.
import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Reset the boundary when this changes (e.g. the active view id). */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error) {
    console.error('[ErrorBoundary] view crashed:', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="bg-white p-8 rounded-lg shadow text-center" role="alert">
          <p className="text-red-700 font-semibold mb-2">This view hit an error and could not render.</p>
          <p className="text-sm text-gray-600 mb-4 font-mono break-all">{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="px-4 py-2 bg-royal text-white rounded hover:bg-navy transition min-h-[44px]"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
