package cn.kags.novelfactory;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 轻量 OpenAI 兼容客户端（仅用 Android 框架 API，零第三方依赖）。
 * baseURL/apiKey 为空时进入 mock 模式，由上层走确定性演示引擎。
 */
final class LlmClient {
    private final String baseUrl;
    private final String apiKey;
    private final String model;
    private final double temperature;
    private final AtomicReference<HttpURLConnection> current = new AtomicReference<>();
    private volatile boolean canceled = false;

    LlmClient(String baseUrl, String apiKey, String model, double temperature) {
        this.baseUrl = baseUrl == null ? "" : baseUrl.trim();
        this.apiKey = apiKey == null ? "" : apiKey.trim();
        this.model = (model == null || model.isEmpty()) ? "gpt-4o-mini" : model;
        this.temperature = temperature;
    }

    boolean isMock() { return baseUrl.isEmpty() || apiKey.isEmpty(); }

    void cancel() {
        canceled = true;
        HttpURLConnection c = current.getAndSet(null);
        if (c != null) { try { c.disconnect(); } catch (Throwable ignored) {} }
    }

    /** 单次对话补全，返回正文；失败抛异常由编排层处理 */
    String chat(String system, String user, int maxTokens) throws Exception {
        if (canceled) throw new InterruptedException("已取消");
        if (isMock()) return null;

        String endpoint = trimSlash(baseUrl) + "/chat/completions";
        HttpURLConnection conn = (HttpURLConnection) new URL(endpoint).openConnection();
        current.set(conn);
        try {
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(120000);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + apiKey);
            conn.setDoOutput(true);

            JSONArray messages = new JSONArray();
            messages.put(msg("system", system));
            messages.put(msg("user", user));
            JSONObject body = new JSONObject();
            body.put("model", model);
            body.put("messages", messages);
            body.put("temperature", temperature);
            body.put("max_tokens", maxTokens);

            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            OutputStream os = conn.getOutputStream();
            os.write(payload);
            os.flush();
            os.close();

            int code = conn.getResponseCode();
            InputStream is = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
            String resp = readAll(is);
            if (code < 200 || code >= 300) {
                throw new IllegalStateException("模型 HTTP " + code + ": " + clip(resp, 200));
            }
            JSONObject data = new JSONObject(resp);
            JSONArray choices = data.optJSONArray("choices");
            if (choices == null || choices.length() == 0) return null;
            JSONObject content = choices.getJSONObject(0).optJSONObject("message");
            String text = content == null ? "" : content.optString("content", "");
            return text.trim().isEmpty() ? null : text.trim();
        } finally {
            current.compareAndSet(conn, null);
            conn.disconnect();
        }
    }

    private static JSONObject msg(String role, String content) throws org.json.JSONException {
        JSONObject o = new JSONObject();
        o.put("role", role);
        o.put("content", content);
        return o;
    }

    private static String readAll(InputStream is) throws Exception {
        if (is == null) return "";
        StringBuilder sb = new StringBuilder();
        BufferedReader r = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
        String line;
        while ((line = r.readLine()) != null) sb.append(line).append('\n');
        r.close();
        return sb.toString();
    }

    private static String trimSlash(String s) { return s.replaceAll("/+$", ""); }
    private static String clip(String s, int n) { return s == null ? "" : (s.length() > n ? s.substring(0, n) : s); }
}
