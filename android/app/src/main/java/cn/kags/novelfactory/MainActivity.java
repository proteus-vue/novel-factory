package cn.kags.novelfactory;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * 小说工厂宿主 Activity。
 * - 大厂验收基线：edge-to-edge 沉浸式适配 + CSS 安全区避让。
 * - 原生运行时：注册 JSBridge，把 WebView 控制台接到 Foreground Service。
 */
public class MainActivity extends BridgeActivity {
    private static final int REQ_NOTI = 2001;
    private boolean bridgeRegistered = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setupEdgeToEdge();
        registerNativeBridge();
        requestNotificationPermission();
    }

    @Override
    public void onStart() {
        super.onStart();
        // Capacitor 首次初始化 bridge 可能晚于 onCreate，这里兜底再注册一次
        registerNativeBridge();
    }

    /**
     * 硬件返回键：先交给 WebView 页面栈消费（pop 上一页）。
     * __nfBack() 返回 true 表示已回退一页；false 表示已在根页，此时才退出 App。
     */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        final WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv == null) { super.onBackPressed(); return; }
        wv.evaluateJavascript("(typeof window.__nfBack==='function') ? window.__nfBack() : false", value -> {
            if (!"true".equals(value)) runOnUiThread(() -> super.onBackPressed());
        });
    }

    private void registerNativeBridge() {
        if (bridgeRegistered) return;
        try {
            Bridge bridge = getBridge();
            if (bridge == null) return;
            WebView wv = bridge.getWebView();
            if (wv == null) return;
            wv.addJavascriptInterface(new NativeBridge(this), "Native");
            NativeBridge.bind(wv);
            bridgeRegistered = true;
        } catch (Throwable ignored) {
            // 注册失败不崩溃，前端会降级回本地演示引擎
        }
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTI);
            }
        }
    }

    private void setupEdgeToEdge() {
        Window window = getWindow();
        if (window == null) return;

        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setNavigationBarContrastEnforced(false);
        }

        window.getDecorView().postDelayed(() -> {
            WindowInsetsControllerCompat controller =
                    WindowCompat.getInsetsController(window, window.getDecorView());
            if (controller != null) {
                controller.setAppearanceLightStatusBars(true);
                controller.setAppearanceLightNavigationBars(true);
            }
        }, 700);
    }
}
