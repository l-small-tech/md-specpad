package tech.l_small.mdspecpad

import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // Draw into the display cutout (punch-hole camera) area. With the system
    // bars immersive-hidden, the default cutout mode letterboxes the window
    // below the cutout instead — a dead band across the top on phones (tablets
    // have no cutout, so they never showed it). The web layer already pads the
    // tab bar by env(safe-area-inset-top), which is exactly the cutout inset,
    // so content still clears the camera.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes.layoutInDisplayCutoutMode =
        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
    }
    hideSystemBars()
  }

  // Re-hide the bars whenever the window regains focus (e.g. after the user
  // swipes them in transiently, or after the soft keyboard is dismissed).
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) hideSystemBars()
  }

  // Immersive "sticky" fullscreen: the status bar and navigation bar are
  // hidden and reappear only transiently on an edge swipe, then auto-hide.
  private fun hideSystemBars() {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.hide(WindowInsetsCompat.Type.systemBars())
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
  }
}
