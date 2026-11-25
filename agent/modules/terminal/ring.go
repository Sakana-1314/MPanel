package terminal

// ringBuffer is a fixed-size byte ring. It keeps the most recent output of a
// session without unbounded growth; the WS bridge only streams live output,
// but the ring is available for diagnostics and future replay.
type ringBuffer struct {
	buf   []byte
	start int
	size  int
}

func newRingBuffer(capacity int) *ringBuffer {
	return &ringBuffer{buf: make([]byte, capacity)}
}

func (r *ringBuffer) Write(p []byte) {
	if len(p) == 0 || len(r.buf) == 0 {
		return
	}
	if len(p) >= len(r.buf) {
		copy(r.buf, p[len(p)-len(r.buf):])
		r.start = 0
		r.size = len(r.buf)
		return
	}
	end := (r.start + r.size) % len(r.buf)
	n := copy(r.buf[end:], p)
	if n < len(p) {
		copy(r.buf, p[n:])
	}
	r.size += len(p)
	if r.size > len(r.buf) {
		overflow := r.size - len(r.buf)
		r.start = (r.start + overflow) % len(r.buf)
		r.size = len(r.buf)
	}
}

func (r *ringBuffer) Bytes() []byte {
	out := make([]byte, r.size)
	n := copy(out, r.buf[r.start:])
	if n < r.size {
		copy(out[n:], r.buf[:r.size-n])
	}
	return out
}
