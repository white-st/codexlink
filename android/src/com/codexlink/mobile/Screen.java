package com.codexlink.mobile;

import android.app.Activity;
import android.os.Build;
import android.view.*;

final class Screen {
    static void insets(Activity activity, View root) {
        if (Build.VERSION.SDK_INT >= 30) {
            activity.getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, windowInsets) -> {
                android.graphics.Insets values = windowInsets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                view.setPadding(values.left, values.top, values.right, values.bottom);
                return windowInsets;
            });
            root.requestApplyInsets();
        } else root.setFitsSystemWindows(true);
    }
}
