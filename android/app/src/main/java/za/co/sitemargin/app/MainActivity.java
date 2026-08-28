package za.co.sitemargin.app;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // FOUND (2026-08-28): the real cause of the header/status-bar overlap on
    // marketing pages (About, Pricing, etc. loaded cross-origin into this
    // same WebView) was Capacitor's own built-in SystemBars core plugin
    // (@capacitor/android, auto-registered — no separate install needed).
    // By default it installs its own OnApplyWindowInsetsListener on the
    // WebView's parent, and in its default "css" insets mode it (a) zeroes
    // out the systemBars/displayCutout insets before they propagate to any
    // child listener — including the one below, which is why it had zero
    // effect no matter what it did — and (b) injects a `--safe-area-inset-*`
    // CSS custom property into whatever document is currently loaded,
    // expecting THAT PAGE's own CSS to consume it as padding. Our own
    // bundled screens happened to look fine; sitemargin.co.za's marketing
    // pages have no idea this convention exists, so their sticky navbar
    // sits flush against the real top of the WebView every time.
    // capacitor.config.json now sets SystemBars.insetsHandling to
    // "disable", which turns off that competing listener entirely so the
    // listener below is the only thing touching insets, for every page
    // regardless of origin.
    WindowCompat.setDecorFitsSystemWindows(getWindow(), true);

    WebView webView = getBridge().getWebView();
    ViewCompat.setOnApplyWindowInsetsListener(webView, (view, insets) -> {
      Insets systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
      view.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom);
      return insets;
    });
  }
}
