package za.co.sitemargin.app;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    // Android 15+ (targetSdk 35+) makes edge-to-edge display mandatory by
    // default — the WebView draws its content underneath the system status
    // bar and any camera cutout instead of the system reserving its own
    // space above it. That's what was causing the app header (logo,
    // hamburger button, page title) to visually collide with the real
    // status bar clock/icons and camera cutout. This restores the
    // pre-Android-15 behavior: the system bars get their own space, and the
    // WebView's content starts safely below them, same as before.
    WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
  }
}
