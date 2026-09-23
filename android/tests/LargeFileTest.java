package com.codexlink.mobile;

import com.sun.net.httpserver.*;
import java.io.*;
import java.net.*;
import java.nio.file.Files;
import java.util.Arrays;
import java.security.MessageDigest;

/** Run with -Xmx32m: a 100 MiB transfer must not require a file-sized heap buffer. */
public final class LargeFileTest {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static byte[] hash(File file)throws Exception{
        MessageDigest digest=MessageDigest.getInstance("SHA-256");byte[] buffer=new byte[65536];int n;
        try(InputStream in=new FileInputStream(file)){while((n=in.read(buffer))!=-1)digest.update(buffer,0,n);}return digest.digest();
    }
    static void stream(HttpExchange request,long length,boolean chunked)throws IOException{
        request.getResponseHeaders().set("Content-Type","application/octet-stream");request.sendResponseHeaders(200,chunked?0:length);
        try(OutputStream out=request.getResponseBody()){byte[] buffer=new byte[65536];for(long sent=0;sent<length;){int n=(int)Math.min(buffer.length,length-sent);out.write(buffer,0,n);sent+=n;}}
        catch(IOException expected){}finally{request.close();}
    }
    public static void main(String[] args)throws Exception{
        File upload=File.createTempFile("large-upload-",".pptx"),download=File.createTempFile("large-download-",".tmp");
        HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        try{
            try(RandomAccessFile file=new RandomAccessFile(upload,"rw")){file.setLength(ApiClient.MAX_FILE_BYTES);}
            byte[] expected=hash(upload);
            server.createContext("/api/upload",request->{
                try{
                    MessageDigest digest=MessageDigest.getInstance("SHA-256");long size=0;int n;byte[] buffer=new byte[65536];
                    try(InputStream in=request.getRequestBody()){while((n=in.read(buffer))!=-1){size+=n;digest.update(buffer,0,n);}}
                    check(size==ApiClient.MAX_FILE_BYTES,"exact upload length");check(Arrays.equals(expected,digest.digest()),"upload hash");
                    byte[] response="{}".getBytes("UTF-8");request.getResponseHeaders().set("Content-Type","application/json");request.sendResponseHeaders(201,response.length);request.getResponseBody().write(response);
                }catch(Exception error){throw new RuntimeException(error);}finally{request.close();}
            });
            server.createContext("/api/file",request->stream(request,ApiClient.MAX_FILE_BYTES,false));
            server.createContext("/api/chunked",request->stream(request,ApiClient.MAX_FILE_BYTES,true));
            server.createContext("/api/oversized",request->stream(request,ApiClient.MAX_FILE_BYTES+1L,true));
            server.createContext("/api/truncated",request->{request.getResponseHeaders().set("Content-Type","application/octet-stream");request.sendResponseHeaders(200,12345);request.getResponseBody().write(new byte[2]);request.close();});
            server.start();
            ApiClient client=new ApiClient("http://127.0.0.1:"+server.getAddress().getPort(),new ApiClient.Cookies(){public String get(String url){return "";}public void set(String url,String cookie){}});
            check(client.upload("/api/upload",upload).equals("{}"),"100 MiB upload");
            for(String route:new String[]{"/api/file","/api/chunked"}){client.download(route,download);check(download.length()==ApiClient.MAX_FILE_BYTES,"100 MiB download");check(Arrays.equals(expected,hash(download)),"download hash");}
            try{client.download("/api/oversized",download);throw new AssertionError("oversized chunk accepted");}catch(ApiClient.Failure error){check(error.status==413,"oversize status");}check(!download.exists(),"oversize partial removed");
            try{client.download("/api/truncated",download);throw new AssertionError("truncated download accepted");}catch(IOException expectedError){}check(!download.exists(),"truncated partial removed");
            try(InputStream in=new SequenceInputStream(new FileInputStream(upload),new ByteArrayInputStream(new byte[]{1}));OutputStream sink=new OutputStream(){public void write(int b){}public void write(byte[] b,int off,int len){}}){
                try{ApiClient.copyFile(in,sink);throw new AssertionError("unknown-size source accepted beyond limit");}catch(ApiClient.Failure error){check(error.status==413,"unknown source size");}
            }
            System.out.println("100 MiB streaming upload/download/hash, chunked limits, incomplete cleanup and unknown-size source passed with 32 MiB heap.");
        }finally{server.stop(0);Files.deleteIfExists(upload.toPath());Files.deleteIfExists(download.toPath());}
    }
}
