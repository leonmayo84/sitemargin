package za.co.sitemargin.app;

import android.os.Bundle;
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

    // TEMPORARY DIAGNOSTIC (remove once confirmed): if this toast does NOT
    // appear on screen when the app launches, native code changes are not
    // reaching the installed build at all — a build/install pipeline issue,
    // not a bug in the insets logic below. If it DOES appear, the insets
    // listener below is genuinely running and we look elsewhere.
    Toast.makeText(this, "NATIVE BUILD CHECK v3 — insets fix active", Toast.LENGTH_LONG).show();

    WindowCompat.setDecorFitsSystemWindows(getWindow(), true);

    WebView webView = getBridge().getWebView();
    ViewCompat.setOnApplyWindowInsetsListener(webView, (view, insets) -> {
      Insets systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
      view.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom);
      return insets;
    });
  }
}
