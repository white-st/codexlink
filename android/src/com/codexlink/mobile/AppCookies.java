package com.codexlink.mobile;

import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

final class AppCookies implements ApiClient.Cookies {
    private final CookieManager manager = CookieManager.getInstance();
    private final Handler main = new Handler(Looper.getMainLooper());
    public String get(String origin) { return manager.getCookie(origin); }
    public void set(String origin, String value) throws IOException {
        CountDownLatch done = new CountDownLatch(1); AtomicBoolean accepted = new AtomicBoolean();
        main.post(() -> manager.setCookie(origin, value, ok -> { accepted.set(ok); done.countDown(); }));
        try { if (!done.await(8, TimeUnit.SECONDS) || !accepted.get()) throw new IOException("登录信息保存失败，请重试"); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException("操作已取消", error); }
        manager.flush();
    }
    public void clearSession() throws IOException {
        set(ApiClient.ORIGIN, "codex_link_session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict");
    }
}
