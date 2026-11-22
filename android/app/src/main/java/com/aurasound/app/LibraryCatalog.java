package com.aurasound.app;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.database.sqlite.SQLiteStatement;
import android.webkit.JavascriptInterface;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** The Android library is independent of the WebView's origin and storage quota. */
public final class LibraryCatalog extends SQLiteOpenHelper {
    LibraryCatalog(Context context) {
        super(context.getApplicationContext(), "library.db", null, 1);
    }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE records (store TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(store,id))");
        db.execSQL("CREATE TABLE migration (complete INTEGER PRIMARY KEY)");
    }

    @Override public void onUpgrade(SQLiteDatabase db, int from, int to) {
        throw new IllegalStateException("Unsupported library version");
    }

    @JavascriptInterface public boolean isInitialized() {
        try (Cursor rows = getReadableDatabase().rawQuery("SELECT complete FROM migration", null)) {
            return rows.moveToFirst();
        }
    }

    @JavascriptInterface public void finishMigration() {
        getWritableDatabase().execSQL("INSERT OR IGNORE INTO migration VALUES (1)");
    }

    @JavascriptInterface public String keys(String store) {
        JSONArray keys = new JSONArray();
        try (Cursor rows = getReadableDatabase().rawQuery("SELECT id FROM records WHERE store=? ORDER BY id", new String[]{store})) {
            while (rows.moveToNext()) keys.put(rows.getString(0));
        }
        return keys.toString();
    }

    @JavascriptInterface public String readRecord(String store, String id) {
        // A cover or saved queue can exceed the size of an Android CursorWindow.
        try (SQLiteStatement query = getReadableDatabase().compileStatement("SELECT value FROM records WHERE store=? AND id=?")) {
            query.bindString(1, store);
            query.bindString(2, id);
            try {
                return query.simpleQueryForString();
            } catch (android.database.sqlite.SQLiteDoneException missing) {
                return null;
            }
        }
    }

    @JavascriptInterface public void putRecords(String store, String json) throws JSONException {
        SQLiteDatabase db = getWritableDatabase();
        JSONArray records = new JSONArray(json);
        db.beginTransaction();
        try (SQLiteStatement insert = db.compileStatement("INSERT OR REPLACE INTO records(store,id,value) VALUES(?,?,?)")) {
            insert.bindString(1, store);
            for (int i = 0; i < records.length(); i++) {
                JSONObject record = records.getJSONObject(i);
                insert.bindString(2, record.getString("appState".equals(store) ? "key" : "id"));
                insert.bindString(3, record.toString());
                insert.execute();
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    @JavascriptInterface public void removeRecord(String store, String id) {
        getWritableDatabase().delete("records", "store=? AND id=?", new String[]{store, id});
    }

    @JavascriptInterface public void clearRecords() {
        // Keep the migration marker so an intentional reset cannot reimport old records.
        getWritableDatabase().delete("records", null, null);
    }
}
