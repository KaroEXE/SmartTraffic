"""MJPEG framing only: no model, capture, or image encoder in HTTP handlers."""

import weakref


def stream_frames(shared, index):
    sequence = 0
    while True:
        item = shared.wait_frame(index, sequence)
        if item is None:
            if not shared.frame_available(index):
                return
            continue
        sequence, jpeg = item
        yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
               + str(len(jpeg)).encode("ascii") + b"\r\n\r\n" + jpeg + b"\r\n")


class MJPEGStream:
    """Response iterable that holds one viewer slot until it ends or is closed.

    WSGI servers call close() when the client disconnects or the response
    finishes, including responses that were never iterated. Werkzeug's
    development server (main.py) does not: when a viewer disconnects
    mid-stream it raises while draining the socket and never reaches close().
    So the slot (lease) taken with SharedState.acquire_stream() is released
    by close(), or when the object is garbage-collected, or - deterministic
    backstop - reclaimed by SharedState once this stream stops pulling frames
    (every pulled frame renews the lease). Without this, every closed browser
    tab kept a slot until MAX_STREAM_CLIENTS was reached and all video
    requests got 503.
    """

    def __init__(self, shared, index, lease):
        self._shared = shared
        self._lease = lease
        self._frames = stream_frames(shared, index)
        self._open = True
        self._release = weakref.finalize(self, shared.release_stream, lease)

    def __iter__(self):
        return self

    def __next__(self):
        try:
            part = next(self._frames)
        except BaseException:
            self.close()
            raise
        self._shared.touch_stream(self._lease)
        return part

    def close(self):
        if self._open:
            self._open = False
            self._frames.close()
        self._release()  # weakref.finalize runs at most once
