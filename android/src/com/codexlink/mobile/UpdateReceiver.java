package com.codexlink.mobile;

import android.content.*;
import android.content.pm.PackageInstaller;
import java.lang.ref.WeakReference;

/** Explicit, non-exported receiver for the system's install-session callback. */
public final class UpdateReceiver extends BroadcastReceiver {
    static WeakReference<UpdateActivity> foreground=new WeakReference<>(null);
    static Intent confirmation;
    static SharedPreferences state(Context context){return context.getSharedPreferences("app-update",Context.MODE_PRIVATE);}
    @Override public void onReceive(Context context,Intent intent){
        SharedPreferences state=state(context);int expected=state.getInt("session",-1);
        if(expected<0||intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID,-2)!=expected)return;
        int status=intent.getIntExtra(PackageInstaller.EXTRA_STATUS,PackageInstaller.STATUS_FAILURE);
        SharedPreferences.Editor editor=state.edit().putInt("status",status);
        if(status!=PackageInstaller.STATUS_PENDING_USER_ACTION)editor.remove("session");
        editor.commit();
        confirmation=status==PackageInstaller.STATUS_PENDING_USER_ACTION?intent.getParcelableExtra(Intent.EXTRA_INTENT):null;
        UpdateActivity activity=foreground.get();if(activity!=null)activity.installResult();
    }
}
