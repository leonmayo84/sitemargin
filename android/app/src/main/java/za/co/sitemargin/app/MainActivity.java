package za.co.sitemargin.app;

import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // TEMPORARY DIAGNOSTIC (remove once confirmed): unlike a Toast, this log
    // line cannot be silently suppressed by OEM battery/notification
    // restrictions — if it doesn't show up in Logcat, native code changes
    // genuinely aren't reaching the installed build. If it does show up,
    // the insets listener below is running and the bug is elsewhere.
    Log.e("MAINACTIVITY_DIAG", "onCreate reached — build v4, insets fix active");

    Toast.makeText(this, "NATIVE BUILD CHECK v4 — insets fix active", Toast.LENGTH_LONG).show();

    WindowCompat.setDecorFitsSystemWindows(getWindow(), true);

    WebView webView = getBridge().getWebView();
    ViewCompat.setOnApplyWindowInsetsListener(webView, (view, insets) -> {
      Insets systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
      view.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom);
      return insets;
    });
  }
}
