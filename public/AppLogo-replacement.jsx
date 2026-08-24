{/* Replace the existing AppLogo() function in src/App.jsx (around line 520)
   with this. The old version measured the Fraunces "m" glyph at runtime to
   draw an underline under it — no longer needed since the new mark has no
   dynamic-width underline, so the useRef/useEffect glyph-measuring logic is
   gone too. */}

function AppLogo() {
  return (
    <div style={styles.appLogoRow}>
      <svg className="sm-app-logo-mark" style={styles.appLogoMark} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
        <rect x="4" y="8" width="28" height="8" fill="#3C2E1E" />
        <rect x="34" y="8" width="10" height="8" fill="#B85C2C" />
        <rect x="4" y="20" width="40" height="8" fill="#3C2E1E" />
        <rect x="4" y="32" width="40" height="8" fill="#3C2E1E" />
      </svg>
      <div className="sm-app-logo-text" style={styles.appLogoText}>
        site<span style={{ color: "#B85C2C" }}>Margin</span>
      </div>
    </div>
  );
}
