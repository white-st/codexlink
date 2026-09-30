package com.codexlink.mobile;

import java.util.*;

public final class ConversationSyncTest {
    private static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    public static void main(String[] args){
        ConversationSync sync=new ConversationSync();
        ConversationSync.Read old=sync.begin(10);
        check(sync.begin(11)==null,"Only one background read, even after repeated resume/network events");
        sync.requestNow();sync.requestNow();
        check(sync.finish(old,100,ConversationSync.OK),"Current reply accepted");
        check(sync.connected()&&sync.delay(100)==0,"Coalesced foreground request runs after in-flight read");
        old=sync.begin(100);sync.invalidate();
        check(!sync.finish(old,150,ConversationSync.OFFLINE),"A pre-send stale failure cannot overwrite the new action");
        check(sync.connected(),"Stale failure cannot claim disconnected");
        old=sync.begin(150);sync.reset();
        check(!sync.finish(old,160,ConversationSync.OK)&&!sync.connected(),"Logout rejects prior successful history");
        long now=200;long[] delays={4500,9000,18000,30000,30000};
        for(long delay:delays){ConversationSync.Read read=sync.begin(now);check(read!=null,"Retry is due");sync.finish(read,now,ConversationSync.OFFLINE);check(sync.delay(now)==delay,"Bounded failure backoff");check(sync.begin(now+delay-1)==null,"No busy retry loop");now+=delay;}
        sync.requestNow();old=sync.begin(now);sync.finish(old,now,ConversationSync.VERIFICATION);
        check(sync.verification()&&!sync.connected(),"DDNSTO verification is distinct from success");
        sync.requestNow();old=sync.begin(now);sync.finish(old,now,ConversationSync.OK);
        check(sync.connected()&&sync.delay(now)==4500,"Success restores normal refresh cadence");
        check(!sync.finish(old,now,ConversationSync.OFFLINE),"Duplicate callback cannot change connection state");

        ConversationMemory memory=new ConversationMemory();memory.account("alice");
        memory.history("a","private history");memory.position("a",350,false);
        memory.history("b","other task");
        check(memory.get("a").scrollY==350&&!memory.get("a").followTail,"Revisit preserves reading position");
        memory.retain(Collections.singleton("b"));check(memory.get("a")==null,"Revoked history immediately evicted");
        memory.account("bob");check(memory.get("b")==null,"Account switch cannot disclose history");
        memory.history("b","new account");memory.account("");memory.account("bob");check(memory.get("b")==null,"Same-account relogin starts empty");
        for(int i=0;i<13;i++)memory.history("t"+i,"history");check(memory.get("t0")==null&&memory.get("t12")!=null,"Recent task cache has fixed capacity");
        memory.account("");memory.account("alice");
        char[] meg=new char[1024*1024];Arrays.fill(meg,'x');String large=new String(meg);
        memory.history("one",large);memory.history("two",large);memory.get("one");memory.history("three","new");
        check(memory.get("one")!=null&&memory.get("two")==null,"Memory budget evicts least recently used history");
        memory.history("huge",large+large+"x");check(memory.get("huge").history.isEmpty(),"Oversized history not retained in cache");
        System.out.println("Conversation recovery: stale reads, logout, coalescing, backoff, verification, bounded account/task history and reading positions passed.");
    }
}
