package cn.kags.novelfactory;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;

/**
 * 原生阅读器：独立于 WebView 的原生 Activity。
 * - 正规阅读排版：首行缩进、行距、可调字号、三种主题
 * - 章节目录抽屉、上一章/下一章、阅读进度记忆
 * - 数据由 NativeBridge 通过草稿文件传入（避免 Intent 大小限制）
 */
public class ReaderActivity extends AppCompatActivity {
    public static final String EXTRA_DRAFT_FILE = "draftFile";

    private static final String PREF = "nf_reader_prefs";
    private static final String K_THEME = "theme";       // day / eye / night
    private static final String K_FONT = "fontSp";
    private static final String K_PROGRESS_PREFIX = "pos_"; // pos_<bookTitle> = chapterIndex

    private JSONObject draft;
    private JSONArray chapters;
    private String bookTitle = "阅读器";
    private int index = 0;
    private float fontSp = 17f;
    private String theme = "day";

    private View root, topbar, bottom, line1, line2;
    private LinearLayout catalogPanel, settingsPanel, catalogList;
    private View catalogMask;
    private ScrollView scroll;
    private TextView titleView, chapterView, bodyView, progressView, fontSizeView;
    private ImageButton backBtn, fontBtn, catalogBtn;
    private Button prevBtn, nextBtn;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_reader);
        bindViews();
        loadDraft();
        loadPrefs();
        applyTheme();
        setupActions();
        renderChapter();
    }

    private void bindViews() {
        root = findViewById(R.id.rd_root);
        topbar = findViewById(R.id.rd_topbar);
        bottom = findViewById(R.id.rd_bottom);
        scroll = findViewById(R.id.rd_scroll);
        titleView = findViewById(R.id.rd_title);
        chapterView = findViewById(R.id.rd_chapter);
        bodyView = findViewById(R.id.rd_body);
        progressView = findViewById(R.id.rd_progress);
        backBtn = findViewById(R.id.rd_back);
        fontBtn = findViewById(R.id.rd_font);
        catalogBtn = findViewById(R.id.rd_catalog);
        prevBtn = findViewById(R.id.rd_prev);
        nextBtn = findViewById(R.id.rd_next);
        catalogPanel = findViewById(R.id.rd_catalog_panel);
        catalogList = findViewById(R.id.rd_catalog_list);
        catalogMask = findViewById(R.id.rd_catalog_mask);
        settingsPanel = findViewById(R.id.rd_settings_panel);
        fontSizeView = findViewById(R.id.rd_font_size);
    }

    private void loadDraft() {
        String file = getIntent() != null ? getIntent().getStringExtra(EXTRA_DRAFT_FILE) : null;
        if (file == null) { Toast.makeText(this, "阅读数据不存在", Toast.LENGTH_SHORT).show(); finish(); return; }
        try {
            String json = readFile(file);
            draft = new JSONObject(json);
            bookTitle = draft.optString("title", "阅读器");
            chapters = draft.optJSONArray("chapters");
            if (chapters == null || chapters.length() == 0) { Toast.makeText(this, "暂无章节", Toast.LENGTH_SHORT).show(); finish(); return; }
            titleView.setText(bookTitle);
        } catch (Exception e) {
            Toast.makeText(this, "阅读数据解析失败", Toast.LENGTH_SHORT).show();
            finish();
        }
    }

    private String readFile(String path) throws Exception {
        InputStream in = new FileInputStream(path);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), "UTF-8");
        } finally { in.close(); }
    }

    private SharedPreferences prefs() { return getSharedPreferences(PREF, Context.MODE_PRIVATE); }

    private void loadPrefs() {
        SharedPreferences p = prefs();
        theme = p.getString(K_THEME, "day");
        fontSp = p.getFloat(K_FONT, 17f);
        index = p.getInt(K_PROGRESS_PREFIX + bookTitle, 0);
    }

    private void applyTheme() {
        int bg, text, sub, bar, line, accent;
        boolean light;
        switch (theme) {
            case "night":
                bg = R.color.rd_night_bg; text = R.color.rd_night_text; sub = R.color.rd_night_sub;
                bar = R.color.rd_night_bar; line = R.color.rd_night_line; accent = R.color.rd_night_accent; light = false;
                break;
            case "eye":
                bg = R.color.rd_eye_bg; text = R.color.rd_eye_text; sub = R.color.rd_eye_sub;
                bar = R.color.rd_eye_bar; line = R.color.rd_eye_line; accent = R.color.rd_eye_accent; light = true;
                break;
            default:
                bg = R.color.rd_day_bg; text = R.color.rd_day_text; sub = R.color.rd_day_sub;
                bar = R.color.rd_day_bar; line = R.color.rd_day_line; accent = R.color.rd_day_accent; light = true;
                break;
        }
        root.setBackgroundColor(res(bg));
        topbar.setBackgroundColor(res(bar));
        bottom.setBackgroundColor(res(bar));
        titleView.setTextColor(res(text));
        chapterView.setTextColor(res(text));
        bodyView.setTextColor(res(text));
        progressView.setTextColor(res(sub));
        backBtn.setColorFilter(res(text));
        fontBtn.setColorFilter(res(text));
        catalogBtn.setColorFilter(res(text));
        prevBtn.setTextColor(res(accent));
        nextBtn.setTextColor(res(accent));
        fontSizeView.setTextColor(res(text));
        // 底部描边颜色随主题
        for (int id : new int[]{R.id.rd_topbar}) { /* 顶栏下方分隔线在XML固定，需动态更新见下 */ }
        applyTint(light);
    }

    private void applyTint(boolean light) {
        Window w = getWindow();
        if (w == null) return;
        WindowCompat.setDecorFitsSystemWindows(w, true);
        w.setStatusBarColor(res(theme.equals("night") ? R.color.rd_night_bar : (theme.equals("eye") ? R.color.rd_eye_bar : R.color.rd_day_bar)));
        w.setNavigationBarColor(res(theme.equals("night") ? R.color.rd_night_bar : (theme.equals("eye") ? R.color.rd_eye_bar : R.color.rd_day_bar)));
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, w.getDecorView());
        if (c != null) c.setAppearanceLightStatusBars(light);
    }

    private int res(int colorRes) { return androidx.core.content.ContextCompat.getColor(this, colorRes); }

    private void renderChapter() {
        if (chapters == null || index < 0 || index >= chapters.length()) return;
        try {
            JSONObject ch = chapters.getJSONObject(index);
            String t = ch.optString("title", "第" + (index + 1) + "章");
            chapterView.setText(t);
            String text = ch.optString("text", "");
            String[] paras = text.split("\\n+");
            StringBuilder sb = new StringBuilder();
            for (String p : paras) {
                String s = p.trim();
                if (s.isEmpty()) continue;
                if (sb.length() > 0) sb.append("\n\n");
                sb.append("　　").append(s); // 中文首行缩进
            }
            bodyView.setText(sb.toString());
            bodyView.setTextSize(fontSp);
            chapterView.setTextSize(Math.min(fontSp + 4f, 26f));
            progressView.setText((index + 1) + " / " + chapters.length());
            prevBtn.setEnabled(index > 0);
            nextBtn.setEnabled(index < chapters.length() - 1);
            scroll.scrollTo(0, 0);
            prefs().edit().putInt(K_PROGRESS_PREFIX + bookTitle, index).apply();
            buildCatalog();
        } catch (Exception e) {
            bodyView.setText("章节内容解析失败");
        }
    }

    private void buildCatalog() {
        catalogList.removeAllViews();
        int accentRes, textRes, subRes;
        switch (theme) {
            case "night": accentRes = R.color.rd_night_accent; textRes = R.color.rd_night_text; subRes = R.color.rd_night_sub; break;
            case "eye": accentRes = R.color.rd_eye_accent; textRes = R.color.rd_eye_text; subRes = R.color.rd_eye_sub; break;
            default: accentRes = R.color.rd_day_accent; textRes = R.color.rd_day_text; subRes = R.color.rd_day_sub; break;
        }
        int dp = (int) dp(1);
        for (int i = 0; i < chapters.length(); i++) {
            final int idx = i;
            boolean current = (i == index);
            // 行容器
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(android.view.Gravity.CENTER_VERTICAL);
            row.setPadding(20 * dp, 7 * dp, 18 * dp, 7 * dp);
            if (current) row.setBackgroundColor(android.graphics.Color.parseColor(theme.equals("night") ? "#22FFFFFF" : "#0D0D3A3B"));
            row.setOnClickListener(v -> { index = idx; renderChapter(); closeCatalog(); });

            // 序号徽标
            TextView num = new TextView(this);
            num.setText(String.valueOf(i + 1));
            num.setGravity(android.view.Gravity.CENTER);
            num.setTextSize(12f);
            num.setTextColor(res(current ? R.color.rd_day_bar : subRes));
            int size = 28 * dp;
            android.graphics.drawable.GradientDrawable badge = new android.graphics.drawable.GradientDrawable();
            badge.setShape(android.graphics.drawable.GradientDrawable.OVAL);
            badge.setColor(res(current ? accentRes : (theme.equals("night") ? R.color.rd_night_bar : R.color.rd_day_line)));
            num.setBackground(badge);
            LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(size, size);
            row.addView(num, np);

            // 章节标题（去掉"第N章"前缀，只显示主标题，更清爽）
            TextView label = new TextView(this);
            String title;
            try { title = chapters.getJSONObject(i).optString("title", "第" + (i + 1) + "章"); }
            catch (Exception e) { title = "第" + (i + 1) + "章"; }
            label.setText(title.replaceFirst("^第\\d+章\\s*", ""));
            label.setTextSize(14.5f);
            label.setTextColor(res(current ? accentRes : textRes));
            label.setSingleLine(true);
            label.setEllipsize(android.text.TextUtils.TruncateAt.END);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            lp.leftMargin = 14 * dp;
            row.addView(label, lp);

            catalogList.addView(row);
        }
    }

    private void openCatalog() {
        catalogMask.setVisibility(View.VISIBLE);
        catalogPanel.animate().translationX(0).setDuration(220).start();
    }
    private void closeCatalog() {
        catalogPanel.animate().translationX(dp(300)).setDuration(220).start();
        catalogMask.setVisibility(View.GONE);
    }
    private float dp(int v) { return v * getResources().getDisplayMetrics().density; }

    private void toggleSettings() {
        boolean show = settingsPanel.getVisibility() != View.VISIBLE;
        settingsPanel.setVisibility(show ? View.VISIBLE : View.GONE);
    }

    private void setupActions() {
        backBtn.setOnClickListener(v -> finish());
        fontBtn.setOnClickListener(v -> toggleSettings());
        catalogBtn.setOnClickListener(v -> openCatalog());
        catalogMask.setOnClickListener(v -> closeCatalog());
        prevBtn.setOnClickListener(v -> { if (index > 0) { index--; renderChapter(); } });
        nextBtn.setOnClickListener(v -> { if (chapters != null && index < chapters.length() - 1) { index++; renderChapter(); } });

        findViewById(R.id.rd_font_minus).setOnClickListener(v -> {
            fontSp = Math.max(13f, fontSp - 1f); applyFont();
        });
        findViewById(R.id.rd_font_plus).setOnClickListener(v -> {
            fontSp = Math.min(30f, fontSp + 1f); applyFont();
        });
        findViewById(R.id.rd_theme_day).setOnClickListener(v -> setTheme("day"));
        findViewById(R.id.rd_theme_eye).setOnClickListener(v -> setTheme("eye"));
        findViewById(R.id.rd_theme_night).setOnClickListener(v -> setTheme("night"));
    }

    private void applyFont() {
        fontSizeView.setText(String.valueOf(Math.round(fontSp)));
        bodyView.setTextSize(fontSp);
        chapterView.setTextSize(Math.min(fontSp + 4f, 26f));
        prefs().edit().putFloat(K_FONT, fontSp).apply();
    }

    private void setTheme(String t) {
        theme = t;
        prefs().edit().putString(K_THEME, t).apply();
        applyTheme();
        buildCatalog();
    }

    @Override
    public void onBackPressed() {
        if (settingsPanel.getVisibility() == View.VISIBLE) { settingsPanel.setVisibility(View.GONE); return; }
        if (catalogMask.getVisibility() == View.VISIBLE) { closeCatalog(); return; }
        super.onBackPressed();
    }
}
