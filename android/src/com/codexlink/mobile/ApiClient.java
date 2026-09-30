package com.codexlink.mobile;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Single-origin transport. Never follows a redirect or retries a submitted instruction. */
public final class ApiClient {
    public static final String ORIGIN = "https://codexlink.example.invalid";
    public static final int MAX_FILE_BYTES = 100 * 1024 * 1024;
    public static final String FILE_LIMIT_LABEL = "100 MB";
    public interface Progress { void transferred(long bytes, long total) throws IOException; }
    public interface Cookies { String get(String url); void set(String url, String cookie) throws IOException; }
    public static class Failure extends IOException {
        public final int status;
        public final boolean verification;
        public Failure(int status, String message, boolean verification) { super(message); this.status = status; this.verification = verification; }
    }
    public static final class Reply {
        public final byte[] bytes;
        public final String contentType;
        Reply(byte[] bytes, String contentType) { this.bytes = bytes; this.contentType = contentType; }
        public String text() { return new String(bytes, StandardCharsets.UTF_8); }
    }
    private final String origin;
    private final Cookies cookies;
    private final int readTimeout;
    public ApiClient(String origin, Cookies cookies) {
        this(origin,cookies,45000);
    }
    ApiClient(String origin, Cookies cookies, int readTimeout) {
        URI uri = URI.create(origin);
        boolean loopback = "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost());
        if ((!"https".equals(uri.getScheme()) && !loopback) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null || !"".equals(uri.getRawPath())) throw new IllegalArgumentException("Invalid origin");
        this.origin = origin; this.cookies = cookies; this.readTimeout=readTimeout;
    }
    public String json(String path, String payload) throws IOException {
        byte[] bytes = payload == null ? null : payload.getBytes(StandardCharsets.UTF_8);
        return request(path, bytes == null ? null : new ByteArrayInputStream(bytes), bytes == null ? 0 : bytes.length, "application/json", false, null).text();
    }
    public String upload(String path, byte[] payload) throws IOException {
        checkUploadSize(payload == null ? 0 : payload.length);
        return request(path, new ByteArrayInputStream(payload), payload.length, "application/octet-stream", false, null).text();
    }
    public String upload(String path, File file) throws IOException {
        long size = file.length(); checkUploadSize(size);
        try (InputStream input = new FileInputStream(file)) { return request(path, input, size, "application/octet-stream", false, null).text(); }
    }
    private static void checkUploadSize(long size) throws IOException {
        if (size <= 0) throw new Failure(400, "{\"error\":\"附件内容为空\"}", false);
        if (size > MAX_FILE_BYTES) throw fileTooLarge();
    }
    private static Failure fileTooLarge() { return new Failure(413, "{\"error\":\"单个文件不能超过 " + FILE_LIMIT_LABEL + "\"}", false); }
    // In-memory replies are for small callers; the Android UI uses the file overload.
    public Reply download(String path) throws IOException { return request(path, null, 0, null, true, null); }
    public void download(String path, File target) throws IOException {
        boolean complete = false;
        try { request(path, null, 0, null, true, target); complete = true; }
        finally { if (!complete) java.nio.file.Files.deleteIfExists(target.toPath()); }
    }
    public String release() throws IOException { return request("/downloads/release.json", null, 0, null, false, null).text(); }
    public void downloadUpdate(String filename, File target, Progress progress) throws IOException {
        if (!filename.matches("CodexLink-[0-9]+\\.[0-9]+\\.[0-9]+\\.apk")) throw new IllegalArgumentException("Invalid update filename");
        boolean complete = false;
        try { request("/downloads/" + filename, null, 0, null, true, target, progress); complete = true; }
        finally { if (!complete) java.nio.file.Files.deleteIfExists(target.toPath()); }
    }
    public static long copyFile(InputStream input, OutputStream output) throws IOException { return copy(input, output, MAX_FILE_BYTES); }
    private static long copy(InputStream input, OutputStream output, long limit) throws IOException {
        byte[] buffer = new byte[64 * 1024]; long size = 0; int count;
        while ((count = input.read(buffer)) != -1) {
            size += count;
            if (size > limit) throw fileTooLarge();
            output.write(buffer, 0, count);
        }
        return size;
    }
    private Reply request(String path, InputStream payload, long payloadLength, String contentType, boolean binary, File targetFile) throws IOException {
        return request(path, payload, payloadLength, contentType, binary, targetFile, null);
    }
    private Reply request(String path, InputStream payload, long payloadLength, String contentType, boolean binary, File targetFile, Progress progress) throws IOException {
        URI target = URI.create(origin).resolve(path);
        boolean metadata = path.equals("/downloads/release.json") && payload == null && !binary;
        boolean apk = path.matches("/downloads/CodexLink-[0-9]+\\.[0-9]+\\.[0-9]+\\.apk") && payload == null && binary && targetFile != null;
        if (!(metadata || apk || path.startsWith("/api/")) || path.contains("\\") || path.contains("#") || !target.toString().startsWith(origin + "/") || target.getRawPath().contains("..")) throw new IllegalArgumentException("Invalid API path");
        HttpURLConnection connection = (HttpURLConnection) target.toURL().openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(12000); connection.setReadTimeout(binary || "application/octet-stream".equals(contentType) ? 120000 : readTimeout);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", apk ? "application/vnd.android.package-archive" : binary ? "application/octet-stream" : "application/json");
            connection.setRequestProperty("Origin", origin);
            connection.setRequestProperty("X-Local-Client", "1");
            String cookie = cookies.get(origin);
            if (cookie != null && !cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
            if (payload != null) {
                connection.setRequestMethod("POST"); connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", contentType);
                // Fixed length disables HttpURLConnection's authentication/redirect replay.
                connection.setFixedLengthStreamingMode(payloadLength);
                try (OutputStream out = connection.getOutputStream()) {
                    if (copy(payload, out, payloadLength) != payloadLength) throw new IOException("上传文件读取不完整");
                }
            }
            int status = connection.getResponseCode();
            String type = Optional.ofNullable(connection.getContentType()).orElse("").toLowerCase(Locale.ROOT);
            if (status >= 300 && status < 400 || type.contains("text/html")) throw new Failure(status, "连接需要 DDNSTO 验证", true);
            for (Map.Entry<String,List<String>> header : connection.getHeaderFields().entrySet()) {
                if ("Set-Cookie".equalsIgnoreCase(header.getKey())) for (String value : header.getValue()) cookies.set(origin, value);
            }
            if (status >= 400) {
                try (InputStream in = connection.getErrorStream()) { throw new Failure(status, new String(readBounded(in, 16 * 1024 * 1024), StandardCharsets.UTF_8), false); }
            }
            if (status < 200 || status >= 300) throw new Failure(status, "连接返回了未知状态", false);
            if (!(apk ? type.startsWith("application/vnd.android.package-archive") : binary ? type.startsWith("application/octet-stream") : type.startsWith("application/json"))) throw new Failure(status, "连接未返回预期内容，请检查验证状态", true);
            long expected = connection.getContentLengthLong();
            if (binary && expected > MAX_FILE_BYTES) throw fileTooLarge();
            if (targetFile != null) {
                try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(targetFile)) {
                    long received = 0; byte[] buffer = new byte[64 * 1024]; int count;
                    while ((count = in.read(buffer)) != -1) {
                        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("下载已取消");
                        received += count; if (received > MAX_FILE_BYTES) throw fileTooLarge();
                        if (progress != null) progress.transferred(received, expected);
                        out.write(buffer, 0, count);
                    }
                    if (expected >= 0 && received != expected) throw new IOException("文件下载不完整，请重新下载");
                }
                return new Reply(new byte[0], type);
            }
            byte[] data;
            try (InputStream in = connection.getInputStream()) { data = readBounded(in, metadata ? 32 * 1024 : binary ? MAX_FILE_BYTES : 16 * 1024 * 1024); }
            if (expected >= 0 && data.length != expected) throw new IOException("返回内容不完整");
            return new Reply(data, type);
        } finally { connection.disconnect(); }
    }
    private static byte[] readBounded(InputStream input, int limit) throws IOException {
        if (input == null) return new byte[0];
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
        while ((count = input.read(buffer)) != -1) {
            if (out.size() + count > limit) throw new IOException("返回内容过大，请在电脑上查看");
            out.write(buffer, 0, count);
        }
        return out.toByteArray();
    }
}
