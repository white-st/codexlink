package com.codexlink.mobile;

import java.io.*;
import java.security.*;
import java.util.*;

/** Validated public release contract; never accepts arbitrary URLs or downgrade installs. */
public final class ReleaseInfo {
    public static final String PACKAGE = "com.codexlink.mobile";
    public final String version, filename, sha256, notes;
    public final int versionCode, minSdk;
    public final long size;
    public ReleaseInfo(String version, int versionCode, String packageName, String filename, long size, String sha256, int minSdk, String notes) throws IOException {
        if (version == null || !version.matches("[0-9]{1,5}\\.[0-9]{1,5}\\.[0-9]{1,5}") || versionCode <= 0 || !PACKAGE.equals(packageName) || !("CodexLink-" + version + ".apk").equals(filename) || size <= 0 || size > ApiClient.MAX_FILE_BYTES || sha256 == null || !sha256.matches("[0-9a-f]{64}") || minSdk < 26 || minSdk > 100 || notes == null || notes.length() > 4000) throw new IOException("更新信息不完整或无效，请稍后重试");
        this.version=version;this.versionCode=versionCode;this.filename=filename;this.size=size;this.sha256=sha256;this.minSdk=minSdk;this.notes=notes;
    }
    public boolean newerThan(int installedCode) { return versionCode > installedCode; }
    public void verifyFile(File file) throws IOException {
        if (file.length() != size) throw new IOException("安装包大小不符，请重新下载");
        try {
            MessageDigest hash=MessageDigest.getInstance("SHA-256");byte[] buffer=new byte[65536];int count;
            try(InputStream in=new FileInputStream(file)){while((count=in.read(buffer))!=-1){if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("更新已取消");hash.update(buffer,0,count);}}
            StringBuilder hex=new StringBuilder();for(byte b:hash.digest())hex.append(String.format(Locale.ROOT,"%02x",b&255));
            if(!sha256.equals(hex.toString()))throw new IOException("安装包校验未通过，请重新下载");
        }catch(NoSuchAlgorithmException error){throw new IOException("设备不支持安装包校验",error);}
    }
}
