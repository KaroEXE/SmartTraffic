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
