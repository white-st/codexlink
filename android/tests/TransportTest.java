package com.codexlink.mobile;

import com.sun.net.httpserver.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.io.*;
import java.util.concurrent.atomic.AtomicInteger;

public class TransportTest {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static void reply(HttpExchange request,int code,String type,byte[] body)throws IOException{request.getResponseHeaders().set("Content-Type",type);request.sendResponseHeaders(code,body.length);request.getResponseBody().write(body);request.close();}
    public static void main(String[] args)throws Exception{
        // Desktop JDK restricts Origin by default; Android's implementation permits it.
        System.setProperty("sun.net.http.allowRestrictedHeaders","true");
        HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);AtomicInteger posts=new AtomicInteger(), redirected=new AtomicInteger();
        String origin="http://127.0.0.1:"+server.getAddress().getPort();
        server.createContext("/api/login",request->{
            check("POST".equals(request.getRequestMethod()),"POST");check(origin.equals(request.getRequestHeaders().getFirst("Origin")),"Origin");check("1".equals(request.getRequestHeaders().getFirst("X-Local-Client")),"client header");check("application/json".equals(request.getRequestHeaders().getFirst("Content-Type")),"JSON type");
            ByteArrayOutputStream data=new ByteArrayOutputStream();byte[] b=new byte[2048];int n;while((n=request.getRequestBody().read(b))!=-1)data.write(b,0,n);
            check("{\"prompt\":\"创建测试文件\"}".equals(new String(data.toByteArray(),StandardCharsets.UTF_8)),"UTF8 body");
            posts.incrementAndGet();request.getResponseHeaders().add("Set-Cookie","codex_link_session=test-session; Path=/; HttpOnly");reply(request,200,"application/json","{}".getBytes(StandardCharsets.UTF_8));
        });
        server.createContext("/api/private",request->{check("codex_link_session=test-session".equals(request.getRequestHeaders().getFirst("Cookie")),"session cookie");reply(request,200,"application/json","{\"ok\":true}".getBytes(StandardCharsets.UTF_8));});
        server.createContext("/api/upload",request->{check("POST".equals(request.getRequestMethod()),"binary POST");check("application/octet-stream".equals(request.getRequestHeaders().getFirst("Content-Type")),"upload MIME");check("codex_link_session=test-session".equals(request.getRequestHeaders().getFirst("Cookie")),"upload session");check(origin.equals(request.getRequestHeaders().getFirst("Origin")),"upload origin");check(request.getRequestURI().getRawQuery().contains("%E4"),"upload filename UTF8");ByteArrayOutputStream incoming=new ByteArrayOutputStream();int next;while((next=request.getRequestBody().read())!=-1)incoming.write(next);byte[] body=incoming.toByteArray();check(java.util.Arrays.equals(body,new byte[]{0,1,(byte)255,80,75}),"binary unchanged");reply(request,201,"application/json","{\"uploaded\":true}".getBytes(StandardCharsets.UTF_8));});
        server.createContext("/api/redirect",request->{posts.incrementAndGet();request.getResponseHeaders().set("Location",origin+"/api/receiver");reply(request,307,"text/plain","redirect".getBytes(StandardCharsets.UTF_8));});
        server.createContext("/api/receiver",request->{redirected.incrementAndGet();reply(request,200,"application/json","{}".getBytes(StandardCharsets.UTF_8));});
        server.createContext("/api/verification",request->reply(request,200,"text/html","<html>provider</html>".getBytes(StandardCharsets.UTF_8)));
        server.createContext("/api/expired",request->reply(request,401,"application/json","{\"error\":\"请登录\"}".getBytes(StandardCharsets.UTF_8)));
        server.createContext("/api/file",request->{check(request.getRequestURI().getRawQuery().contains("%E6"),"encoded filename");reply(request,200,"application/octet-stream","文件内容\n".getBytes(StandardCharsets.UTF_8));});
        server.createContext("/api/large",request->{request.getResponseHeaders().set("Content-Type","application/octet-stream");request.sendResponseHeaders(200,ApiClient.MAX_FILE_BYTES+1L);request.close();});
        server.start();
        try {
            final String[] cookie={""};ApiClient client=new ApiClient(origin,new ApiClient.Cookies(){public String get(String url){return cookie[0];}public void set(String url,String value){check(url.equals(origin),"cookie origin");cookie[0]=value.split(";")[0];}});
            check("{}".equals(client.json("/api/login","{\"prompt\":\"创建测试文件\"}")),"login");check(client.json("/api/private",null).contains("true"),"private");
            check(client.upload("/api/upload?name="+URLEncoder.encode("中文.docx","UTF-8"),new byte[]{0,1,(byte)255,80,75}).contains("true"),"upload bytes and headers");
            File oversized=File.createTempFile("oversized-",".docx");
            try{try(RandomAccessFile data=new RandomAccessFile(oversized,"rw")){data.setLength(ApiClient.MAX_FILE_BYTES+1L);}try{client.upload("/api/upload",oversized);throw new AssertionError("large upload accepted");}catch(ApiClient.Failure expected){check(expected.status==413,"upload limit status");}}finally{java.nio.file.Files.deleteIfExists(oversized.toPath());}
            try{client.json("/api/redirect","{}");throw new AssertionError("redirect accepted");}catch(ApiClient.Failure error){check(error.verification,"redirect flag");}
            check(posts.get()==2&&redirected.get()==0,"no replay or redirect");
            try{client.json("/api/verification",null);throw new AssertionError("HTML accepted");}catch(ApiClient.Failure error){check(error.verification,"HTML flag");}
            try{client.json("/api/expired",null);throw new AssertionError("401 accepted");}catch(ApiClient.Failure error){check(error.status==401&&!error.verification&&error.getMessage().contains("请登录"),"401 classification");}
            check("文件内容\n".equals(client.download("/api/file?name="+URLEncoder.encode("测试.txt","UTF-8")).text()),"file bytes");
            try{client.download("/api/large");throw new AssertionError("unbounded file");}catch(IOException expected){}
            for(String bad:new String[]{"https://evil.example/api/test","//evil.example/api/test","/api/../admin","/api/test#fragment"}){try{client.json(bad,null);throw new AssertionError("foreign route allowed");}catch(IllegalArgumentException expected){}}
            for(String bad:new String[]{"http://evil.example","https://user@evil.example","https://evil.example/path"}){try{new ApiClient(bad,null);throw new AssertionError("unsafe origin allowed");}catch(IllegalArgumentException expected){}}
            System.out.println("Android transport: login, cookie, UTF8, headers, redirect/no replay, verification, expiry, downloads, limits and origin checks passed.");
        } finally {server.stop(0);}
    }
}
