package com.codexlink.mobile;

import java.net.URLEncoder;
import java.util.regex.*;
import java.io.*;
import java.security.MessageDigest;

/** Runs the APK's actual transport against the existing Node HTTP/Portal implementation. */
public final class ContractTest {
    static class Jar implements ApiClient.Cookies {
        String value="";
        public String get(String origin){return value;}
        public void set(String origin,String cookie){value=cookie.split(";")[0];}
    }
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static byte[] hash(File file)throws Exception{MessageDigest hash=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(file)){byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)hash.update(b,0,n);}return hash.digest();}
    static String id(String json){Matcher match=Pattern.compile("\"id\":\"([^\"]+)\"").matcher(json);if(!match.find())throw new AssertionError("id missing");return match.group(1);}
    static String filename(String json){Matcher match=Pattern.compile("\"name\":\"([^\"]+)\"").matcher(json);if(!match.find())throw new AssertionError("filename missing");return match.group(1);}
    static void denied(ApiClient client,String route,String payload,int status)throws Exception{try{client.json(route,payload);throw new AssertionError("access allowed: "+route);}catch(ApiClient.Failure failure){check(failure.status==status,"wrong denial status: "+failure.status);}}
    public static void main(String[] args)throws Exception{
        System.setProperty("sun.net.http.allowRestrictedHeaders","true");
        ApiClient owner=new ApiClient(args[0],new Jar()), viewer=new ApiClient(args[0],new Jar());
        check(owner.json("/api/auth",null).contains("\"setupRequired\":false"),"auth discovery");
        denied(owner,"/api/status",null,401);
        check(owner.json("/api/auth/login","{\"username\":\"android_owner\",\"password\":\"628415\"}").contains("android_owner"),"owner login");
        viewer.json("/api/auth/login","{\"username\":\"android_viewer\",\"password\":\"628415\"}");
        String project=owner.json("/api/projects","{\"name\":\"安卓接口测试\",\"level\":2}");String projectId=id(project);
        check(project.contains("\"shared\":false")&&project.contains("\"source\":\"mobile\""),"private mobile defaults");
        String task=owner.json("/api/tasks","{\"name\":\"创建文件\",\"projectId\":\""+projectId+"\"}");String taskId=id(task);
        check(task.contains("\"canExecute\":true"),"owner can execute");
        byte[] word=java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(args[1])),slides=java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(args[2]));
        String wordName=OfficeAttachment.filename(new File(args[1])," 中文说明.docx\u200b "),pptName=OfficeAttachment.filename(new File(args[2]),"演示文稿");
        String attachment=filename(owner.upload("/api/tasks/"+taskId+"/attachments?name="+URLEncoder.encode(wordName,"UTF-8"),word));
        String presentation=filename(owner.upload("/api/tasks/"+taskId+"/attachments?name="+URLEncoder.encode(pptName,"UTF-8"),slides));
        check(java.util.Arrays.equals(owner.download("/api/tasks/"+taskId+"/file?name="+URLEncoder.encode(attachment,"UTF-8")).bytes,word),"uploaded Word exact download");
        File large=new File(args[3]),download=File.createTempFile("contract-large-",".pptx");
        check(large.length()==ApiClient.MAX_FILE_BYTES,"actual 100 MiB Office fixture");
        String largeName=OfficeAttachment.filename(large,"100MB演示");
        String largeRef=filename(owner.upload("/api/tasks/"+taskId+"/attachments?name="+URLEncoder.encode(largeName,"UTF-8"),large));
        try{owner.download("/api/tasks/"+taskId+"/file?name="+URLEncoder.encode(largeRef,"UTF-8"),download);check(java.util.Arrays.equals(hash(large),hash(download)),"100 MiB Office upload/download SHA256");}finally{java.nio.file.Files.deleteIfExists(download.toPath());}
        check(owner.json("/api/tasks/"+taskId+"/send","{\"prompt\":\"创建测试文件\",\"attachments\":[\""+attachment+"\",\""+presentation+"\",\""+largeRef+"\"]}").contains("turnId"),"send with Word and 100 MiB PPT contract");
        check(owner.json("/api/history/"+taskId,null).contains("文件已创建"),"history contract");
        check(owner.json("/api/tasks/"+taskId+"/files",null).contains("中文成果.txt"),"files contract");
        String fileRoute="/api/tasks/"+taskId+"/file?name="+URLEncoder.encode("中文成果.txt","UTF-8");
        check(owner.download(fileRoute).text().equals("ANDROID-CONTRACT-OK\n"),"exact download bytes");
        check(viewer.json("/api/status",null).contains("\"projects\":[]"),"private hidden");denied(viewer,"/api/history/"+taskId,null,404);
        owner.json("/api/projects/"+projectId,"{\"shared\":true}");check(viewer.json("/api/status",null).contains("\"projects\":[]"),"high level hidden");
        owner.json("/api/projects/"+projectId,"{\"level\":1}");String visible=viewer.json("/api/status",null);check(visible.contains(projectId)&&visible.contains("\"canExecute\":false"),"shared read only");
        check(viewer.download(fileRoute).text().equals("ANDROID-CONTRACT-OK\n"),"eligible download");denied(viewer,"/api/tasks/"+taskId+"/send","{\"prompt\":\"forbidden\"}",403);
        String removeRoute="/api/projects/"+projectId+"/remove", confirmation="{\"confirmName\":\"安卓接口测试\"}";
        denied(viewer,removeRoute,confirmation,403);
        owner.json("/api/projects/"+projectId,"{\"shared\":false}");denied(viewer,fileRoute,null,404);
        denied(owner,removeRoute,"{\"confirmName\":\"过期项目名\"}",409);
        String removed=owner.json(removeRoute,confirmation);check(removed.contains("\"removed\":true")&&removed.contains("\"filesKept\":true")&&removed.contains("\"removedTasks\":1"),"remove project contract");
        check(owner.json("/api/status",null).contains("\"projects\":[]"),"removed project disappears");
        denied(owner,"/api/history/"+taskId,null,404);denied(owner,fileRoute,null,404);denied(owner,removeRoute,confirmation,404);
        ApiClient secondSession=new ApiClient(args[0],new Jar());secondSession.json("/api/auth/login","{\"username\":\"android_owner\",\"password\":\"628415\"}");
        denied(owner,"/api/auth/password","{\"currentPassword\":\"000000\",\"password\":\"714826\"}",403);
        denied(owner,"/api/auth/password","{\"currentPassword\":\"628415\",\"password\":\"12345\"}",400);
        check(owner.json("/api/status",null).contains("android_owner"),"failed password change preserves session");
        check(owner.json("/api/auth/password","{\"currentPassword\":\"628415\",\"password\":\"714826\"}").contains("\"changed\":true"),"password change");
        denied(owner,"/api/status",null,401);denied(secondSession,"/api/status",null,401);
        denied(owner,"/api/auth/login","{\"username\":\"android_owner\",\"password\":\"628415\"}",401);
        check(owner.json("/api/auth/login","{\"username\":\"android_owner\",\"password\":\"714826\"}").contains("android_owner"),"login with new six-character password");
        owner.json("/api/auth/logout","{}");denied(owner,"/api/status",null,401);
        System.out.println("Android / existing HTTP contract: login, project, task, send, history, UTF8 download, private, shared levels, readonly, removal, password change, all-session revocation and logout passed.");
    }
}
