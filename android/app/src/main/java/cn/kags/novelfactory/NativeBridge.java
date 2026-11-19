package cn.kags.novelfactory;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * WebView ↔ 原生 双向桥。
 * 前端调用：window.Native.*；原生推送：window.__nfOnEvent(type,payload)。
 */
public final class NativeBridge {
    private static final String TAG = "NFBridge";
    private static volatile WebView webView;

    static void bind(WebView wv) { webView = wv; }

    /** 原生主动推送事件到 JS（可在任意线程调用） */
    static void pushEvent(String type, String payload) {
        final WebView wv = webView;
        if (wv == null) return;
        final String safe = payload == null ? "" : payload.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n");
        wv.post(() -> {
            try { wv.evaluateJavascript("window.__nfOnEvent && window.__nfOnEvent('" + type + "','" + safe + "');", null); }
            catch (Exception e) { Log.w(TAG, "push failed", e); }
        });
    }

    private final Context ctx;
    private final TaskStore store;

    NativeBridge(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.store = new TaskStore(ctx);
    }

    @JavascriptInterface
    public String ping() { return "native-ok"; }

    /** 是否有原生运行时（套壳里恒为 true） */
    @JavascriptInterface
    public boolean available() { return true; }

    /** 保存设置（前端保存时同步一份给原生服务读取） */
    @JavascriptInterface
    public void saveSettings(String json) {
        ctx.getSharedPreferences("nf_settings", Context.MODE_PRIVATE).edit().putString("json", json).apply();
    }

    /** 启动后台创作。workJson 为完整作品对象（含 spec/settings 由前端组装） */
    @JavascriptInterface
    public void startWork(String workId, String workJson) {
        try {
            JSONObject work = new JSONObject(workJson);
            store.saveWork(work);
            store.setCurrent(workId);
            Intent i = new Intent(ctx, WriterService.class);
            i.setAction(WriterService.ACTION_START);
            i.putExtra(WriterService.EXTRA_WORK_ID, workId);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception e) { Log.e(TAG, "startWork failed", e); }
    }

    /** 取消当前创作 */
    @JavascriptInterface
    public void cancelWork() { WriterService.cancel(ctx); }

    /** 取任务状态快照 */
    @JavascriptInterface
    public String getWork(String workId) {
        JSONObject w = store.getWork(workId);
        return w == null ? "" : w.toString();
    }

    @JavascriptInterface
    public String getLogs(String workId) { return store.getLogs(workId).toString(); }

    /** 是否有正在运行的任务 */
    @JavascriptInterface
    public String currentWorkId() { return store.getCurrent(); }

    /** 是否需要引导加入电池白名单（国产 ROM 保活关键） */
    @JavascriptInterface
    public boolean needBatteryWhitelist() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false;
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        return pm != null && !pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
    }

    /** 拉起电池优化白名单设置页（需前端用户手势触发） */
    @JavascriptInterface
    public void requestBatteryWhitelist() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + ctx.getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
            }
        } catch (Exception e) { Log.w(TAG, "whitelist intent failed", e); }
    }

    /** 需要通知权限（Android 13+） */
    @JavascriptInterface
    public boolean needNotificationPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU;
    }

    /** 拉起原生阅读器：草稿 JSON 写入内部文件（规避 Intent 大小限制），再启动原生 Activity */
    @JavascriptInterface
    public boolean openReader(String draftJson) {
        try {
            java.io.File f = new java.io.File(ctx.getFilesDir(), "reader_draft.json");
            java.io.FileOutputStream fos = new java.io.FileOutputStream(f);
            try { fos.write(draftJson.getBytes("UTF-8")); } finally { fos.close(); }
            Intent i = new Intent(ctx, ReaderActivity.class);
            i.putExtra(ReaderActivity.EXTRA_DRAFT_FILE, f.getAbsolutePath());
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "openReader failed", e);
            return false;
        }
    }

    /** 是否有原生阅读器能力 */
    @JavascriptInterface
    public boolean hasNativeReader() { return true; }
}
