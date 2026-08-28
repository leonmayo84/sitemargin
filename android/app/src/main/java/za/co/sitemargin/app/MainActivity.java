package za.co.sitemargin.app;

import android.os.Bundle;
import android.util.Log;
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

    Log.e("MAINACTIVITY_DIAG", "onCreate reached — build v5, listener about to attach");

    WindowCompat.setDecorFitsSystemWindows(getWindow(), true);

    WebView webView = getBridge().getWebView();
    ViewCompat.setOnApplyWindowInsetsListener(webView, (view, insets) -> {
      Insets systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
      Log.e(
        "MAINACTIVITY_DIAG",
        "insets listener FIRED — top=" + systemBars.top + " left=" + systemBars.left
          + " right=" + systemBars.right + " bottom=" + systemBars.bottom
      );
      view.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom);
      Log.e(
        "MAINACTIVITY_DIAG",
        "padding APPLIED — actual view padding now top=" + view.getPaddingTop()
      );
      return insets;
    });

    // Force an insets pass right away in case the listener never fires on
    // its own for some reason on this device.
    webView.post(() -> ViewCompat.requestApplyInsets(webView));
  }
}
