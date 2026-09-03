import { Component } from "react";

// Belt and braces around the sign-in screen. Nothing in the current gate
// throws during render, but any future addition that does would turn the
// login page into a blank white screen with no way out — a boundary turns
// that into something the user can act on.
//
// Usage in src/main.jsx (or wherever AuthGate is mounted):
//
//   import { AuthErrorBoundary } from "./AuthErrorBoundary";
//   <AuthErrorBoundary><AuthGate /></AuthErrorBoundary>
export class AuthErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("AuthErrorBoundary caught:", error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center", padding: 24 }}>
          <h2 style={{ marginBottom: 8, fontFamily: "'Space Grotesk', sans-serif", fontSize: 22 }}>
            Something went wrong
          </h2>
          <p style={{ color: "var(--text-secondary)", marginBottom: 20, lineHeight: 1.6 }}>
            The sign-in screen hit an unexpected error. Reloading usually fixes it — your
            account and data are untouched.
          </p>
          <button
            type="button"
            onClick={() => { this.setState({ error: null }); window.location.reload(); }}
            style={{
              background: "linear-gradient(150deg,#23272E 0%,#14171C 52%,#090B0E 100%)",
              color: "#F2F6F9",
              border: "none",
              borderRadius: 100,
              padding: "11px 22px",
              fontWeight: 600,
              fontFamily: "'Space Grotesk', sans-serif",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
