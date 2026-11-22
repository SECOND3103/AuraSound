package com.aurasound.app;

import static org.junit.Assert.*;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class BackupMetadataTest {
    @Test
    public void roundTripLargeSingleCoverAndFollowingAudio() throws Exception {
        String cover = text(17 * 1024 * 1024);
        JSONObject source = new JSONObject().put("albumCovers", new JSONObject().put("앨범", cover));
        JSONObject restored = roundTrip(source, 2);
        assertEquals(cover, restored.getJSONObject("albumCovers").getString("앨범"));
    }

    @Test
    public void roundTripManyCoversLargerThanOldEntryLimit() throws Exception {
        JSONObject covers = new JSONObject();
        String cover = text(16 * 1024);
        for (int i = 0; i < 1100; i++) covers.put("album-" + i, cover);
        JSONObject restored = roundTrip(new JSONObject().put("albumCovers", covers), 1);
        JSONObject actual = restored.getJSONObject("albumCovers");
        assertEquals(1100, actual.length());
        for (int i = 0; i < 1100; i++) assertEquals(cover, actual.getString("album-" + i));
    }

    @Test
    public void readsOversizedBackupWrittenByPreviousExporter() throws Exception {
        String cover = text(17 * 1024 * 1024);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(output)) {
            writeLegacy(zip, "manifest.json", "{\"format\":\"AuraSoundBackup\",\"version\":1,\"appVersion\":\"1.0.2\"}");
            writeLegacy(zip, "albumCovers.json", new JSONObject().put("legacy", cover).toString());
        }
        JSONObject restored = read(output.toByteArray(), false);
        assertEquals(cover, restored.getJSONObject("albumCovers").getString("legacy"));
        assertEquals(0, restored.getJSONArray("tracks").length());
    }

    @Test
    public void preservesNestedTypesOrderAndUnicode() throws Exception {
        JSONObject settings = new JSONObject()
                .put("key", "settings").put("value", new JSONArray()
                        .put(JSONObject.NULL).put(false).put(0).put(123.456)
                        .put(9007199254740991L).put("00123").put("음악🎵\n\t\\\""));
        JSONObject source = new JSONObject()
                .put("tracks", new JSONArray().put(new JSONObject().put("id", "a")))
                .put("appState", new JSONArray().put(settings))
                .put("albumTrackOrder", new JSONObject().put("앨범", new JSONArray().put("b").put("a").put("b")));
        JSONObject restored = roundTrip(source, 1);
        JSONArray values = restored.getJSONArray("appState").getJSONObject(0).getJSONArray("value");
        assertTrue(values.isNull(0));
        assertEquals(Boolean.FALSE, values.get(1));
        assertEquals(0, values.getInt(2));
        assertEquals(123.456, values.getDouble(3), 0);
        assertEquals(9007199254740991L, values.getLong(4));
        assertEquals("00123", values.get(5));
        assertEquals("음악🎵\n\t\\\"", values.getString(6));
        assertEquals("[\"b\",\"a\",\"b\"]", restored.getJSONObject("albumTrackOrder").getJSONArray("앨범").toString());
        assertEquals(0, restored.getJSONObject("artistCovers").length());
    }

    @Test
    public void rejectsTruncatedOrTrailingJson() throws Exception {
        for (String invalid : new String[]{"{\"cover\":", "{}{}"}) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (ZipOutputStream zip = new ZipOutputStream(output)) {
                writeLegacy(zip, "albumCovers.json", invalid);
            }
            try {
                read(output.toByteArray(), false);
                fail("Invalid backup JSON was accepted");
            } catch (IOException | IllegalStateException expected) {
                // Malformed JSON must fail rather than silently restoring partial data.
            }
        }
    }

    private static JSONObject roundTrip(JSONObject source, int version) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(output)) {
            BackupMetadata.write(zip, BackupMetadata.withDefaults(source), "1.0.3", version);
            zip.putNextEntry(new ZipEntry("music/audio.mp3"));
            zip.write(new byte[]{0, 1, 2, 3});
            zip.closeEntry();
        }
        return read(output.toByteArray(), true);
    }

    private static JSONObject read(byte[] bytes, boolean expectAudio) throws Exception {
        JSONObject metadata = BackupMetadata.withDefaults(new JSONObject());
        boolean audioFound = false;
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(bytes))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (!BackupMetadata.readEntry(zip, entry.getName(), metadata)) {
                    assertEquals("music/audio.mp3", entry.getName());
                    byte[] audio = new byte[4];
                    int total = 0;
                    int count;
                    while (total < audio.length && (count = zip.read(audio, total, audio.length - total)) != -1) total += count;
                    assertEquals(4, total);
                    assertArrayEquals(new byte[]{0, 1, 2, 3}, audio);
                    audioFound = true;
                }
                zip.closeEntry();
            }
        }
        assertEquals(expectAudio, audioFound);
        return metadata;
    }

    private static String text(int size) {
        char[] chars = new char[size];
        Arrays.fill(chars, 'A');
        return new String(chars);
    }

    private static void writeLegacy(ZipOutputStream zip, String name, String json) throws IOException {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(json.getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
    }
}
