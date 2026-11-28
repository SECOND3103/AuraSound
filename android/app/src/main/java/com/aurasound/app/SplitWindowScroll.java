package com.aurasound.app;

import android.app.Activity;
import android.view.MotionEvent;
import android.view.VelocityTracker;
import android.view.View;
import android.view.ViewConfiguration;
import android.webkit.WebView;

/** Keeps a split-window drag alive if WebView loses its touch sequence during a focus change. */
final class SplitWindowScroll implements View.OnTouchListener {
    private final Activity activity;
    private final WebView web;
    private final ViewConfiguration config;
    private boolean topResumed = true;
    private boolean afterBlur, touching, probing, captured, startedDragging;
    private int sequence, axes, axis;
    private float downX, downY, startX, startY, lastX, lastY;
    private VelocityTracker velocity;

    SplitWindowScroll(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        config = ViewConfiguration.get(activity);
    }

    void topResumedChanged(boolean active) {
        topResumed = active;
        if (!active) lostInteraction();
    }

    void lostInteraction() {
        if (!activity.isInMultiWindowMode()) return;
        afterBlur = true;
        if (touching && !probing) begin(lastX, lastY);
    }

    private void begin(float x, float y) {
        int width = web.getWidth();
        if (width == 0) return;
        probing = true;
        startX = x;
        startY = y;
        velocity = VelocityTracker.obtain();
        int id = ++sequence;
        web.evaluateJavascript("window.app?.beginSplitScroll(" + id + "," + x / width + "," + y / width + ")", result -> {
            if (probing && id == sequence && ("1".equals(result) || "2".equals(result) || "3".equals(result))) {
                axes = Integer.parseInt(result);
            }
        });
    }

    @Override
    public boolean onTouch(View view, MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            finish();
            touching = activity.isInMultiWindowMode() && event.getToolType(0) == MotionEvent.TOOL_TYPE_FINGER;
            if (!touching) return false;
            downX = lastX = event.getX();
            downY = lastY = event.getY();
            if (afterBlur || !topResumed || !web.hasWindowFocus()) begin(lastX, lastY);
            afterBlur = false;
            if (probing) {
                velocity.addMovement(event);
                // Deliver taps as usual but retain the stream even if the unfocused WebView declines DOWN.
                web.onTouchEvent(event);
                return true;
            }
            return false;
        }

        boolean handled = captured;
        if (action == MotionEvent.ACTION_CANCEL || action == MotionEvent.ACTION_UP) {
            if (captured && touching && action == MotionEvent.ACTION_UP) {
                velocity.addMovement(event);
                velocity.computeCurrentVelocity(1000, config.getScaledMaximumFlingVelocity());
                float speed = axis == 1 ? velocity.getXVelocity() : velocity.getYVelocity();
                float glide = Math.abs(speed) >= config.getScaledMinimumFlingVelocity() ? -speed * .12f : 0f;
                move(event, glide);
            }
            finish();
            return handled;
        }
        if (!touching) return handled;
        if (event.getPointerCount() != 1 || !activity.isInMultiWindowMode()) {
            touching = false;
            return handled;
        }
        if (action != MotionEvent.ACTION_MOVE) return handled;
        lastX = event.getX();
        lastY = event.getY();
        if (!startedDragging && Math.max(Math.abs(downX - lastX), Math.abs(downY - lastY)) >= config.getScaledTouchSlop()) {
            // A long press belongs to the WebView unless a drag had already started before focus changed.
            if (event.getEventTime() - event.getDownTime() >= ViewConfiguration.getLongPressTimeout()) {
                touching = false;
                return false;
            }
            startedDragging = true;
        }
        if (!probing) return false;
        velocity.addMovement(event);
        if (!captured) {
            float dx = Math.abs(startX - lastX);
            float dy = Math.abs(startY - lastY);
            if (Math.max(dx, dy) < config.getScaledTouchSlop() || axes == 0) return false;
            axis = dx > dy ? 1 : 2;
            if ((axes & axis) == 0) {
                touching = false;
                return false;
            }
            // From this point the page scrolls the element under DOWN. Cancel any pending tap/long press.
            MotionEvent cancel = MotionEvent.obtain(event);
            cancel.setAction(MotionEvent.ACTION_CANCEL);
            web.onTouchEvent(cancel);
            cancel.recycle();
            captured = true;
        }
        move(event, 0f);
        return true;
    }

    private void move(MotionEvent event, float glide) {
        int width = Math.max(1, web.getWidth());
        float distance = axis == 1 ? startX - event.getX() : startY - event.getY();
        web.evaluateJavascript("window.app?.moveSplitScroll(" + sequence + "," + axis + ","
                + distance / width + "," + glide / width + ")", null);
    }

    void finish() {
        if (probing) web.evaluateJavascript("window.app?.endSplitScroll(" + sequence + ")", null);
        if (velocity != null) velocity.recycle();
        velocity = null;
        touching = probing = captured = startedDragging = false;
        axes = axis = 0;
    }
}
