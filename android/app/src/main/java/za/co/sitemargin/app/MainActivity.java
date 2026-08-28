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

    // Android 15+ (targetSdk 35+) makes edge-to-edge display mandatory by
    // default — the WebView draws its content underneath the system status
    // bar and any camera cutout instead of the system reserving its own
    // space above it. setDecorFitsSystemWindows(true) alone was supposed to
    // opt the whole window back out of edge-to-edge, and it did fix the
    // app's own locally-bundled screens (the AuthGate hero) — but marketing
    // pages loaded into the same WebView via allowNavigation (About,
    // Pricing, etc.) kept showing the header colliding with the real status
    // bar clock/camera cutout. Belt and suspenders: also apply the system
    // bar insets as explicit padding directly on the WebView itself, so the
    // reserved space doesn't depend on the framework's automatic
    // fit-system-windows behavior being honored consistently across every
    // page/navigation state — it's now enforced natively regardless of
    // what URL is currently loaded inside the WebView.
    WindowCompat.setDecorFitsSystemWindows(getWindow(), true);

    WebView webView = getBridge().getWebView();
    ViewCompat.setOnApplyWindowInsetsListener(webView, (view, insets) -> {
      Insets systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
      view.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom);
      return insets;
    });
  }
}
