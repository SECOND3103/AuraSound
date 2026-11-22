package com.aurasound.app;

import android.util.JsonReader;
import android.util.JsonToken;
import android.util.JsonWriter;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

final class BackupMetadata {
    private static final String FORMAT = "AuraSoundBackup";
    private static final String MANIFEST = "manifest.json";
    private static final String JSON_SUFFIX = ".json";
    private static final List<String> ARRAY_KEYS = Arrays.asList("tracks", "playlists", "appState");
    private static final List<String> OBJECT_KEYS = Arrays.asList("artistCovers", "albumCovers", "albumTrackOrder");

    private BackupMetadata() {}

    static JSONObject withDefaults(JSONObject source) throws JSONException {
        JSONObject metadata = new JSONObject();
        for (String key : ARRAY_KEYS) {
            JSONArray value = source.optJSONArray(key);
            metadata.put(key, value == null ? new JSONArray() : value);
        }
        for (String key : OBJECT_KEYS) {
            JSONObject value = source.optJSONObject(key);
            metadata.put(key, value == null ? new JSONObject() : value);
        }
        return metadata;
    }

    static void write(ZipOutputStream zip, JSONObject metadata, String appVersion, int version) throws IOException, JSONException {
        JSONObject manifest = new JSONObject().put("format", FORMAT).put("version", version).put("appVersion", appVersion);
        writeEntry(zip, MANIFEST, manifest);
        for (String key : ARRAY_KEYS) writeEntry(zip, key + JSON_SUFFIX, metadata.getJSONArray(key));
        for (String key : OBJECT_KEYS) writeEntry(zip, key + JSON_SUFFIX, metadata.getJSONObject(key));
    }

    static boolean readEntry(ZipInputStream zip, String name, JSONObject metadata) throws IOException, JSONException {
        if (MANIFEST.equals(name)) {
            JSONObject manifest = readObject(zip);
            if (!FORMAT.equals(manifest.optString("format"))) {
                throw new IOException("AuraSound 백업 파일이 아닙니다.");
            }
            return true;
        }
        if (!name.endsWith(JSON_SUFFIX)) return false;
        String key = name.substring(0, name.length() - JSON_SUFFIX.length());
        if (ARRAY_KEYS.contains(key)) {
            JsonReader reader = entryReader(zip);
            metadata.put(key, readArray(reader));
            requireEnd(reader);
        } else if (OBJECT_KEYS.contains(key)) {
            metadata.put(key, readObject(zip));
        } else {
            return false;
        }
        return true;
    }

    private static void writeEntry(ZipOutputStream zip, String name, Object value) throws IOException, JSONException {
        zip.putNextEntry(new ZipEntry(name));
        // Flush each entry without closing the archive. Avoid a full JSON string and UTF-8 byte copy.
        JsonWriter writer = new JsonWriter(new BufferedWriter(new OutputStreamWriter(zip, StandardCharsets.UTF_8)));
        writeValue(writer, value);
        writer.flush();
        zip.closeEntry();
    }

    private static void writeValue(JsonWriter writer, Object value) throws IOException, JSONException {
        if (value == null || value == JSONObject.NULL) {
            writer.nullValue();
        } else if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            writer.beginObject();
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                writer.name(key);
                writeValue(writer, object.get(key));
            }
            writer.endObject();
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            writer.beginArray();
            for (int i = 0; i < array.length(); i++) writeValue(writer, array.get(i));
            writer.endArray();
        } else if (value instanceof Number) {
            writer.value((Number) value);
        } else if (value instanceof Boolean) {
            writer.value((Boolean) value);
        } else {
            writer.value(value.toString());
        }
    }

    private static JsonReader entryReader(ZipInputStream zip) {
        // ZipInputStream returns EOF at the end of this entry. The reader must not close the ZIP.
        return new JsonReader(new InputStreamReader(zip, StandardCharsets.UTF_8));
    }

    private static JSONObject readObject(ZipInputStream zip) throws IOException, JSONException {
        JsonReader reader = entryReader(zip);
        JSONObject object = readObject(reader);
        requireEnd(reader);
        return object;
    }

    private static JSONObject readObject(JsonReader reader) throws IOException, JSONException {
        JSONObject object = new JSONObject();
        reader.beginObject();
        while (reader.hasNext()) {
            String key = reader.nextName();
            object.put(key, readValue(reader));
        }
        reader.endObject();
        return object;
    }

    private static JSONArray readArray(JsonReader reader) throws IOException, JSONException {
        JSONArray array = new JSONArray();
        reader.beginArray();
        while (reader.hasNext()) array.put(readValue(reader));
        reader.endArray();
        return array;
    }

    private static Object readValue(JsonReader reader) throws IOException, JSONException {
        switch (reader.peek()) {
            case BEGIN_OBJECT:
                return readObject(reader);
            case BEGIN_ARRAY:
                return readArray(reader);
            case STRING:
                return reader.nextString();
            case NUMBER:
                return new JSONTokener(reader.nextString()).nextValue();
            case BOOLEAN:
                return reader.nextBoolean();
            case NULL:
                reader.nextNull();
                return JSONObject.NULL;
            default:
                throw new IOException("잘못된 백업 JSON 값입니다.");
        }
    }

    private static void requireEnd(JsonReader reader) throws IOException {
        if (reader.peek() != JsonToken.END_DOCUMENT) {
            throw new IOException("백업 JSON 뒤에 잘못된 데이터가 있습니다.");
        }
    }
}
