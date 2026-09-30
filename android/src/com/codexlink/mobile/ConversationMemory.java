package com.codexlink.mobile;

import java.util.*;

/** Bounded in-memory history for this login only. Never written to disk or used for authorization. */
final class ConversationMemory {
    static final class Entry {
        String history="";
        int scrollY;
        boolean followTail=true;
    }
    private final LinkedHashMap<String,Entry> entries=new LinkedHashMap<>(16,.75f,true);
    private String account="";
    private static final int MAX_TASKS=12, MAX_CHARS=2*1024*1024;
    void account(String id){if(!account.equals(id)){entries.clear();account=id;}}
    Entry get(String task){return entries.get(task);}
    private Entry entry(String task){Entry value=entries.get(task);if(value==null){value=new Entry();entries.put(task,value);}return value;}
    void history(String task,String history){
        if(account.isEmpty())return;
        entry(task).history=history.length()<=MAX_CHARS?history:"";trim();
    }
    void position(String task,int y,boolean follow){if(account.isEmpty())return;Entry value=entry(task);value.scrollY=Math.max(0,y);value.followTail=follow;trim();}
    void remove(String task){entries.remove(task);}
    void retain(Set<String> visible){entries.keySet().retainAll(visible);}
    private void trim(){
        long chars=0;for(Entry value:entries.values())chars+=value.history.length();
        Iterator<Entry> oldest=entries.values().iterator();
        while((entries.size()>MAX_TASKS||chars>MAX_CHARS)&&oldest.hasNext()){chars-=oldest.next().history.length();oldest.remove();}
    }
}
