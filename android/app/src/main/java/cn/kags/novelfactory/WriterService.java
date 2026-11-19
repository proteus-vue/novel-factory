package cn.kags.novelfactory;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.atomic.AtomicReference;

/** 前台服务：锁屏/切后台后持续驱动多智能体创作，常驻通知显示进度。 */
public final class WriterService extends Service {
    private static final String TAG = "NFWriter";
    private static final String CHANNEL = "nf_writer";
    private static final int NOTI_ID = 1001;

    public static final String ACTION_START = "nf.start";
    public static final String ACTION_CANCEL = "nf.cancel";
    public static final String EXTRA_WORK_ID = "workId";

    private final AtomicReference<Engine> engineRef = new AtomicReference<>();
    private PowerManager.WakeLock wakeLock;
    private volatile String currentId;
    private TaskStore store;

    @Override public void onCreate() {
        super.onCreate();
        store = new TaskStore(this);
        createChannel();
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "novelfactory:writer");
            wakeLock.setReferenceCounted(false);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_STICKY;
        String action = intent.getAction();
        if (ACTION_CANCEL.equals(action)) {
            Engine e = engineRef.get();
            if (e != null) e.stop();
            NativeBridge.pushEvent("canceled", "已取消");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(action)) return START_STICKY;

        String id = intent.getStringExtra(EXTRA_WORK_ID);
        if (id == null || id.isEmpty()) return START_NOT_STICKY;
        JSONObject work = store.getWork(id);
        if (work == null) { Log.w(TAG, "作品不存在: " + id); return START_NOT_STICKY; }

        // 已在跑同一任务则忽略重复启动
        if (currentId != null && currentId.equals(id) && engineRef.get() != null) return START_STICKY;
        currentId = id;

        startForeground(NOTI_ID, buildNotification("准备创作", 0, 0));
        if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire(30 * 60 * 1000L);

        JSONObject settings = new JSONObject();
        try { settings = new JSONObject(getSharedPreferences("nf_settings", MODE_PRIVATE).getString("json", "{}")); } catch (Exception ignored) {}

        LlmClient llm = new LlmClient(
            settings.optString("baseURL", ""), settings.optString("apiKey", ""),
            settings.optString("model", "gpt-4o-mini"), settings.optDouble("temperature", 0.85));

        try { work.put("status", "running"); } catch (Exception ignored) {}
        store.saveWork(work);
        store.setCurrent(id);
        NativeBridge.pushEvent("started", "创作已启动");

        final JSONObject target = work;
        final String[] finalCheer = {""};
        Engine engine = new Engine(llm, settings, new Engine.Hooks() {
            @Override public void log(String msg) {
                store.appendLog(id, msg);
                NativeBridge.pushEvent("log", msg);
            }
            @Override public void progress(int cur, int total, String label) {
                store.appendLog(id, "PROGRESS " + cur + "/" + total + " " + label);
                NativeBridge.pushEvent("progress", cur + "/" + total);
                updateNotification(label, cur, total);
            }
            @Override public boolean shouldStop() { return engineRef.get() == null; }
            @Override public void onChapterDone(JSONObject record) {
                store.saveWork(target);
                NativeBridge.pushEvent("chapter", "第" + record.optInt("no") + "章定稿");
            }
            @Override public void onBudget(int used, int cap) {
                NativeBridge.pushEvent("budget", cap > 0 ? used + "/" + cap : String.valueOf(used));
            }
            @Override public void onCheer(String msg) {
                finalCheer[0] = msg;
                NativeBridge.pushEvent("cheer", msg);
            }
        });
        engineRef.set(engine);

        new Thread(() -> {
            try {
                engine.run(target);
                boolean canceled = engineRef.get() == null;
                target.put("status", canceled ? "canceled" : "done");
            } catch (Throwable t) {
                Log.e(TAG, "engine failed", t);
                try { target.put("status", "failed"); target.put("error", String.valueOf(t.getMessage())); } catch (Exception ignored) {}
            } finally {
                store.saveWork(target);
                store.setCurrent(null);
                updateNotification("创作" + ("done".equals(target.optString("status")) ? "完成" : "结束"), 0, 0);
                String finishPayload = target.optString("status");
                if ("done".equals(target.optString("status")) && finalCheer[0] != null && !finalCheer[0].isEmpty()) {
                    try {
                        JSONObject fp = new JSONObject();
                        fp.put("status", "done");
                        fp.put("cheer", finalCheer[0]);
                        finishPayload = fp.toString();
                    } catch (Exception ignored) {}
                }
                NativeBridge.pushEvent("finished", finishPayload);
                if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
                engineRef.set(null);
                currentId = null;
                stopForeground(false);
                // 通知保留几秒供用户查看结果，然后停止服务
                new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> stopSelf(), 4000);
            }
        }, "nf-engine").start();

        return START_STICKY;
    }

    private void updateNotification(String text, int cur, int total) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTI_ID, buildNotification(text, cur, total));
    }

    private Notification buildNotification(String text, int cur, int total) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        android.graphics.Bitmap icon = null; // 用小图标即可，避免大图内存开销
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_edit)
            .setContentTitle("小说工厂 · 创作中")
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setContentIntent(pi);
        if (total > 0) b.setProgress(total, cur, false);
        return b.build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "创作运行时", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("后台多智能体创作的进度通知");
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        Engine e = engineRef.getAndSet(null);
        if (e != null) e.stop();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    static void cancel(Context ctx) {
        Intent i = new Intent(ctx, WriterService.class);
        i.setAction(ACTION_CANCEL);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
        else ctx.startService(i);
    }
}
