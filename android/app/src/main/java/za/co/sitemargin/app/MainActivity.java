package za.co.sitemargin.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  // Status-bar clearance is handled with a static top-padding baked
  // directly into the CSS (see sitemargin-site/styles.css's .navbar and
  // App.jsx's dashHeader/gateNavOuter) rather than any native insets
  // listener or JS-injected CSS variable. Both of those approaches were
  // tried and dropped: native View padding is invisible to the web
  // content's own position:sticky math (header ran back up under the
  // status bar on scroll), and live-updating the header's padding via an
  // injected CSS custom property -- Capacitor's own SystemBars "css" mode
  // -- corrupts (visibly doubled/ghosted text and icons) on this WebView's
  // software rasterizer whenever the value changes after first paint,
  // which happens on every cross-origin navigation. A static value never
  // changes after paint, so neither failure mode applies.
}
