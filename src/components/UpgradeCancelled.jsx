export default function UpgradeCancelled() {
  return (
    <div
      style={{
        minHeight: "60vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#EEF4F9",
        padding: "2rem",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: 440,
          width: "100%",
          background: "#FFFFFF",
          borderRadius: 16,
          padding: "2.5rem 2rem",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: "0 0 0.5rem", color: "#14171A" }}>
          Upgrade cancelled
        </h1>
        <p style={{ color: "#5B6472", fontSize: 15, margin: "0 0 1.5rem" }}>
          No payment was made and your storage limit hasn't changed. You can try again
          any time from your storage settings.
        </p>

        <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
          <a
            href="/dashboard"
            style={{
              display: "inline-block",
              background: "#FFFFFF",
              color: "#1D5A8C",
              border: "1px solid #D7E3EE",
              padding: "12px 22px",
              borderRadius: 9999,
              textDecoration: "none",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            Back to dashboard
          </a>
          <a
            href="/settings/storage"
            style={{
              display: "inline-block",
              background: "#1D5A8C",
              color: "#FFFFFF",
              padding: "12px 24px",
              borderRadius: 9999,
              textDecoration: "none",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            Try again
          </a>
        </div>
      </div>
    </div>
  );
}
