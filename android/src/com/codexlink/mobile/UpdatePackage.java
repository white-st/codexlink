package com.codexlink.mobile;

import android.content.Context;
import android.content.pm.*;
import android.os.Build;
import org.json.*;
import java.io.*;
import java.util.*;

final class UpdatePackage {
    static ReleaseInfo parse(String text) throws IOException {
        try {
            JSONObject data=new JSONObject(text);
            for(String key:new String[]{"origin","version","packageName","file","sha256","notes"})if(!(data.get(key) instanceof String))throw new IOException("更新文字格式无效");
            if(!ApiClient.ORIGIN.equals(data.getString("origin")))throw new IOException("更新来源不匹配");
            // Reject coerced/fractional numbers; the build publishes integer fields.
            for(String key:new String[]{"versionCode","minSdk","size"})if(!(data.get(key) instanceof Integer || data.get(key) instanceof Long))throw new IOException("更新编号格式无效");
            if(data.getLong("versionCode")<1||data.getLong("versionCode")>Integer.MAX_VALUE||data.getLong("minSdk")<26||data.getLong("minSdk")>Integer.MAX_VALUE)throw new IOException("更新编号格式无效");
            return new ReleaseInfo(data.getString("version"),data.getInt("versionCode"),data.getString("packageName"),data.getString("file"),data.getLong("size"),data.getString("sha256"),data.getInt("minSdk"),data.getString("notes"));
        }catch(JSONException error){throw new IOException("更新信息暂时不可用，请稍后重试",error);}
    }
    static PackageInfo installed(Context context) throws PackageManager.NameNotFoundException {return context.getPackageManager().getPackageInfo(context.getPackageName(),signingFlags());}
    static String version(Context context){try{return installed(context).versionName;}catch(PackageManager.NameNotFoundException error){throw new IllegalStateException(error);}}
    private static int signingFlags(){return Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES;}
    private static Set<String> signers(PackageInfo info) throws IOException {
        Signature[] signatures=Build.VERSION.SDK_INT>=28?(info.signingInfo==null?null:info.signingInfo.getApkContentsSigners()):info.signatures;
        if(signatures==null||signatures.length==0)throw new IOException("无法核对安装包签名");
        Set<String> result=new HashSet<>();for(Signature signature:signatures)result.add(signature.toCharsString());return result;
    }
    static void verify(Context context,ReleaseInfo release,File file) throws Exception {
        release.verifyFile(file);
        PackageInfo current=installed(context),next=context.getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(),signingFlags());
        if(next==null||!context.getPackageName().equals(next.packageName)||next.versionCode!=release.versionCode||!release.version.equals(next.versionName)||!release.newerThan(current.versionCode))throw new IOException("安装包版本不匹配，或当前版本已更新");
        if(next.applicationInfo==null||next.applicationInfo.minSdkVersion!=release.minSdk||release.minSdk>Build.VERSION.SDK_INT)throw new IOException("安装包的安卓版本要求不匹配或不兼容");
        if(!signers(current).equals(signers(next)))throw new IOException("安装包签名与当前 App 不一致，已停止更新");
    }
}
