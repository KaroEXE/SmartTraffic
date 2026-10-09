"""MJPEG framing only: no model, capture, or image encoder in HTTP handlers."""


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
    finishes, including responses that were never iterated, so the slot taken
    with SharedState.acquire_stream() is always released exactly once.
    """

    def __init__(self, shared, index):
        self._shared = shared
        self._frames = stream_frames(shared, index)
        self._open = True

    def __iter__(self):
        return self

    def __next__(self):
        try:
            return next(self._frames)
        except BaseException:
            self.close()
            raise

    def close(self):
        if self._open:
            self._open = False
            self._frames.close()
            self._shared.release_stream()
