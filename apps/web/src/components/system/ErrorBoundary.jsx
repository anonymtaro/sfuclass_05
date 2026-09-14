import { Component } from 'react';

/**
 * Error boundary  (F7)
 *
 * A friendly failure with a trace id, rather than a blank page. The trace id is
 * the whole point: it is the same one the API stamped on the request that
 * failed, so a support message that quotes it can be found in CloudWatch in one
 * query instead of by guessing at timestamps.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, traceId: null };
  }

  static getDerivedStateFromError(error) {
    return { error, traceId: error?.traceId ?? null };
  }

  componentDidCatch(error, info) {
    // Logged, not swallowed. In production this is where the OTEL exporter
    // picks it up; in dev the console is enough.
    console.error(`[${this.props.area ?? 'app'}]`, error, info?.componentStack);
  }

  render() {
    const { error, traceId } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="app app-error" role="alert">
        <h1>Something went wrong</h1>
        <p>
          This part of the page stopped working. Reloading usually fixes it; if it does not,
          quoting the reference below will let us find exactly what happened.
        </p>
        {traceId && <p className="app-error__trace">Reference: {traceId}</p>}

        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          Reload
        </button>

        {import.meta.env.DEV && (
          <pre className="app-error__stack">{error.stack ?? String(error)}</pre>
        )}
      </div>
    );
  }
}