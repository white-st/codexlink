package com.codexlink.mobile;

import com.sun.net.httpserver.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

public final class UpdateTest {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    interface Attempt{void run()throws Exception;}
    static void rejects(Attempt attempt)throws Exception{try{attempt.run();throw new AssertionError("invalid update accepted");}catch(IOException|IllegalArgumentException expected){}}
    static void reply(HttpExchange request,int code,String type,byte[] bytes)throws IOException{request.getResponseHeaders().set("Content-Type",type);request.sendResponseHeaders(code,bytes.length);request.getResponseBody().write(bytes);request.close();}
    static String hash(byte[] data)throws Exception{StringBuilder text=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(data))text.append(String.format(Locale.ROOT,"%02x",b&255));return text.toString();}
    public static void main(String[] args)throws Exception{
        byte[] bytes=new byte[160000];new Random(52).nextBytes(bytes);String digest=hash(bytes);
        ReleaseInfo release=new ReleaseInfo("0.6.1",10,ReleaseInfo.PACKAGE,"CodexLink-0.6.1.apk",bytes.length,digest,26,"App 内更新");
        check(release.newerThan(9)&&!release.newerThan(10)&&!release.newerThan(11),"version code monotonic");
        File file=File.createTempFile("update-test-",".apk");
        HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);String origin="http://127.0.0.1:"+server.getAddress().getPort();AtomicInteger metadataMode=new AtomicInteger(),redirected=new AtomicInteger();
        server.createContext("/downloads/release.json",request->{if(metadataMode.get()==1)reply(request,200,"text/html","verification".getBytes("UTF-8"));else if(metadataMode.get()==2)reply(request,200,"application/json",new byte[33000]);else reply(request,200,"application/json","{\"versionCode\":10}".getBytes("UTF-8"));});
        server.createContext("/downloads/CodexLink-0.6.1.apk",request->{check("GET".equals(request.getRequestMethod()),"GET only");check("ddnsto=fixture".equals(request.getRequestHeaders().getFirst("Cookie")),"verification cookie retained");reply(request,200,"application/vnd.android.package-archive",bytes);});
        server.createContext("/downloads/CodexLink-0.6.2.apk",request->{request.getResponseHeaders().set("Location",origin+"/receiver");reply(request,302,"text/plain",new byte[]{1});});
        server.createContext("/receiver",request->{redirected.incrementAndGet();reply(request,200,"application/vnd.android.package-archive",bytes);});
        server.createContext("/downloads/CodexLink-0.6.3.apk",request->{request.getResponseHeaders().set("Content-Type","application/vnd.android.package-archive");request.sendResponseHeaders(200,bytes.length);request.getResponseBody().write(new byte[2]);request.close();});
        server.createContext("/downloads/CodexLink-0.6.4.apk",request->reply(request,200,"text/html",new byte[]{1}));
        server.start();
        try{
            Files.write(file.toPath(),bytes);release.verifyFile(file);bytes[0]^=1;Files.write(file.toPath(),bytes);rejects(()->release.verifyFile(file));bytes[0]^=1;
            Files.write(file.toPath(),new byte[0]);rejects(()->release.verifyFile(file));
            for(String name:new String[]{"../secret.apk","https://evil.example/a.apk","CodexLink-0.6.2.apk"})rejects(()->new ReleaseInfo("0.6.1",10,ReleaseInfo.PACKAGE,name,160000,digest,26,""));
            rejects(()->new ReleaseInfo("0.6.1",10,"evil.app",release.filename,160000,digest,26,""));
            rejects(()->new ReleaseInfo("0.6.1",0,ReleaseInfo.PACKAGE,release.filename,160000,digest,26,""));
            rejects(()->new ReleaseInfo("0.6.1",10,ReleaseInfo.PACKAGE,release.filename,ApiClient.MAX_FILE_BYTES+1L,digest,26,""));
            ApiClient api=new ApiClient(origin,new ApiClient.Cookies(){public String get(String url){return "ddnsto=fixture";}public void set(String url,String cookie){}});
            check(api.release().contains("versionCode"),"public metadata");metadataMode.set(1);rejects(api::release);metadataMode.set(2);rejects(api::release);
            AtomicInteger progress=new AtomicInteger();api.downloadUpdate(release.filename,file,(done,total)->{check(total==release.size&&done<=total,"progress bounds");progress.incrementAndGet();});release.verifyFile(file);check(progress.get()>0,"progress events");
            for(String name:new String[]{"../a.apk","https://evil.example/a.apk","CodexLink-0.6.1.apk?x=1"})rejects(()->api.downloadUpdate(name,file,null));
            for(String name:new String[]{"CodexLink-0.6.2.apk","CodexLink-0.6.3.apk","CodexLink-0.6.4.apk"}){rejects(()->api.downloadUpdate(name,file,null));check(!file.exists(),"failed download cleaned");}
            check(redirected.get()==0,"update redirects never followed");
            rejects(()->api.downloadUpdate(release.filename,file,(done,total)->{throw new InterruptedIOException("cancelled");}));check(!file.exists(),"cancelled partial cleaned");
            rejects(()->api.json("/downloads/password.txt",null));rejects(()->api.json("/downloads/release.json","{}"));
            System.out.println("Update contract: version/downgrade, filename/origin, metadata bounds, SHA256/length, progress, cancellation, truncated file and redirect/verification rejection passed.");
        }finally{server.stop(0);Files.deleteIfExists(file.toPath());}
    }
}
