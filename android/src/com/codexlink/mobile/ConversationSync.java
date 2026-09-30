package com.codexlink.mobile;

/** UI-thread read scheduling. A stale read can never replace newer account/action state. */
final class ConversationSync {
    static final int OK=0, OFFLINE=1, VERIFICATION=2;
    static final class Read { final long revision; Read(long revision){this.revision=revision;} }
    private long revision, nextAt;
    private Read active;
    private int failures;
    private boolean repeat;
    private int connection=OFFLINE;
    void invalidate(){revision++;requestNow();}
    void requestNow(){nextAt=0;if(active!=null)repeat=true;}
    Read begin(long now){if(active!=null||now<nextAt)return null;active=new Read(revision);repeat=false;return active;}
    boolean accepts(Read read){return active==read&&read.revision==revision;}
    boolean finish(Read read,long now,int result){
        if(active!=read)return false;
        boolean current=accepts(read);active=null;
        if(current){connection=result;failures=result==OK?0:Math.min(failures+1,4);}
        nextAt=repeat||!current?0:now+(failures==0?4500:Math.min(30000,4500L<<(failures-1)));
        repeat=false;return current;
    }
    void disconnected(){connection=OFFLINE;invalidate();}
    void reset(){connection=OFFLINE;failures=0;invalidate();}
    boolean connected(){return connection==OK;}
    boolean verification(){return connection==VERIFICATION;}
    long delay(long now){return Math.max(0,nextAt-now);}
}
