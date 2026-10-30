// A small Web Audio synth for the machine: the clack of a key, a soft tone as
// the lamp lights, and the ratchet of a rotor turned by hand. Browsers only
// allow audio after a click or key press, which is exactly when these play.
(function (root) {
  'use strict';

  const PENTATONIC = [0, 2, 4, 7, 9];
  let context = null;
  let master = null;
  let noise = null;
  let enabled = true;

  function audio() {
    if (!enabled) return null;
    if (!context) {
      const Context = root.AudioContext || root.webkitAudioContext;
      if (!Context) return null;
      context = new Context();
      master = context.createGain();
      master.gain.value = 0.5;
      master.connect(context.destination);
    }
    if (context.state === 'suspended') context.resume();
    return context;
  }

  function noiseBuffer() {
    if (!noise) {
      noise = context.createBuffer(1, Math.floor(context.sampleRate * 0.1), context.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return noise;
  }

  // A gain that rises to `peak` almost at once and dies away over `decay` seconds.
  function envelope(at, peak, decay) {
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.003 + decay);
    gain.connect(master);
    return gain;
  }

  function burst(at, frequency, q, peak, decay) {
    const source = context.createBufferSource();
    source.buffer = noiseBuffer();
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = q;
    source.connect(filter);
    filter.connect(envelope(at, peak, decay));
    source.start(at);
    source.stop(at + decay + 0.02);
  }

  function tone(at, type, from, to, peak, decay) {
    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, at);
    oscillator.frequency.exponentialRampToValueAtTime(to, at + decay);
    oscillator.connect(envelope(at, peak, decay));
    oscillator.start(at);
    oscillator.stop(at + decay + 0.02);
  }

  // The key going down: a dry clack with a little body under it.
  function key(volume = 1) {
    if (!audio()) return;
    const at = context.currentTime;
    burst(at, 2300, 0.9, 0.5 * volume, 0.035);
    tone(at, 'sine', 170, 55, 0.35 * volume, 0.07);
  }

  // The lamp lighting: a short warm tone, pitched by its letter.
  function lamp(letter, soft = false) {
    if (!audio()) return;
    const step = Math.max(0, letter.charCodeAt(0) - 65) % 10;
    const semitones = PENTATONIC[step % 5] + 12 * Math.floor(step / 5);
    const frequency = 523.25 * 2 ** (semitones / 12);
    tone(context.currentTime + 0.015, 'triangle', frequency, frequency, soft ? 0.03 : 0.07, soft ? 0.08 : 0.25);
  }

  // A rotor clicking round one notch by hand.
  function ratchet() {
    if (!audio()) return;
    burst(context.currentTime, 4200, 1.5, 0.3, 0.02);
  }

  root.VibeSound = {
    key,
    lamp,
    ratchet,
    get enabled() {
      return enabled;
    },
    set enabled(value) {
      enabled = Boolean(value);
    },
  };
})(window);
