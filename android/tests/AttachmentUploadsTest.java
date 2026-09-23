package com.codexlink.mobile;

import java.io.IOException;
import java.util.*;

public final class AttachmentUploadsTest {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args){
        AttachmentUploads<String> state=new AttachmentUploads<>();state.account("alice");
        state.draft("task-a").skillId="word";state.draft("task-a").skillTitle="Word 文档";
        check(state.hasDrafts(),"Skill-only selection defers updating and survives navigation");
        check(state.draft("task-b").skillId.isEmpty(),"Skill does not leak to another task");
        state.draft("task-a").text="原任务草稿";state.draft("task-a").files.add("existing.docx");
        AttachmentUploads.Job<String> first=state.begin("task-a","project-a","原任务",false);
        state.draft("task-b").text="另一个任务";
        check(state.uploading("task-a")&&!state.uploading("task-b"),"Only origin send is waiting for upload");
        try{state.begin("task-b","project-b","另一任务",false);throw new AssertionError("Parallel upload should be refused");}catch(IllegalStateException expected){}
        check(state.finish(first,"uploaded.pptx",null),"Completion accepted after navigating elsewhere");
        check(state.draft("task-a").files.equals(Arrays.asList("existing.docx","uploaded.pptx")),"Upload returned to origin draft");
        check(state.draft("task-b").files.isEmpty(),"New visible task receives no attachment");
        check(state.draft("task-a").text.equals("原任务草稿"),"Origin text draft preserved");
        check(state.draft("task-a").skillId.equals("word"),"Upload/navigation preserve origin skill");
        check(state.hasDrafts(),"Offscreen draft defers installing app update");
        check(!state.finish(first,"duplicate.pptx",null),"Callback cannot duplicate attachment");
        state.acknowledge("task-b");check(state.notice()==first,"Other task cannot dismiss outcome");state.acknowledge("task-a");check(state.notice()==null,"Origin acknowledgement");
        AttachmentUploads.Job<String> failed=state.begin("task-a","project-a","原任务",true);IOException error=new IOException("offline");state.finish(failed,null,error);
        check(state.notice().error==error&&state.draft("task-a").files.size()==2,"Failure retained with correct task, no ghost file");
        AttachmentUploads.Job<String> old=state.begin("task-a","project-a","原任务",false);state.account("");state.account("bob");
        check(old.abandoned&&!state.finish(old,"private-file.pptx",null),"Logout/switch drops old completion");check(state.draft("task-a").files.isEmpty()&&state.draft("task-a").text.isEmpty(),"Other account has no previous draft");
        check(!state.hasDrafts(),"Account change clears update deferral");
        check(state.draft("task-a").skillId.isEmpty(),"Account change clears skill selection");
        state.draft("task-a").skillId="pdf";state.retain(Collections.singleton("task-b"));check(state.draft("task-a").skillId.isEmpty(),"Revocation removes skill draft");
        AttachmentUploads.Job<String> removed=state.begin("task-a","project-a","原任务",false);state.retain(Collections.singleton("task-b"));
        check(removed.abandoned&&!state.finish(removed,"revoked.pptx",null),"Task removal/revocation drops completion");
        state.account("alice");AttachmentUploads.Job<String> session=state.begin("task-a","project-a","原任务",false);state.account("");state.account("alice");
        check(!state.finish(session,"old-session.pptx",null),"Relogin with same account does not revive old job");
        state.draft("task-a").files.addAll(Arrays.asList("1","2","3"));try{state.begin("task-a","p","full",false);throw new AssertionError("Fourth attachment accepted");}catch(IllegalStateException expected){}
        System.out.println("Upload state: navigation, origin-only completion, text/files retained, single upload, duplicate callback, errors, logout/account switch/relogin, revocation and three-file limit passed.");
    }
}
