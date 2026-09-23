package com.codexlink.mobile;

import java.util.*;

/** UI-thread state, independent of the visible page. No credentials or disk persistence. */
final class AttachmentUploads<T> {
    static final class Draft<T> {
        String text="", skillId="", skillTitle="";
        final List<T> files=new ArrayList<>();
    }
    static final class Job<T> {
        final String account,taskId,projectId,taskName;
        final boolean alternatePicker;
        volatile boolean abandoned;
        boolean transferring,complete;
        T result;
        Exception error;
        Job(String account,String taskId,String projectId,String taskName,boolean alternatePicker){this.account=account;this.taskId=taskId;this.projectId=projectId;this.taskName=taskName;this.alternatePicker=alternatePicker;}
    }
    private String account="";
    private final Map<String,Draft<T>> drafts=new HashMap<>();
    private Job<T> active,outcome;
    void account(String id){
        if(account.equals(id))return;
        if(active!=null)active.abandoned=true;
        account=id;drafts.clear();active=null;outcome=null;
    }
    Draft<T> draft(String task){return drafts.computeIfAbsent(task,key->new Draft<>());}
    boolean hasDrafts(){for(Draft<T> draft:drafts.values())if(!draft.text.trim().isEmpty()||!draft.files.isEmpty()||!draft.skillId.isEmpty())return true;return false;}
    Job<T> active(){return active;}
    Job<T> notice(){return active!=null?active:outcome;}
    boolean uploading(String task){return active!=null&&active.taskId.equals(task);}
    Job<T> begin(String task,String project,String title,boolean alternate){
        if(account.isEmpty()||active!=null||draft(task).files.size()>=3)throw new IllegalStateException("Upload cannot start");
        active=new Job<>(account,task,project,title,alternate);outcome=null;return active;
    }
    boolean accepts(Job<T> job){return active==job&&!job.abandoned&&job.account.equals(account);}
    boolean finish(Job<T> job,T result,Exception error){
        if(!accepts(job))return false;
        if(error==null&&result==null)throw new IllegalArgumentException("Upload result missing");
        job.result=result;job.error=error;job.complete=true;active=null;outcome=job;
        if(error==null)draft(job.taskId).files.add(result);
        return true;
    }
    void acknowledge(String task){if(outcome!=null&&outcome.taskId.equals(task))outcome=null;}
    void retain(Set<String> visibleTasks){
        drafts.keySet().retainAll(visibleTasks);
        if(active!=null&&!visibleTasks.contains(active.taskId)){active.abandoned=true;active=null;}
        if(outcome!=null&&!visibleTasks.contains(outcome.taskId))outcome=null;
    }
}
