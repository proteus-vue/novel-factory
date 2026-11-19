package cn.kags.novelfactory;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 任务持久化（替代 Room 的轻量方案：SharedPreferences + JSON）。
 * 数据量：几十章纯文本 + story bible，远小于 1MB，SP 足够且零依赖。
 * 全部方法 synchronized，保证 Service 线程与 UI 线程并发安全。
 */
final class TaskStore {
    private static final String PREF = "nf_runtime_v1";
    private static final String KEY_TASK = "task_";
    private static final String KEY_CURRENT = "current_task_id";
    private final SharedPreferences sp;

    TaskStore(Context ctx) {
        sp = ctx.getApplicationContext().getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    synchronized void saveWork(JSONObject work) {
        String id = work.optString("id");
        if (id.isEmpty()) return;
        sp.edit().putString(KEY_TASK + id, work.toString()).apply();
    }

    synchronized JSONObject getWork(String id) {
        String raw = sp.getString(KEY_TASK + id, null);
        if (raw == null) return null;
        try { return new JSONObject(raw); } catch (Exception e) { return null; }
    }

    synchronized List<JSONObject> allWorks() {
        List<JSONObject> out = new ArrayList<>();
        for (String key : sp.getAll().keySet()) {
            if (!key.startsWith(KEY_TASK)) continue;
            try { out.add(new JSONObject(sp.getString(key, "{}"))); } catch (Exception ignored) {}
        }
        return out;
    }

    synchronized void setCurrent(String id) { sp.edit().putString(KEY_CURRENT, id == null ? "" : id).apply(); }
    synchronized String getCurrent() { return sp.getString(KEY_CURRENT, ""); }

    synchronized void appendLog(String id, String line) {
        try {
            JSONObject work = getWork(id);
            if (work == null) return;
            JSONArray logs = work.optJSONArray("logs");
            if (logs == null) { logs = new JSONArray(); work.put("logs", logs); }
            logs.put(line);
            if (logs.length() > 500) {
                JSONArray trimmed = new JSONArray();
                for (int i = logs.length() - 300; i < logs.length(); i++) trimmed.put(logs.opt(i));
                work.put("logs", trimmed);
            }
            saveWork(work);
        } catch (Exception ignored) {}
    }

    synchronized JSONArray getLogs(String id) {
        JSONObject work = getWork(id);
        return work == null ? new JSONArray() : work.optJSONArray("logs");
    }
}
