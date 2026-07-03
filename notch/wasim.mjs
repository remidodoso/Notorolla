// wasim.mjs — a tiny sample-accurate Web Audio simulator for headless metering.
// Implements just what Vesperia + Boshwick voices use: oscillators (sine/tri/
// square), gains with scheduled AudioParams (setValueAtTime / exponential &
// linear ramps / setTargetAtTime), RBJ biquads (lowpass/highpass/bandpass),
// looping buffer sources, and a pull-based DAG render.

export function makeSimCtx(sampleRate = 44100) {
  const TWO_PI = Math.PI * 2;

  function makeParam(v) {
    const p = {
      value: v, _events: [],
      setValueAtTime(val, t) { p._events.push({ type: 'set', v: val, t }); },
      linearRampToValueAtTime(val, t) { p._events.push({ type: 'lin', v: val, t }); },
      exponentialRampToValueAtTime(val, t) { p._events.push({ type: 'exp', v: val, t }); },
      setTargetAtTime(val, t, tau) { p._events.push({ type: 'tgt', v: val, t, tau }); },
      cancelScheduledValues() { p._events.length = 0; },
      _prep() { p._events.sort((a, b) => a.t - b.t); p._i = 0; p._cur = p.value; p._lastT = 0; p._tgt = null; },
      // Value if no further events fired (hold, or an active setTarget curve).
      _valueNow(t) {
        if (p._tgt) return p._tgt.target + (p._tgt.v0 - p._tgt.target) * Math.exp(-(t - p._tgt.t0) / p._tgt.tau);
        return p._cur;
      },
      at(t) {
        // Pass every event that has begun.
        while (p._i < p._events.length && p._events[p._i].t <= t) {
          const e = p._events[p._i++];
          if (e.type === 'set') { p._cur = e.v; p._tgt = null; }
          else if (e.type === 'exp' || e.type === 'lin') { p._cur = e.v; p._tgt = null; } // ramp completed
          else { p._tgt = { target: e.v, t0: e.t, tau: e.tau, v0: p._valueNow(e.t) }; }
          p._lastT = e.t;
        }
        // A pending ramp interpolates from the last passed event toward its end.
        const nxt = p._events[p._i];
        if (nxt && (nxt.type === 'exp' || nxt.type === 'lin') && t < nxt.t) {
          const v0 = p._valueNow(p._lastT); // ramp starts at the previous event's value
          const f = (t - p._lastT) / (nxt.t - p._lastT);
          if (nxt.type === 'lin') return v0 + (nxt.v - v0) * f;
          return v0 > 0 && nxt.v > 0 ? v0 * Math.pow(nxt.v / v0, f) : v0; // exp needs positive endpoints
        }
        return p._valueNow(t);
      },
    };
    return p;
  }

  let stamp = 0;
  function baseNode(pull) {
    return {
      _inputs: [], _stamp: -1, _out: 0,
      connect(dest) { (dest._inputs || (dest._inputs = [])).push(this); },
      disconnect() {},
      _pull(t) {
        if (this._stamp === stamp) return this._out;
        this._stamp = stamp;
        this._out = pull.call(this, t);
        return this._out;
      },
      _sum(t) { let s = 0; for (const n of this._inputs) s += n._pull(t); return s; },
    };
  }

  const ctx = {
    sampleRate, currentTime: 0,
    createGain() {
      const n = baseNode(function (t) { return this._sum(t) * this.gain.at(t); });
      n.gain = makeParam(1);
      return n;
    },
    createOscillator() {
      const n = baseNode(function (t) {
        if (t < this._start || t >= this._stop) return 0;
        const f = this.frequency.at(t) * Math.pow(2, this.detune.at(t) / 1200);
        this._phase += (TWO_PI * f) / sampleRate;
        const ph = this._phase;
        if (this.type === 'square') return Math.sin(ph) >= 0 ? 1 : -1;
        if (this.type === 'triangle') return (2 / Math.PI) * Math.asin(Math.sin(ph));
        return Math.sin(ph);
      });
      n.type = 'sine'; n.frequency = makeParam(0); n.detune = makeParam(0);
      n._phase = 0; n._start = Infinity; n._stop = Infinity;
      n.start = (t) => { n._start = t; };
      n.stop = (t) => { n._stop = t; };
      n.setPeriodicWave = () => {}; // not needed for the metered kinds
      return n;
    },
    createBiquadFilter() {
      const n = baseNode(function (t) {
        const f = Math.max(10, Math.min(sampleRate * 0.49, this.frequency.at(t)));
        const q = Math.max(0.0001, this.Q.at(t));
        if (f !== this._f || q !== this._q || this.type !== this._type) this._coeffs(f, q);
        const x = this._sum(t);
        const y = this._b0 * x + this._b1 * this._x1 + this._b2 * this._x2 - this._a1 * this._y1 - this._a2 * this._y2;
        this._x2 = this._x1; this._x1 = x; this._y2 = this._y1; this._y1 = y;
        return y;
      });
      n.type = 'lowpass'; n.frequency = makeParam(350); n.Q = makeParam(1);
      n._x1 = n._x2 = n._y1 = n._y2 = 0; n._f = -1; n._q = -1; n._type = '';
      n._coeffs = (f, q) => {  // RBJ audio-EQ cookbook
        const w0 = (TWO_PI * f) / sampleRate;
        const cs = Math.cos(w0), sn = Math.sin(w0);
        const alpha = sn / (2 * q);
        let b0, b1, b2, a0, a1, a2;
        if (n.type === 'highpass') {
          b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2;
        } else if (n.type === 'bandpass') {
          b0 = alpha; b1 = 0; b2 = -alpha;   // constant-skirt, peak = Q
        } else { // lowpass
          b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2;
        }
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
        n._b0 = b0 / a0; n._b1 = b1 / a0; n._b2 = b2 / a0; n._a1 = a1 / a0; n._a2 = a2 / a0;
        n._f = f; n._q = q; n._type = n.type;
      };
      return n;
    },
    createWaveShaper() {
      const n = baseNode(function (t) {
        const x = this._sum(t);
        if (!this.curve) return x;
        const c = this.curve;
        const pos = Math.max(0, Math.min(c.length - 1, ((x + 1) / 2) * (c.length - 1)));
        const i = Math.floor(pos), f = pos - i;
        return i + 1 < c.length ? c[i] + (c[i + 1] - c[i]) * f : c[i];
      });
      n.curve = null; n.oversample = 'none';
      return n;
    },
    createBuffer(channels, length, rate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { length, sampleRate: rate, numberOfChannels: channels, getChannelData: (c) => data[c] };
    },
    createBufferSource() {
      const n = baseNode(function (t) {
        if (t < this._start || t >= this._stop || !this.buffer) return 0;
        const d = this.buffer.getChannelData(0);
        const i = this._idx++;
        return this.loop ? d[i % d.length] : (i < d.length ? d[i] : 0);
      });
      n.buffer = null; n.loop = false; n._idx = 0; n._start = Infinity; n._stop = Infinity;
      n.start = (t) => { n._start = t; };
      n.stop = (t) => { n._stop = t; };
      return n;
    },
    // Collect every param reachable from `node` so render can _prep them.
    _allParams(node, seen = new Set(), out = []) {
      if (!node || seen.has(node)) return out;
      seen.add(node);
      for (const k of ['gain', 'frequency', 'detune', 'Q']) if (node[k] && node[k]._events) out.push(node[k]);
      for (const inp of node._inputs || []) this._allParams(inp, seen, out);
      return out;
    },
    // Render `seconds` of the graph feeding `sink`; returns Float32Array.
    render(sink, seconds) {
      const nFrames = Math.floor(seconds * sampleRate);
      for (const p of this._allParams(sink)) p._prep();
      const out = new Float32Array(nFrames);
      for (let i = 0; i < nFrames; i++) {
        stamp++;
        out[i] = sink._pull(i / sampleRate);
      }
      return out;
    },
  };
  return ctx;
}

// Peak (abs) and RMS of a rendered buffer, plus dBFS forms.
export function meter(buf) {
  let peak = 0, sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
    sum += buf[i] * buf[i];
  }
  const rms = Math.sqrt(sum / buf.length);
  const dB = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf');
  return { peak, rms, peakDb: dB(peak), rmsDb: dB(rms) };
}
