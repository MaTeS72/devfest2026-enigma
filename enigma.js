// Enigma I engine. The machine is built from the JSON that GET /api/enigma
// returns, so the wiring, notches, rings and plugboard all come from the API.
(function (root) {
  'use strict';

  function createMachine(spec) {
    const alphabet = spec.alphabet || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const n = alphabet.length;
    const index = (ch) => alphabet.indexOf(ch);
    const mod = (x) => ((x % n) + n) % n;

    if (!spec.rotors || spec.rotors.length !== 3) {
      throw new Error('Enigma I takes exactly three rotors');
    }

    // The rotors the API lists. `rotors` is the order they sit in, left to right.
    const catalogue = spec.rotors.map((r) => {
      const forward = Array.from(r.wiring, index);
      const backward = new Array(n);
      forward.forEach((out, i) => { backward[out] = i; });
      return { name: r.name, notches: Array.from(r.notch, index), forward, backward };
    });
    const reflector = Array.from(spec.reflector.wiring, index);

    let rotors = catalogue.slice();
    let rings = [0, 0, 0];
    let positions = [0, 0, 0];
    let plugboard = identity();

    function identity() {
      return Array.from({ length: n }, (_, i) => i);
    }

    function lettersToIndices(value, label) {
      const letters = String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
      if (letters.length !== 3) throw new Error(`${label} needs three letters`);
      return Array.from(letters, index);
    }

    // Accepts ["II", "I", "III"] or "II I III". Each rotor sits in one slot only.
    function setRotorOrder(names) {
      const list = Array.isArray(names) ? names : String(names || '').trim().split(/[\s,]+/);
      if (list.length !== 3) throw new Error('Pick three rotors, left to right');
      const picked = list.map((name) => {
        const rotor = catalogue.find((r) => r.name === name);
        if (!rotor) throw new Error(`There is no rotor ${name}`);
        return rotor;
      });
      if (new Set(picked).size !== 3) throw new Error('Each rotor can only sit in one slot');
      rotors = picked;
    }

    function setRings(value) {
      rings = lettersToIndices(value, 'Ring setting');
    }

    function setPositions(value) {
      positions = lettersToIndices(value, 'Start position');
    }

    // Accepts ["DE", "VF"] or "DE VF". A letter may sit in one pair only.
    function setPlugboard(pairs) {
      const list = Array.isArray(pairs) ? pairs : String(pairs || '').trim().split(/[\s,]+/);
      const next = identity();
      const used = new Set();
      for (const raw of list) {
        if (!raw) continue;
        const pair = raw.toUpperCase();
        if (!/^[A-Z]{2}$/.test(pair) || pair[0] === pair[1]) {
          throw new Error(`"${raw}" is not a plug pair`);
        }
        for (const ch of pair) {
          if (used.has(ch)) throw new Error(`${ch} is plugged twice`);
          used.add(ch);
        }
        const a = index(pair[0]);
        const b = index(pair[1]);
        next[a] = b;
        next[b] = a;
      }
      plugboard = next;
    }

    function getPositions() {
      return positions.map((p) => alphabet[p]).join('');
    }

    function getPlugboardPairs() {
      const pairs = [];
      plugboard.forEach((to, from) => {
        if (to > from) pairs.push(alphabet[from] + alphabet[to]);
      });
      return pairs;
    }

    // Right rotor always steps. A right rotor leaving its notch carries the
    // middle one; a middle rotor sitting on its notch steps itself and the left
    // one (the double step), so the middle never moves twice in one keypress.
    function step() {
      const middleOnNotch = rotors[1].notches.includes(positions[1]);
      const rightOnNotch = rotors[2].notches.includes(positions[2]);
      if (middleOnNotch) {
        positions[0] = mod(positions[0] + 1);
        positions[1] = mod(positions[1] + 1);
      } else if (rightOnNotch) {
        positions[1] = mod(positions[1] + 1);
      }
      positions[2] = mod(positions[2] + 1);
    }

    function through(slot, signal, wiring) {
      const shift = positions[slot] - rings[slot];
      return mod(rotors[slot][wiring][mod(signal + shift)] - shift);
    }

    // Steps the rotors, then sends one letter through the machine. `path`
    // holds the signal after each stage, for drawing the wiring.
    function press(letter) {
      step();
      const path = [index(letter)];
      let signal = plugboard[path[0]];
      path.push(signal);
      for (let slot = 2; slot >= 0; slot--) {
        signal = through(slot, signal, 'forward');
        path.push(signal);
      }
      signal = reflector[signal];
      path.push(signal);
      for (let slot = 0; slot <= 2; slot++) {
        signal = through(slot, signal, 'backward');
        path.push(signal);
      }
      signal = plugboard[signal];
      path.push(signal);
      return { input: letter, output: alphabet[signal], path: path.map((i) => alphabet[i]) };
    }

    // Only A to Z go through the machine; everything else passes unchanged
    // and leaves the rotors where they are.
    function isLetter(ch) {
      return ch.length === 1 && index(ch.toUpperCase()) !== -1 && /[a-z]/i.test(ch);
    }

    function run(text, start) {
      if (start) setPositions(start);
      let out = '';
      for (const ch of String(text)) {
        out += isLetter(ch) ? press(ch.toUpperCase()).output : ch;
      }
      return out;
    }

    setRings(spec.rings || 'AAA');
    setPlugboard(spec.plugboard || []);

    return {
      alphabet,
      availableRotors: catalogue.map((r) => r.name),
      reflectorName: spec.reflector.name,
      get rotorNames() {
        return rotors.map((r) => r.name);
      },
      get notches() {
        return rotors.map((r) => r.notches.map((i) => alphabet[i]).join(''));
      },
      setRotorOrder,
      setRings,
      getRings: () => rings.map((r) => alphabet[r]).join(''),
      setPositions,
      getPositions,
      setPlugboard,
      getPlugboardPairs,
      isLetter,
      press,
      run,
    };
  }

  const api = { createMachine };
  root.Enigma = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
