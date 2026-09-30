/**
 * src/components/ErrorBoundary.jsx
 * ---------------------------------
 * React class-based error boundary. Wraps each portal so a crash in one
 * section doesn't take down the entire app.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <SomePortal />
 *   </ErrorBoundary>
 */

import { Component } from "react";

const font = "Inter, -apple-system, BlinkMacSystemFont, sans-serif";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // In production this would POST to a logging service (e.g. Sentry)
    console.error("[Behari] Portal crash:", error.message);
    console.error(info.componentStack);
    this.setState({ info });
  }

  reset() {
    this.setState({ hasError: false, error: null, info: null });
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", minHeight: "100vh", padding: "32px 24px",
        fontFamily: font, background: "#F6F6F6", textAlign: "center",
      }}>
        {/* Icon */}
        <div style={{
          width: 72, height: 72, borderRadius: "50%",
          background: "#FDE8E3", display: "flex", alignItems: "center",
          justifyContent: "center", fontSize: 32, marginBottom: 20,
        }}>
          ⚠️
        </div>

        <div style={{ fontSize: 20, fontWeight: 800, color: "#000", marginBottom: 8 }}>
          Something went wrong
        </div>
        <div style={{
          fontSize: 14, color: "#545454", lineHeight: 1.65,
          maxWidth: 320, marginBottom: 32,
        }}>
          This section of the app encountered an unexpected error.
          Your data is safe — please try again or reload.
        </div>

        {/* Error detail (collapsible) */}
        {this.state.error && (
          <details style={{
            background: "#fff", border: "1px solid #EBEBEB", borderRadius: 10,
            padding: "12px 16px", maxWidth: 360, width: "100%",
            textAlign: "left", marginBottom: 28, fontSize: 12,
            color: "#C0392B", fontFamily: "monospace",
          }}>
            <summary style={{ cursor: "pointer", fontWeight: 700, fontFamily: font, color: "#545454", fontSize: 12 }}>
              Error details
            </summary>
            <pre style={{ marginTop: 8, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {this.state.error.message}
            </pre>
          </details>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 300 }}>
          <button
            onClick={() => this.reset()}
            style={{
              background: "#000", color: "#fff", border: "none", borderRadius: 10,
              padding: "14px", fontSize: 15, fontWeight: 700,
              cursor: "pointer", fontFamily: font,
            }}
          >
            Try Again
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: "transparent", color: "#545454",
              border: "1px solid #EBEBEB", borderRadius: 10,
              padding: "13px", fontSize: 14, fontWeight: 600,
              cursor: "pointer", fontFamily: font,
            }}
          >
            Reload App
          </button>
        </div>
      </div>
    );
  }
}
