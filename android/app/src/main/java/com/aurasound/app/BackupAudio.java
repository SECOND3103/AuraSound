package com.aurasound.app;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

final class BackupAudio {
    private BackupAudio() {}

    static Map<String, File> uniqueEntries(Map<JSONObject, File> sources) throws IOException, JSONException, NoSuchAlgorithmException {
        Map<Long, Integer> filesBySize = new HashMap<>();
        for (File file : new HashSet<>(sources.values())) filesBySize.merge(file.length(), 1, Integer::sum);

        Map<String, File> entries = new LinkedHashMap<>();
        Map<File, String> entryByFile = new HashMap<>();
        Map<ByteBuffer, String> entryByDigest = new HashMap<>();
        MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[65536];
        for (Map.Entry<JSONObject, File> source : sources.entrySet()) {
            JSONObject track = source.getKey();
            File file = source.getValue();
            String name = entryByFile.get(file);
            if (name == null) {
                name = track.getString("backupFile");
                String duplicate = null;
                if (filesBySize.getOrDefault(file.length(), 0) > 1) {
                    ByteBuffer digest = digest(file, sha256, buffer);
                    duplicate = entryByDigest.putIfAbsent(digest, name);
                }
                if (duplicate != null) {
                    name = duplicate;
                } else if (entries.putIfAbsent(name, file) != null) {
                    throw new IOException("백업에 같은 파일 이름이 있습니다: " + name);
                }
                entryByFile.put(file, name);
            }
            track.put("backupFile", name);
        }
        return entries;
    }

    private static ByteBuffer digest(File file, MessageDigest sha256, byte[] buffer) throws IOException {
        try (FileInputStream input = new FileInputStream(file)) {
            int read;
            while ((read = input.read(buffer)) != -1) sha256.update(buffer, 0, read);
        }
        return ByteBuffer.wrap(sha256.digest());
    }

    static void copy(InputStream input, OutputStream output, byte[] buffer) throws IOException {
        int read;
        while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
    }

    static boolean restore(File extracted, File destination, boolean shared, byte[] buffer) throws IOException {
        if (!shared) return extracted.renameTo(destination);

        // Preserve the shared ZIP entry until every track has its own file.
        File copy = File.createTempFile(".shared-audio-", ".part", extracted.getParentFile());
        try {
            try (FileInputStream input = new FileInputStream(extracted);
                 FileOutputStream output = new FileOutputStream(copy)) {
                copy(input, output, buffer);
            }
            return copy.renameTo(destination);
        } finally {
            copy.delete();
        }
    }
}
